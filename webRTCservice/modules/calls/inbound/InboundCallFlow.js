const { buildOfferPayload, serializeNotifyPayload } = require("../../participants/signaling/SignalingEnvelope");
const {
    identityLabel,
} = require("../../runtime/CallPairRef");

function createInboundCallFlow({
    createSession,
    resolveInboundTarget,
    findOutboundSessionForInbound,
    linkSessionPair,
    createPeerConnection,
    onDataChannelOpen,
    onDataChannelMessage,
    waitForIceGathering,
    formatIceCandidates,
    getRelayCandidates,
    embedCandidatesInSdp,
    sendNotification,
    pendingInboundCalls,
    destroySession,
    callRuntime = null,
    notiTypeCall,
    crypto,
    logger = console,
}) {
    async function handleInboundCallRequest(data) {
        const { from, to, callId, diversion, toDomain, serviceId = null } = data;
        logger.log(`[Inbound] Received inbound call from=${from} to=${to} callId=${callId}${diversion ? ` diversion=${diversion}` : ""}${toDomain ? ` toDomain=${toDomain}` : ""}`);
        const inboundDecision = await resolveInboundTarget(data, serviceId);
        if (!inboundDecision || inboundDecision.route !== "webrtc") {
            throw Object.assign(new Error(inboundDecision?.reason || `No WebRTC user for ${to}`), { statusCode: 404 });
        }

        const destination = inboundDecision;
        const calleeEns = destination.ensName || destination.wallet;
        const calleeWalletKey = destination.wallet.toLowerCase();
        const gatewayIdentity = String(from || "").replace(/^\+/, "");
        const calleeLabel = identityLabel(calleeEns || to);
        const sessionId = `${gatewayIdentity}|${calleeLabel}`;

        if (callRuntime && callRuntime.getSession(sessionId)) {
            await callRuntime.destroyRuntimeSession(sessionId, { source: "inbound", reason: "duplicate-inbound-session" });
        } else if (destroySession && !callRuntime) {
            destroySession(sessionId);
        }
        const session = createSession(sessionId, gatewayIdentity, calleeEns);
        if (serviceId) {
            session.serviceId = serviceId;
        }
        session.inboundCall = { fromNumber: from, toNumber: to, callId };
        session.isGatewayCaller = true;
        session.calleeWallet = calleeWalletKey;

        const outboundSessionId = findOutboundSessionForInbound(from, to, sessionId);
        if (outboundSessionId) linkSessionPair(sessionId, outboundSessionId);

        const pc = createPeerConnection(sessionId);
        const dc = pc.createDataChannel("messaging", { ordered: true });
        session.dataChannel = dc;
        dc.onopen = () => onDataChannelOpen(sessionId);
        dc.onMessage.subscribe((msg) => {
            const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf-8");
            onDataChannelMessage(sessionId, raw);
        });
        dc.onclose = () => logger.log(`[${sessionId}] Data channel closed`);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        const iceCandidates = formatIceCandidates(session);
        const callNonce = crypto.randomUUID();
        session.callNonce = callNonce;

        const INBOUND_TIMEOUT = 60000;
        const existingPending = pendingInboundCalls.get(calleeWalletKey);
        if (existingPending) clearTimeout(existingPending.timer);
        const inboundTimer = setTimeout(() => {
            pendingInboundCalls.delete(calleeWalletKey);
            if (callRuntime) callRuntime.destroyRuntimeSession(sessionId, { source: "inbound", reason: "inbound-timeout" });
        }, INBOUND_TIMEOUT);

        pendingInboundCalls.set(calleeWalletKey, {
            fromNumber: from,
            toNumber: to,
            callId,
            calleeEns,
            sessionId,
            timer: inboundTimer,
        });

        const relayCandidates = getRelayCandidates(iceCandidates);
        const nonTcpCandidates = iceCandidates.filter(c => !c.candidate.toLowerCase().includes(" tcp "));
        const srflxAndRelay = nonTcpCandidates.filter(c => c.candidate.includes("typ srflx") || c.candidate.includes("typ relay"));
        const candidatesToEmbed = srflxAndRelay.length > 0 ? srflxAndRelay : nonTcpCandidates;
        const sdpWithCandidates = embedCandidatesInSdp(offer.sdp, candidatesToEmbed);

        const offerPayload = serializeNotifyPayload(buildOfferPayload({
            from: gatewayIdentity,
            to: calleeEns,
            sessionId,
            sdp: sdpWithCandidates,
            candidates: relayCandidates,
            callNonce,
            isCall: true,
        }));
        session.lastNotificationResult = await sendNotification(calleeEns, calleeEns, offerPayload, notiTypeCall);
        return { ok: true, wallet: destination.wallet, ensName: destination.ensName, sessionId };
    }

    return {
        handleInboundCallRequest,
    };
}

module.exports = {
    createInboundCallFlow,
};
