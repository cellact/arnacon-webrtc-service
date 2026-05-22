"use strict";

function createCallFlowApi({
    sessions,
    pendingInboundCalls,
    parseAddress,
    resolveDestination,
    routeCall,
    openInboundSipSession,
    startMediaRelay,
    stopMediaRelay,
    closeSipSession,
    sendDataChannelMessage,
    sendAck,
    sendAnswer,
    sendAckAndAnswer,
    failCall,
    ensureLocalAudioTrack,
    createAnswerSdp,
    schedulePhase2Reoffer,
    logSdp,
    patchInactiveToSendrecv,
    waitForIceGathering,
    formatIceCandidates,
    getRelayCandidates,
    embedCandidatesInSdp,
    MediaStreamTrack,
    RTCSessionDescription,
    enqueueSignaling,
    startPendingMultiBridge = null,
    shouldStartIvrForSession = null,
    startIvrForSession = null,
    finishMinuteCounter = null,
    logger = console,
}) {
    function onDataChannelOpen(sessionId, deps = {}) {
        const { checkPendingBridge, checkPendingInboundCall, sendInboundRing, destroySession } = deps;
        const session = sessions.get(sessionId);
        if (!session) return;
        session.phase = "connected";
        if (session.isGatewayCaller && session.inboundCall) {
            if (session.inboundRingSent) return;
            session.inboundRingSent = true;
            sendDataChannelMessage(sessionId, { msgType: "call", action: "ack", ackFor: "answer" });
            sendInboundRing(sessionId).catch((err) => {
                session.inboundRingSent = false;
                logger.error(`[${sessionId}] Failed to send inbound RING: ${err.message}`);
                destroySession(sessionId, false);
            });
            return;
        }
        if (session.isGatewayCaller && session.outboundWebrtcLeg) {
            triggerOutboundWebrtcLegRing(sessionId, destroySession).catch((err) => {
                logger.error(`[${sessionId}] Failed to send outbound WebRTC leg RING on DC open: ${err.message}`);
            });
        }
        if (session.walletAddress) {
            checkPendingBridge(sessionId, session.walletAddress);
            checkPendingInboundCall(sessionId, session.walletAddress);
        }
    }

    async function triggerOutboundWebrtcLegRing(sessionId, destroySession = null) {
        const session = sessions.get(sessionId);
        if (!session || !session.outboundWebrtcLeg) return false;
        if (!session.outboundLegHttpAnswered) return false;
        if (session.outboundLegRingSent) return true;
        if (!session.dataChannel) return false;
        session.outboundLegRingSent = true;
        try {
            await sendInboundRing(sessionId);
            logger.log(`[${sessionId}] outbound WebRTC stage1->stage2: RING offer sent over data channel`);
            return true;
        } catch (err) {
            session.outboundLegRingSent = false;
            if (typeof destroySession === "function") {
                try { destroySession(sessionId, false); } catch (_) {}
            }
            throw err;
        }
    }

    async function sendInboundRing(sessionId) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session not found");
        const pc = session.peerConnection;
        if (!session.localAudioTrack) {
            const localTrack = new MediaStreamTrack({ kind: "audio" });
            session.localAudioTrack = localTrack;
            pc.addTrack(localTrack);
        } else {
            const audioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (audioT) audioT.setDirection("sendrecv");
        }
        session.iceCandidates = [];
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        const gatheredCandidates = formatIceCandidates(session).filter(c => !c.candidate.toLowerCase().includes(" tcp "));
        const srflxAndRelay = gatheredCandidates.filter(c => c.candidate.includes("typ srflx") || c.candidate.includes("typ relay"));
        const candidatesToEmbed = srflxAndRelay.length > 0 ? srflxAndRelay : gatheredCandidates;
        const relayCandidates = getRelayCandidates(gatheredCandidates);
        let baseOfferSdp = offer.sdp;
        if (session.mediaCodecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(baseOfferSdp, session.mediaCodecPolicy);
            if (narrowedOfferSdp !== baseOfferSdp) {
                logger.log(`[${sessionId}] outbound WebRTC leg: narrowed RING offer codecPolicy=${session.mediaCodecPolicy}`);
                baseOfferSdp = narrowedOfferSdp;
            }
        }
        const offerSdp = embedCandidatesInSdp(baseOfferSdp, candidatesToEmbed);
        logSdp(sessionId, "RING OFFER SDP (to callee)", offerSdp);
        sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            payload: {
                type: "offer",
                from: session.callerEns,
                to: session.toIdentity,
                sessionId,
                sdp: offerSdp,
                candidates: relayCandidates,
            },
        });
        if (session.calleeWallet) {
            const pending = pendingInboundCalls.get(session.calleeWallet);
            if (pending) {
                clearTimeout(pending.timer);
                pendingInboundCalls.delete(session.calleeWallet);
            }
        }
    }

    async function handleInboundCalleeAnswer(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        const pc = session.peerConnection;
        session.callEndInProgress = false;
        session.phase = "in-call";
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp, "answer"));
        sendDataChannelMessage(sessionId, { msgType: "call", action: "ack", ackFor: "answer" });
        const shouldStartIvr =
            typeof shouldStartIvrForSession === "function" &&
            shouldStartIvrForSession(session, session?.inboundCall?.toNumber) &&
            typeof startIvrForSession === "function";
        try {
            await openInboundSipSession(sessionId, session.inboundCall.toNumber);
            if (shouldStartIvr) {
                await startIvrForSession(sessionId, {
                    route: "ivr",
                    source: "inbound-answer",
                    target: session?.inboundCall?.toNumber || "",
                });
            }
        } catch (err) {
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end" });
            session.phase = "post-call";
        }
    }

    async function handleOutboundWebrtcLegAnswer(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        const pc = session.peerConnection;
        session.callEndInProgress = false;
        session.phase = "in-call";
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp, "answer"));
        sendDataChannelMessage(sessionId, { msgType: "call", action: "ack", ackFor: "answer" });
        logger.log(`[${sessionId}] outbound WebRTC stage2: pickup answer received over data channel`);
    }

    function narrowAudioOfferToPayloads(sdp, allowedPayloads) {
        if (!sdp || !sdp.includes("m=audio")) return sdp;
        const allowedPayloadSet = new Set((allowedPayloads || []).map(String));
        if (allowedPayloadSet.size === 0) return sdp;
        const sections = sdp.split(/\r\n(?=m=)/);
        return sections.map((section) => {
            if (!section.startsWith("m=audio")) return section;
            const lines = section.split(/\r\n/);
            const mLine = lines[0].split(" ");
            const payloads = mLine.slice(3).filter((pt) => allowedPayloadSet.has(pt));
            if (!payloads.length) return section;

            const allowed = new Set(payloads);
            const filtered = lines.filter((line, index) => {
                if (index === 0) return true;
                const payloadMatch = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:\s|$)/);
                return !payloadMatch || allowed.has(payloadMatch[1]);
            });
            filtered[0] = [...mLine.slice(0, 3), ...payloads].join(" ");
            return filtered.join("\r\n");
        }).join("\r\n");
    }

    function narrowAudioOfferToG711(sdp) {
        return narrowAudioOfferToPayloads(sdp, ["0", "8"]);
    }

    function narrowAudioOfferToPcma(sdp) {
        return narrowAudioOfferToPayloads(sdp, ["8"]);
    }

    function narrowAudioOfferToPcmu(sdp) {
        return narrowAudioOfferToPayloads(sdp, ["0"]);
    }

    function narrowAudioOfferForCodecPolicy(sdp, codecPolicy) {
        if (codecPolicy === "pcma") return narrowAudioOfferToPcma(sdp);
        if (codecPolicy === "pcmu") return narrowAudioOfferToPcmu(sdp);
        if (codecPolicy === "g711") return narrowAudioOfferToG711(sdp);
        return sdp;
    }

    function getPrimaryAudioPayload(sdp) {
        const audioSection = String(sdp || "").match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
        const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
        return mLine.split(/\s+/).slice(3)[0] || null;
    }

    function exactG711PolicyFromAnswer(answerSdp) {
        const primaryPt = getPrimaryAudioPayload(answerSdp);
        if (primaryPt === "0") return "pcmu";
        if (primaryPt === "8") return "pcma";
        return null;
    }

    function routeCodecPolicy(destination, isInbound) {
        if (isInbound) return false;
        if (destination?.route === "sbc") return "pcma";
        if (destination?.route === "openai-sip") return "pcma";
        if (destination?.route === "ivr") return "g711";
        return null;
    }

    function storeIvrNegotiatedAudio(session, sessionId, answerSdp) {
        session.ivrLastAnswerSdp = answerSdp;
        const ssrcMatch = answerSdp.match(/a=ssrc:(\d+)/);
        if (!ssrcMatch) return;
        const parsedSsrc = Number(ssrcMatch[1]);
        if (!Number.isFinite(parsedSsrc) || parsedSsrc <= 0) return;

        session.ivrNegotiatedSsrc = parsedSsrc >>> 0;
        if (session.localAudioTrack) {
            try {
                session.localAudioTrack.ssrc = session.ivrNegotiatedSsrc;
            } catch (_) {}
        }
        logger.log(`[${sessionId}] IVR negotiated audio SSRC=${session.ivrNegotiatedSsrc}`);
    }

    async function handleRing(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        if (session.phase === "post-call") {
            session.linkedSessionId = null;
            session.bridgedWith = null;
            session.mediaRelayActive = false;
            session.pendingReoffer = null;
            session.endCallRenegDone = true;
            session.ivrLastAnswerSdp = null;
            session.ivrNegotiatedSsrc = null;
            session.ivr = null;
            session.mediaCodecPolicy = null;
            if (Array.isArray(session._bridgeDisposers)) {
                for (const dispose of session._bridgeDisposers) {
                    try { dispose(); } catch (_) {}
                }
                session._bridgeDisposers = [];
            }
            logger.log(`[${sessionId}] Reusing post-call session for new ring`);
        }
        // Keep latest caller ring-offer so multi-ring can fan out with client-compatible offer payload.
        session.lastRingOfferPayload = payload;
        const pc = session.peerConnection;
        const isInbound = !!session.inboundCall;
        const rawDir = payload.sdp.match(/m=audio[\s\S]*?a=(sendrecv|recvonly|sendonly|inactive)/m)?.[1] || "no-audio-dir";
        const isInactive = rawDir === "inactive";
        logSdp(sessionId, "CLIENT OFFER SDP (raw)", payload.sdp);

        let destination;
        let parsedFrom;
        let parsedTo;
        const serviceId = session.serviceId || null;
        if (!isInbound) {
            parsedTo = parseAddress(payload.to || session.toIdentity, serviceId);
            parsedFrom = parseAddress(session.callerEns, serviceId);
            destination = await resolveDestination(parsedTo, parsedFrom, serviceId);
            if (destination.route === "reject") {
                sendDataChannelMessage(sessionId, { msgType: "call", action: "end" });
                return;
            }
        }

        session.callEndInProgress = false;
        // Keep outbound calls in ringing state until a route winner exists and
        // we send the final answer to the caller.
        session.phase = isInbound ? "in-call" : "ringing";
        if (!(isInbound && isInactive)) {
            const existingAudioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (existingAudioT) existingAudioT.setDirection("sendrecv");
        }

        let offerSdp = payload.sdp;
        if (isInactive) offerSdp = patchInactiveToSendrecv(offerSdp);
        const codecPolicy = routeCodecPolicy(destination, isInbound);
        if (codecPolicy) {
            const narrowedOfferSdp = codecPolicy === "pcma"
                ? narrowAudioOfferToPcma(offerSdp)
                : narrowAudioOfferToG711(offerSdp);
            if (narrowedOfferSdp !== offerSdp) {
                const label = codecPolicy === "pcma" ? "PCMA" : "PCMU/PCMA";
                logger.log(`[${sessionId}] ${destination.route} route: narrowed caller audio offer to ${label}`);
                offerSdp = narrowedOfferSdp;
            }
            session.mediaCodecPolicy = codecPolicy;
        } else {
            session.mediaCodecPolicy = null;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp, "offer"));

        ensureLocalAudioTrack(session, pc, sessionId);
        const answerLabel = isInactive ? "PHASE 1 ANSWER SDP" : "ANSWER SDP";
        const answerSdp = await createAnswerSdp(pc, sessionId, answerLabel);
        if (!isInbound && destination?.route === "ivr") {
            const exactPolicy = exactG711PolicyFromAnswer(answerSdp);
            if (exactPolicy) {
                session.mediaCodecPolicy = exactPolicy;
                logger.log(`[${sessionId}] IVR bridge codec policy resolved to ${exactPolicy}`);
            }
            storeIvrNegotiatedAudio(session, sessionId, answerSdp);
        }

        if (!isInbound) sendAck(sessionId);
        let routeResult = null;
        try {
            if (isInbound) await openInboundSipSession(sessionId, session.inboundCall.toNumber);
            else routeResult = await routeCall(sessionId, session, destination, parsedFrom);
        } catch (err) {
            failCall(sessionId, err, isInbound ? "Inbound SIP session failed" : "Call routing failed");
            return;
        }

        session.phase = "in-call";
        if (isInbound) sendAckAndAnswer(sessionId, answerSdp);
        else sendAnswer(sessionId, answerSdp);
        if (
            !isInbound &&
            routeResult === "ivr" &&
            typeof startIvrForSession === "function"
        ) {
            if (session.phase !== "in-call") {
                logger.warn(`[${sessionId}] IVR start delayed: phase=${session.phase} expected=in-call`);
                session.phase = "in-call";
            }
            const started = await startIvrForSession(sessionId, {
                route: "ivr",
                source: "outbound-route",
                target: destination?.target || "",
                waitingAudioFile: destination?.waitingAudioFile || null,
            });
            if (!started) {
                failCall(sessionId, new Error("IVR route requested but session did not enter IVR mode"), "IVR startup failed");
                return;
            }
        }
        if (!isInbound && destination.route === "webrtc-multiring" && typeof startPendingMultiBridge === "function") {
            startPendingMultiBridge(sessionId);
        }

        if (!isInbound && destination.route === "sbc") startMediaRelay(sessionId);
        if (isInactive) {
            const pendingReoffer = isInbound
                ? { destination: { route: "sbc-inbound", toNumber: session.inboundCall.toNumber }, parsedFrom: null, parsedTo: null }
                : { destination, parsedFrom, parsedTo };
            schedulePhase2Reoffer(sessionId, pendingReoffer);
            return;
        }
        if (!isInbound && session.endCallRenegDone === false) {
            schedulePhase2Reoffer(sessionId, { destination, parsedFrom, parsedTo });
        }
    }

    async function handleReofferAnswer(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection || !session.pendingReoffer) return;
        const pc = session.peerConnection;
        session.pendingReoffer = null;
        logSdp(sessionId, "RE-OFFER ANSWER SDP (from client)", payload.sdp);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp, "answer"));
    }

    async function handleCallEnd(sessionId, reason = "client-initiated", propagate = true) {
        const session = sessions.get(sessionId);
        if (!session) return;
        if (session.callEndInProgress) return;
        session.callEndInProgress = true;
        session.phase = "post-call";
        session.endCallRenegDone = false;

        if (propagate && session.linkedSessionId) {
            const peerId = session.linkedSessionId;
            const peer = sessions.get(peerId);
            if (peer && !peer.callEndInProgress && peer.phase !== "post-call") {
                sendDataChannelMessage(peerId, { msgType: "call", action: "end" });
                enqueueSignaling(peerId, "linked-call-end", () =>
                    handleCallEnd(peerId, `linked-peer-end:${sessionId}`, false),
                );
            }
        }

        stopMediaRelay(sessionId);
        if (typeof finishMinuteCounter === "function") finishMinuteCounter(session);
        await closeSipSession(sessionId);
        logger.log(`[${sessionId}] SIP torn down — awaiting end-call renegotiation from client (${reason})`);
    }

    async function handleEndCallRenegotiation(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) return;
        const pc = session.peerConnection;
        logSdp(sessionId, "END-CALL OFFER SDP (from client)", payload.sdp);
        if (typeof finishMinuteCounter === "function") finishMinuteCounter(session);
        await closeSipSession(sessionId);
        stopMediaRelay(sessionId);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp, "offer"));
        for (const t of pc.getTransceivers()) {
            if (t.kind === "audio") {
                t.setDirection("inactive");
                break;
            }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        let answerSdp = answer.sdp;
        const audioMidMatch = answerSdp.match(/m=audio[\s\S]*?a=mid:(\S+)/);
        if (audioMidMatch) {
            const audioMid = audioMidMatch[1];
            const bundleMatch = answerSdp.match(/^(a=group:BUNDLE\s+.+)$/m);
            if (bundleMatch && !bundleMatch[1].includes(` ${audioMid}`)) {
                answerSdp = answerSdp.replace(/^(a=group:BUNDLE\s+.+)$/m, `$1 ${audioMid}`);
            }
        }
        if (/^m=audio\s+0\s+/m.test(answerSdp)) {
            answerSdp = answerSdp.replace(/^(m=audio\s+)0(\s+)/m, "$19$2");
        }

        session.sipLocalAudioTrack = null;
        session.sipPeerConnection = null;
        logSdp(sessionId, "END-CALL ANSWER SDP (to client)", answerSdp);
        sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            action: "end-call",
            payload: { type: "answer", from: session.toIdentity, to: session.callerEns, sessionId, sdp: answerSdp },
        });
        session.phase = "post-call";
        session.endCallRenegDone = true;
    }

    return {
        onDataChannelOpen,
        sendInboundRing,
        triggerOutboundWebrtcLegRing,
        handleInboundCalleeAnswer,
        handleOutboundWebrtcLegAnswer,
        handleRing,
        handleReofferAnswer,
        handleCallEnd,
        handleEndCallRenegotiation,
    };
}

module.exports = {
    createCallFlowApi,
};
