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
        sessionId,
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
    buildOfferPayload,
    buildDataChannelSignaling,
    buildAnswerPayload,
    buildCallAck,
    buildCallEnd,
    buildCallState,
    buildEndCallAnswerPayload,
    serializeNotifyPayload,
};
