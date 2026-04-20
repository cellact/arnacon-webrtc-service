"use strict";

function createOfferFlow({
    sessions,
    sessionsByUser,
    stableKey,
    createSession,
    destroySession,
    handleHandshake,
    handleInboundAnswer,
    onVerifiedNotifyAnswer = null,
    parseAddress,
    addIceCandidates,
    normalizeIdentity = null,
    createHttpError,
    logger = console,
}) {
    function normalizeAddress(addr, serviceId = null) {
        if (!addr) return addr;
        if (normalizeIdentity && typeof normalizeIdentity === "function") {
            return normalizeIdentity(addr, serviceId);
        }
        return addr;
    }

    function assertAllowedInitialOfferFrom(from, sessionId, serviceId = null) {
        const parsedFrom = parseAddress(normalizeAddress(from || ""), serviceId);
        const isAllowed = parsedFrom.type === "ens" || parsedFrom.type === "email";
        if (!isAllowed) {
            throw createHttpError(403, `Unsupported from format for initial offer: ${from}`);
        }
        logger.log(
            `[${sessionId || "no-session"}] Initial offer from format accepted (${parsedFrom.type}): ${from}`,
        );
    }

    async function onIncomingOffer(offer) {
        logger.log(`Incoming offer: ${JSON.stringify(offer)}`);
        const serviceId = offer.serviceId || null;
        const from = normalizeAddress(offer.from, serviceId);
        const to = normalizeAddress(offer.to, serviceId);
        const { sessionId, sdp, candidates, callNonce, type } = offer;
        offer.from = from;
        offer.to = to;

        if (type === "ice-batch") {
            const session = sessions.get(sessionId);
            if (!session || !session.peerConnection) {
                return { ok: true, ignored: true, reason: "session-not-ready", type: "ice-batch", sessionId };
            }
            // TEMPORARY: enforce xdata/xsign verification for trickle ICE once clients send it reliably.
            // await verifyTrickleSignature(offer, session);
            const applied = await addIceCandidates(session.peerConnection, candidates || []);
            logger.log(`[${sessionId}] Applied trickle ICE candidates: ${applied}`);
            return { ok: true, applied, type: "ice-batch", sessionId };
        }

        if (type === "cancel") {
            logger.log(`[${sessionId || "no-session"}] Ignoring HTTP cancel`);
            return { ok: true, ignored: true, type: "cancel", sessionId };
        }

        if (type === "answer") {
            const session = sessions.get(sessionId);
            if (session && session.isGatewayCaller) {
                if (session.inboundAnswerApplied) return;
                session.inboundAnswerApplied = true;
                try {
                    await handleInboundAnswer(sessionId, sdp, candidates || []);
                } catch (err) {
                    logger.error(`[${sessionId}] Inbound answer failed: ${err.message}`);
                    session.inboundAnswerApplied = false;
                    destroySession(sessionId, false);
                }
                if (typeof onVerifiedNotifyAnswer === "function") {
                    const result = await onVerifiedNotifyAnswer(sessionId, offer, session);
                    if (result && result.handled) return result;
                }
                return { ok: true, sessionId };
            }
            if (session && typeof onVerifiedNotifyAnswer === "function") {
                const result = await onVerifiedNotifyAnswer(sessionId, offer, session);
                if (result && result.handled) {
                    return result;
                }
            }
            return;
        }

        if (type && type !== "offer") {
            throw createHttpError(400, `Unsupported signaling type over HTTP: ${type}`);
        }

        assertAllowedInitialOfferFrom(from, sessionId, serviceId);

        if (sessions.has(sessionId)) destroySession(sessionId, false);
        const key = stableKey(from, to);
        const existingId = sessionsByUser.get(key);
        if (existingId && existingId !== sessionId && sessions.has(existingId)) {
            destroySession(existingId, false);
        }

        const session = createSession(sessionId, from, to);
        if (session && serviceId) {
            session.serviceId = serviceId;
        }
        try {
            return await handleHandshake(sessionId, from, to, sdp, candidates || [], callNonce);
        } catch (err) {
            logger.error(`[${sessionId}] Handshake failed: ${err.message}`);
            destroySession(sessionId, false);
        }
    }

    return {
        onIncomingOffer,
    };
}

module.exports = {
    createOfferFlow,
};
