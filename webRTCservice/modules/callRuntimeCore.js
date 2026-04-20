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
    notifyAndBridge,
    notifyAndBridgeMulti,
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
            audioT.sender.registerTrack(localTrack);
            logger.log(`[${sessionId}] Created & registered localAudioTrack`);
        }
        audioT.setDirection("sendrecv");
        audioT.offerDirection = "sendrecv";
        return audioT;
    }

    async function createAnswerSdp(pc, sessionId, label) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        let answerSdp = answer.sdp;
        const before = answerSdp;
        answerSdp = patchInactiveToSendrecv(answerSdp);
        if (answerSdp !== before) {
            logger.log(`[${sessionId}] Patched ${label}: inactive → sendrecv`);
        }
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
            const sipFrom = callerIdResult?.callerId || session.callerEns;
            const sipTo = destination?.number;
            const sipDirective = {
                target: destination?.target || null,
                identity: callerIdResult?.identity || null,
                privacy: callerIdResult?.privacy || null,
                headers: {
                    ...(callerIdResult?.headers || {}),
                    "X-Arnacon-Service-Id": session?.serviceId || "",
                    "X-Arnacon-Session-Id": sessionId,
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
            await openSipSession(sessionId, sipFrom, sipTo, sipDirective);
            return "sbc";
        }
        if (destination.route === "webrtc") {
            await notifyAndBridge(sessionId, destination);
            return "webrtc";
        }
        if (destination.route === "webrtc-multiring") {
            await notifyAndBridgeMulti(sessionId, destination.targets || []);
            return "webrtc-multiring";
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
