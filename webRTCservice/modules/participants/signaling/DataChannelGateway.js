const { buildAnswerPayload, buildCallAck, buildDataChannelSignaling } = require("./SignalingEnvelope");

function isOpenDc(dc) {
    if (!dc) return false;
    const state = dc.readyState;
    return state === "open" || state === "OPEN";
}

function createNoOpenDcError(sessionId, detail = "no open data channel") {
    const err = new Error(`[${sessionId}] ${detail}`);
    err.code = "NO_OPEN_DC";
    return err;
}

function createDataChannelApi({ sessions, logger = console }) {
    function sendDataChannelMessage(sessionId, message) {
        const session = sessions.get(sessionId);
        if (!session || !isOpenDc(session.dataChannel)) {
            logger.error(`[${sessionId}] Cannot send DC message — no open data channel`);
            throw createNoOpenDcError(sessionId, "Cannot send DC message — no open data channel");
        }
        const raw = JSON.stringify(message);
        const action = message.action || message.payload?.type || "unknown";
        const ackForPart = (message.msgType === "call" && action === "ack" && message.ackFor)
            ? ` ackFor=${message.ackFor}`
            : "";
        logger.log(`[${sessionId}] DC-OUT: msgType=${message.msgType} action=${action}${ackForPart} phase=${session.phase || "?"}${message.payload?.sdp ? ` sdpLen=${message.payload.sdp.length}` : ""}`);
        session.dataChannel.send(raw);
    }

    function sendAck(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        sendDataChannelMessage(sessionId, buildCallAck({ ackFor: "ring" }));
    }

    function sendAnswer(sessionId, answerSdp) {
        const session = sessions.get(sessionId);
        if (!session) return;
        sendDataChannelMessage(sessionId, buildDataChannelSignaling(buildAnswerPayload({
            from: session.toIdentity,
            to: session.callerEns,
            sessionId,
            sdp: answerSdp,
        })));
    }

    function sendAckAndAnswer(sessionId, answerSdp) {
        sendAck(sessionId);
        sendAnswer(sessionId, answerSdp);
    }

    return {
        sendDataChannelMessage,
        sendAck,
        sendAnswer,
        sendAckAndAnswer,
    };
}

module.exports = {
    createDataChannelApi,
};
