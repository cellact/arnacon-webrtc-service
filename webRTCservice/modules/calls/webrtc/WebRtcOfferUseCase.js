function createOfferFlow({
    sessions,
    sessionsByUser,
    stableKey,
    createSession,
    destroySession,
    handleHandshake,
    handleInboundAnswer,
    handleHttpReject = null,
    onVerifiedNotifyAnswer = null,
    parseAddress,
    addIceCandidates,
    normalizeIdentity = null,
    callRuntime = null,
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

    function identityLabel(identity) {
        if (!identity || typeof identity !== "string") return identity;
        const trimmed = identity.trim();
        const atPos = trimmed.indexOf("@");
        if (atPos > 0) return trimmed.slice(0, atPos);
        const dotPos = trimmed.indexOf(".");
        if (dotPos > 0) return trimmed.slice(0, dotPos);
        return trimmed;
    }

    function normalizeSessionId(sessionId) {
        if (!sessionId || typeof sessionId !== "string") return sessionId;
        return sessionId.split("|").map(identityLabel).join("|");
    }

    function relationSessionCandidates(from, to, sessionId) {
        const fromLabel = identityLabel(from);
        const toLabel = identityLabel(to);
        const candidates = new Set();
        if (sessionId) candidates.add(normalizeSessionId(sessionId));
        if (fromLabel && toLabel) {
            candidates.add(`${fromLabel}|${toLabel}`);
            candidates.add(`${toLabel}|${fromLabel}`);
            candidates.add(stableKey(from, to));
        }
        return candidates;
    }

    function resolveExistingSessionId(from, to, sessionId) {
        for (const candidate of relationSessionCandidates(from, to, sessionId)) {
            if (sessions.has(candidate)) return candidate;
        }
        return normalizeSessionId(sessionId);
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
            logger.log(`[${sessionId || "no-session"}] Ignoring HTTP cancel`);
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

        assertAllowedInitialOfferFrom(from, sessionId, serviceId);

        if (sessions.has(sessionId) && callRuntime) {
            await callRuntime.destroyRuntimeSession(sessionId, { source: "http", reason: "duplicate-offer-session" });
        }
        const key = stableKey(from, to);
        const existingId = sessionsByUser.get(key);
        if (existingId && existingId !== sessionId && sessions.has(existingId)) {
            if (callRuntime) {
                await callRuntime.destroyRuntimeSession(existingId, { source: "http", reason: "duplicate-offer-user" });
            }
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
