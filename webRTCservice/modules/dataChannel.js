"use strict";

function createDataChannelApi({ sessions, logger = console }) {
    function sendDataChannelMessage(sessionId, message) {
        const session = sessions.get(sessionId);
        if (!session || !session.dataChannel) {
            logger.error(`[${sessionId}] Cannot send DC message — no data channel`);
            return;
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
        sendDataChannelMessage(sessionId, { msgType: "call", action: "ack", ackFor: "ring" });
    }

    function sendAnswer(sessionId, answerSdp) {
        const session = sessions.get(sessionId);
        if (!session) return;
        sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            payload: {
                type: "answer",
                from: session.toIdentity,
                to: session.callerEns,
                sessionId,
                sdp: answerSdp,
            },
        });
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
