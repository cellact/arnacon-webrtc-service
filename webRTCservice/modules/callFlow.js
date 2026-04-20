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
        if (session.walletAddress) {
            checkPendingBridge(sessionId, session.walletAddress);
            checkPendingInboundCall(sessionId, session.walletAddress);
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
        const offerSdp = embedCandidatesInSdp(offer.sdp, candidatesToEmbed);
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
        try {
            await openInboundSipSession(sessionId, session.inboundCall.toNumber);
        } catch (err) {
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end" });
            session.phase = "post-call";
        }
    }

    async function handleRing(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
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
        session.phase = "in-call";
        if (!(isInbound && isInactive)) {
            const existingAudioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (existingAudioT) existingAudioT.setDirection("sendrecv");
        }

        let offerSdp = payload.sdp;
        if (isInactive) offerSdp = patchInactiveToSendrecv(offerSdp);
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp, "offer"));

        ensureLocalAudioTrack(session, pc, sessionId);
        const answerLabel = isInactive ? "PHASE 1 ANSWER SDP" : "ANSWER SDP";
        const answerSdp = await createAnswerSdp(pc, sessionId, answerLabel);

        if (!isInbound) sendAck(sessionId);
        try {
            if (isInbound) await openInboundSipSession(sessionId, session.inboundCall.toNumber);
            else await routeCall(sessionId, session, destination, parsedFrom);
        } catch (err) {
            failCall(sessionId, err, isInbound ? "Inbound SIP session failed" : "Call routing failed");
            return;
        }

        if (isInbound) sendAckAndAnswer(sessionId, answerSdp);
        else sendAnswer(sessionId, answerSdp);
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
        await closeSipSession(sessionId);
        logger.log(`[${sessionId}] SIP torn down — awaiting end-call renegotiation from client (${reason})`);
    }

    async function handleEndCallRenegotiation(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) return;
        const pc = session.peerConnection;
        logSdp(sessionId, "END-CALL OFFER SDP (from client)", payload.sdp);
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
        handleInboundCalleeAnswer,
        handleRing,
        handleReofferAnswer,
        handleCallEnd,
        handleEndCallRenegotiation,
    };
}

module.exports = {
    createCallFlowApi,
};
