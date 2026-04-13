"use strict";

function createHandshakeFlow({
    sessions,
    createPeerConnection,
    RTCSessionDescription,
    addIceCandidates,
    waitForIceGathering,
    formatIceCandidates,
    embedCandidatesInSdp,
    isRawEmail,
    emailToEnsName,
    isEthAddress,
    resolveEnsToAddress,
    logger = console,
}) {
    async function handleHandshake(sessionId, fromEns, toIdentity, offerSdp, candidates, callNonce) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const pc = createPeerConnection(sessionId);
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp, "offer"));
        await addIceCandidates(pc, candidates);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        const iceCandidates = formatIceCandidates(session);
        const answerSdp = embedCandidatesInSdp(answer.sdp, iceCandidates);

        let resolvedFromEns = fromEns;
        if (isRawEmail(fromEns)) {
            resolvedFromEns = emailToEnsName(fromEns);
            session.callerEns = resolvedFromEns;
            logger.log(`[${sessionId}] Translated raw email ${fromEns} → ${resolvedFromEns}`);
        }
        const walletAddress = isEthAddress(resolvedFromEns)
            ? resolvedFromEns
            : await resolveEnsToAddress(resolvedFromEns);
        session.walletAddress = walletAddress;
        session.phase = "waiting-for-dc";

        return {
            type: "answer",
            from: toIdentity,
            to: fromEns,
            sessionId,
            sdp: answerSdp,
            callNonce,
            candidates: iceCandidates,
        };
    }

    async function handleInboundAnswer(sessionId, answerSdp, candidates) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) {
            throw new Error("Session or PeerConnection not found for inbound answer");
        }
        const pc = session.peerConnection;
        await pc.setRemoteDescription(new RTCSessionDescription(answerSdp, "answer"));
        await addIceCandidates(pc, candidates);
        session.phase = "waiting-for-dc";
    }

    return {
        handleHandshake,
        handleInboundAnswer,
    };
}

module.exports = {
    createHandshakeFlow,
};
