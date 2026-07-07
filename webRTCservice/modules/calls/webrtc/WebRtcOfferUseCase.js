const { normalizeSessionId, identityLabel } = require("../../runtime/CallPairRef");

function createOfferFlow({
    sessions,
    sessionsByUser,
    stableKey,
    createSession,
    destroySession,
    handleHandshake,
    handleInboundAnswer,
    handleHttpReject = null,
    handleHttpCancel = null,
    onVerifiedNotifyAnswer = null,
    onExistingPairOffer = null,
    parseAddress,
    addIceCandidates,
    normalizeIdentity = null,
    callRuntime = null,
    createHttpError,
    logger = console,
}) {
    function sessionMatchesPair(session, from, to) {
        if (!session) return false;
        return stableKey(session.callerEns, session.toIdentity) === stableKey(from, to);
    }

    function normalizeAddress(addr, serviceId = null) {
        if (!addr) return addr;
        if (normalizeIdentity && typeof normalizeIdentity === "function") {
            return normalizeIdentity(addr, serviceId);
        }
        return addr;
    }

    function resolveExistingSessionId(from, to, sessionId) {
        const pairKey = stableKey(from, to);
        const normalized = normalizeSessionId(sessionId);
        if (normalized && sessions.has(normalized)) {
            const exact = sessions.get(normalized);
            if (sessionMatchesPair(exact, from, to)) {
                return normalized;
            }
        }
        const pairSessionId = sessionsByUser.get(pairKey);
        if (pairSessionId && sessions.has(pairSessionId)) return pairSessionId;
        for (const [candidateId, session] of sessions.entries()) {
            if (sessionMatchesPair(session, from, to)) return candidateId;
        }
        return normalized;
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
        const rawFrom = offer.from;
        const rawTo = offer.to;
        const from = normalizeAddress(offer.from, serviceId);
        const to = normalizeAddress(offer.to, serviceId);
        const { sdp, candidates, callNonce, type } = offer;
        let sessionId = normalizeSessionId(offer.sessionId);
        offer.from = from;
        offer.to = to;
        offer.sessionId = sessionId;

        if (type === "ice-batch") {
            sessionId = resolveExistingSessionId(from, to, sessionId);
            offer.sessionId = sessionId;
            const session = sessions.get(sessionId);
            if (!session || !session.peerConnection) {
                logger.warn(
                    `[${sessionId || "no-session"}] HTTP ice-batch dropped: session not ready`,
                    { from, to, sessionId },
                );
                return { ok: true, ignored: true, reason: "session-not-ready", type: "ice-batch", sessionId };
            }
            // TEMPORARY: enforce xdata/xsign verification for trickle ICE once clients send it reliably.
            // await verifyTrickleSignature(offer, session);
            const applied = await addIceCandidates(session.peerConnection, candidates || []);
            logger.log(`[${sessionId}] Applied trickle ICE candidates: ${applied}`);
            return { ok: true, applied, type: "ice-batch", sessionId };
        }

        if (type === "cancel") {
            sessionId = resolveExistingSessionId(from, to, sessionId);
            offer.sessionId = sessionId;
            if (typeof handleHttpCancel === "function") {
                return handleHttpCancel(sessionId, offer);
            }
            logger.warn(`[${sessionId || "no-session"}] HTTP cancel received without handler`);
            return { ok: true, ignored: true, type: "cancel", sessionId };
        }

        if (type === "reject") {
            sessionId = resolveExistingSessionId(from, to, sessionId);
            offer.sessionId = sessionId;
            if (typeof handleHttpReject === "function") {
                return handleHttpReject(sessionId, offer);
            }
            logger.warn(`[${sessionId || "no-session"}] HTTP reject received without handler`);
            return { ok: true, ignored: true, type: "reject", sessionId };
        }

        if (type === "answer") {
            sessionId = resolveExistingSessionId(from, to, sessionId);
            offer.sessionId = sessionId;
            const session = sessions.get(sessionId);
            if (session && callRuntime?.getSessionKind(session) === "gateway-inbound") {
                if (session.inboundAnswerApplied) return;
                session.inboundAnswerApplied = true;
                try {
                    await handleInboundAnswer(sessionId, sdp, candidates || []);
                } catch (err) {
                    logger.error(`[${sessionId}] Inbound answer failed: ${err.message}`);
                    session.inboundAnswerApplied = false;
                    if (callRuntime) callRuntime.destroyRuntimeSession(sessionId, { source: "http", reason: "inbound-answer-failed" });
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

        const rawFromLabel = identityLabel(String(rawFrom || "").toLowerCase());
        const rawToLabel = identityLabel(String(rawTo || "").toLowerCase());
        const normalizedFromLabel = identityLabel(String(from || "").toLowerCase());
        const normalizedToLabel = identityLabel(String(to || "").toLowerCase());
        const wasCrossParty =
            !!rawFromLabel
            && !!rawToLabel
            && rawFromLabel !== rawToLabel;
        const collapsedToSelf =
            !!normalizedFromLabel
            && !!normalizedToLabel
            && normalizedFromLabel === normalizedToLabel;
        if (wasCrossParty && collapsedToSelf) {
            logger.error(
                `[${sessionId || "no-session"}] rejecting invalid self-pair after normalization`,
                {
                    rawFrom,
                    rawTo,
                    normalizedFrom: from,
                    normalizedTo: to,
                    rawPair: `${rawFromLabel}|${rawToLabel}`,
                    normalizedPair: `${normalizedFromLabel}|${normalizedToLabel}`,
                },
            );
            throw createHttpError(409, "Invalid self-pair after normalization");
        }

        assertAllowedInitialOfferFrom(from, sessionId, serviceId);

        const key = stableKey(from, to);
        const existingPairSessionId = resolveExistingSessionId(from, to, sessionId || key);
        if (existingPairSessionId && sessions.has(existingPairSessionId)) {
            sessionId = existingPairSessionId;
            offer.sessionId = sessionId;
            const pairSession = sessions.get(existingPairSessionId);
            if (typeof onExistingPairOffer === "function") {
                const routed = await onExistingPairOffer({
                    sessionId,
                    pairKey: key,
                    offer,
                    session: pairSession,
                });
                if (routed && routed.handled) {
                    return routed.responseBody || { ok: true, sessionId, handled: true, type: "offer" };
                }
            }
            logger.warn(`[${sessionId}] existing pair offer arrived without reusable ingress handler`);
            return { ok: true, sessionId, handled: false, type: "offer", reusedPairContext: true };
        }

        sessionId = key;
        offer.sessionId = sessionId;

        if (sessions.has(sessionId) && callRuntime) {
            await callRuntime.destroyRuntimeSession(sessionId, { source: "http", reason: "duplicate-offer-session" });
        }

        const session = createSession(sessionId, from, to);
        if (session && serviceId) {
            session.serviceId = serviceId;
        }
        try {
            return await handleHandshake(sessionId, from, to, sdp, candidates || [], callNonce);
        } catch (err) {
            logger.error(`[${sessionId}] Handshake failed: ${err.message}`);
            if (callRuntime) callRuntime.destroyRuntimeSession(sessionId, { source: "http", reason: "handshake-failed" });
        }
    }

    return {
        onIncomingOffer,
    };
}

module.exports = {
    createOfferFlow,
};
