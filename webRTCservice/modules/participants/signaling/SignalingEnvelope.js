// Bare label for an identity: strips an @domain or a .sub.global suffix.
function identityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

// The single source of truth for the wire sessionId we hand a client. Every
// client keys a session as sort(ownFullEns, peerBareNumber): it stores ITSELF as
// the full ENS and the peer as the bare number. In an offer/push, `to` is the
// recipient (so it MUST stay the full ENS) and `from` is the peer (bare). Deriving
// it here makes it structurally impossible for any caller to emit a bare|bare id
// again -> the client always stores/reuses the session under the right key.
function wireSessionId({ from, to, fallback = null } = {}) {
    if (!to || !from) return fallback;
    return [to, identityLabel(from)].sort().join("|");
}

function buildOfferPayload({
    from,
    to,
    sessionId,
    sdp,
    candidates = [],
    callNonce = null,
    isCall = true,
    extra = {},
} = {}) {
    return {
        type: "offer",
        from,
        to,
        sessionId: wireSessionId({ from, to, fallback: sessionId }),
        sdp,
        candidates,
        callNonce,
        isCall,
        ...extra,
    };
}

function buildDataChannelSignaling(payload) {
    return {
        msgType: "signaling",
        payload,
    };
}

function buildAnswerPayload({ from, to, sessionId, sdp } = {}) {
    return {
        type: "answer",
        from,
        to,
        sessionId,
        sdp,
    };
}

function buildCallAck({ ackFor, extra = {} } = {}) {
    return {
        msgType: "call",
        action: "ack",
        ackFor,
        ...extra,
    };
}

function buildCallEnd({ reason, source, extra = {} } = {}) {
    return {
        msgType: "call",
        action: "end",
        ...(reason ? { reason } : {}),
        ...(source ? { source } : {}),
        ...extra,
    };
}

function buildCallState({ action, state, extra = {} } = {}) {
    return {
        msgType: "call",
        action,
        ...(state ? { state } : {}),
        ...extra,
    };
}

function buildEndCallAnswerPayload({ from, to, sessionId, sdp } = {}) {
    return {
        msgType: "signaling",
        action: "end-call",
        payload: buildAnswerPayload({ from, to, sessionId, sdp }),
    };
}

function serializeNotifyPayload(payload) {
    return JSON.stringify(payload);
}

module.exports = {
    identityLabel,
    wireSessionId,
    buildOfferPayload,
    buildDataChannelSignaling,
    buildAnswerPayload,
    buildCallAck,
    buildCallEnd,
    buildCallState,
    buildEndCallAnswerPayload,
    serializeNotifyPayload,
};
