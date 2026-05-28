"use strict";

function createCallRuntimeCore({
    sessions,
    MediaStreamTrack,
    patchInactiveToSendrecv,
    logSdp,
    enqueueSignaling,
    sendDataChannelMessage,
    resolveCallerId,
    openSipSession,
    openOpenAiSipSession,
    notifyAndBridge,
    notifyAndBridgeMulti,
    startIvrSession,
    minuteCounter = null,
    getMinuteCounterSettings = null,
    getMinuteCounterIdentity = null,
    logger = console,
}) {
    function failCall(sessionId, err, context) {
        logger.error(`[${sessionId}] ${context}: ${err.message}`);
        sendDataChannelMessage(sessionId, { msgType: "call", action: "end" });
        const s = sessions.get(sessionId);
        if (s) s.phase = "post-call";
    }

    function ensureLocalAudioTrack(session, pc, sessionId) {
        const audioT = pc.getTransceivers().find((t) => t.kind === "audio");
        if (!audioT) return null;
        if (!session.localAudioTrack) {
            const localTrack = new MediaStreamTrack({ kind: "audio" });
            session.localAudioTrack = localTrack;
            logger.log(`[${sessionId}] Created & registered localAudioTrack`);
        } else {
            logger.log(`[${sessionId}] Reusing localAudioTrack on existing audio transceiver`);
        }
        if (audioT.sender && typeof audioT.sender.registerTrack === "function") {
            audioT.sender.registerTrack(session.localAudioTrack);
        }
        audioT.setDirection("sendrecv");
        audioT.offerDirection = "sendrecv";
        return audioT;
    }

    async function createAnswerSdp(pc, sessionId, label) {
        const answer = await pc.createAnswer();
        let answerSdp = answer.sdp;
        const before = answerSdp;
        answerSdp = patchInactiveToSendrecv(answerSdp);
        if (answerSdp !== before) {
            logger.log(`[${sessionId}] Patched ${label}: inactive → sendrecv`);
            answer.sdp = answerSdp;
        }
        await pc.setLocalDescription(answer);
        const dir = answerSdp.match(/a=(sendrecv|recvonly|sendonly|inactive)/)?.[1] || "unknown";
        logger.log(`[${sessionId}] ${label} created (len=${answerSdp.length}, dir=${dir})`);
        logSdp(sessionId, label, answerSdp);
        return answerSdp;
    }

    function sendSignalingOffer(sessionId, sdp) {
        const s = sessions.get(sessionId);
        if (!s) return;
        sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            payload: {
                type: "offer",
                from: s.toIdentity,
                to: s.callerEns,
                sessionId,
                sdp,
            },
        });
    }

    function schedulePhase2Reoffer(sessionId, pendingReoffer) {
        setTimeout(() => {
            enqueueSignaling(sessionId, "phase2-reoffer", async () => {
                const s = sessions.get(sessionId);
                if (!s || !s.peerConnection || s.phase !== "in-call") return;
                const pc = s.peerConnection;
                const at = pc.getTransceivers().find((t) => t.kind === "audio");
                if (at) {
                    at.setDirection("sendrecv");
                    at.offerDirection = "sendrecv";
                }
                const serverOffer = await pc.createOffer();
                await pc.setLocalDescription(serverOffer);
                logSdp(sessionId, "PHASE 2 RE-OFFER SDP", serverOffer.sdp);
                sendSignalingOffer(sessionId, serverOffer.sdp);
                s.pendingReoffer = pendingReoffer;
            });
        }, 1000);
    }

    async function routeCall(sessionId, session, destination, parsedFrom) {
        if (destination.route === "sbc") {
            const callerIdResult = await resolveCallerId(parsedFrom, session.walletAddress, session.serviceId || null);
            if (callerIdResult?.privateId && !callerIdResult?.callerId && !callerIdResult?.identity?.fromUri) {
                throw new Error("SBC privacy policy requires a masked caller ID, but none was available");
            }
            const sipFrom = callerIdResult?.callerId || session.callerEns;
            const sipTo = destination?.number;
            const sipDirective = {
                target: destination?.target || null,
                identity: callerIdResult?.identity || null,
                privacy: callerIdResult?.privacy || null,
                headers: {
                    ...(callerIdResult?.headers || {}),
                    "X-Arnacon-Service-Id": session?.serviceId || "",
                },
                trace: {
                    serviceId: session?.serviceId || "",
                    sessionId,
                    callId: session?.callId || "",
                },
                // Backward-compatible fallback fields from current services.
                callerId: callerIdResult?.callerId || null,
                privateId: callerIdResult?.privateId || null,
            };
            const minuteCounterSettings = typeof getMinuteCounterSettings === "function"
                ? getMinuteCounterSettings(session.serviceId || null)
                : null;
            const minuteCounterIdentity = typeof getMinuteCounterIdentity === "function"
                ? getMinuteCounterIdentity(parsedFrom, session)
                : (parsedFrom?.full || session.callerEns || "");
            if (minuteCounter && minuteCounterSettings?.limitSeconds) {
                minuteCounter.assertCanStart({
                    serviceId: minuteCounterSettings.serviceId,
                    identity: minuteCounterIdentity,
                    limitSeconds: minuteCounterSettings.limitSeconds,
                });
            }
            await openSipSession(sessionId, sipFrom, sipTo, sipDirective);
            if (minuteCounter && minuteCounterSettings?.limitSeconds) {
                minuteCounter.start(session, {
                    serviceId: minuteCounterSettings.serviceId,
                    identity: minuteCounterIdentity,
                    limitSeconds: minuteCounterSettings.limitSeconds,
                });
            }
            return "sbc";
        }
        if (destination.route === "openai-sip") {
            if (typeof openOpenAiSipSession !== "function") {
                throw new Error("OpenAI SIP route requested but gateway is unavailable");
            }
            const callerIdResult = await resolveCallerId(parsedFrom, session.walletAddress, session.serviceId || null);
            await openOpenAiSipSession(sessionId, {
                callerEns: callerIdResult?.callerId || session.callerEns,
                callerId: callerIdResult?.callerId || null,
                destination,
            });
            return "openai-sip";
        }
        if (destination.route === "webrtc") {
            await notifyAndBridge(sessionId, destination);
            return "webrtc";
        }
        if (destination.route === "webrtc-multiring") {
            await notifyAndBridgeMulti(sessionId, destination.targets || []);
            return "webrtc-multiring";
        }
        if (destination.route === "ivr") {
            // Start IVR only after final answer is sent to the caller.
            // Starting it here can play RTP before the caller applies remote answer.
            if (typeof startIvrSession !== "function") {
                throw new Error("IVR route requested but startIvrSession is unavailable");
            }
            return "ivr";
        }
    }

    return {
        failCall,
        ensureLocalAudioTrack,
        createAnswerSdp,
        sendSignalingOffer,
        schedulePhase2Reoffer,
        routeCall,
    };
}

module.exports = {
    createCallRuntimeCore,
};
