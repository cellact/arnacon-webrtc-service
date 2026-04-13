"use strict";

function createSignalingHandlers({
    sessions,
    handleEndCallRenegotiation,
    handleReofferAnswer,
    handleInboundCalleeAnswer,
    handleIceRestart,
    handleRing,
    handleCallEnd,
    handleDataMessage,
    logger = console,
}) {
    function enqueueSignaling(sessionId, label, fn) {
        const s = sessions.get(sessionId);
        if (!s) {
            logger.error(`[${sessionId}] enqueueSignaling(${label}): no session`);
            return;
        }
        s.signalingQueue = s.signalingQueue.then(async () => {
            logger.log(`[${sessionId}] SIG-Q start: ${label}`);
            try {
                await fn();
            } catch (err) {
                logger.error(`[${sessionId}] SIG-Q error (${label}): ${err.message}`);
            }
            logger.log(`[${sessionId}] SIG-Q done: ${label}`);
        });
    }

    function onDataChannelMessage(sessionId, rawMessage) {
        let msg;
        try {
            msg = JSON.parse(rawMessage);
        } catch (err) {
            logger.error(`[${sessionId}] Failed to parse DC message: ${err.message}`);
            return;
        }

        const sess = sessions.get(sessionId);
        const phase = sess ? sess.phase : "no-session";
        const msgType = msg.msgType;
        const dcAction = msg.action || msg.payload?.type || "unknown";
        const sdpLen = msg.payload?.sdp ? msg.payload.sdp.length : 0;
        logger.log(`[${sessionId}] DC-IN: msgType=${msgType} action=${dcAction} phase=${phase}${sdpLen ? ` sdpLen=${sdpLen}` : ""}`);

        if (msgType === "signaling") {
            const action = msg.action;
            const payload = msg.payload;

            if (action === "end-call" && payload) {
                enqueueSignaling(sessionId, "end-call", () => handleEndCallRenegotiation(sessionId, payload));
                return;
            }

            if (payload && payload.type === "answer") {
                const s = sessions.get(sessionId);
                if (s && s.pendingReoffer) {
                    enqueueSignaling(sessionId, "reoffer-answer", () => handleReofferAnswer(sessionId, payload));
                } else if (s && s.isGatewayCaller) {
                    enqueueSignaling(sessionId, "inbound-answer", () => handleInboundCalleeAnswer(sessionId, payload));
                }
                return;
            }

            if (payload && payload.type === "offer") {
                const s = sessions.get(sessionId);
                if (s && s.phase === "in-call") {
                    enqueueSignaling(sessionId, "ice-restart", () => handleIceRestart(sessionId, payload));
                } else {
                    enqueueSignaling(sessionId, "ring", () => handleRing(sessionId, payload));
                }
                return;
            }
            return;
        }

        if (msgType === "call") {
            const action = msg.action;
            if (action === "end") {
                enqueueSignaling(sessionId, "call-end", () => handleCallEnd(sessionId, "client-initiated"));
                return;
            }
            if (action === "reject") {
                enqueueSignaling(sessionId, "call-reject", () => handleCallEnd(sessionId, "client-reject"));
                return;
            }
            if (action === "hold") {
                const s = sessions.get(sessionId);
                if (s?.sipLocalAudioTrack) s.sipLocalAudioTrack.enabled = false;
                return;
            }
            if (action === "unhold") {
                const s = sessions.get(sessionId);
                if (s?.sipLocalAudioTrack) s.sipLocalAudioTrack.enabled = true;
                return;
            }
            return;
        }

        if (msgType === "data") {
            const inferredAction =
                msg.action ||
                msg.event ||
                msg.kind ||
                msg.payload?.type ||
                (typeof msg.data === "string" ? msg.data : "data");
            const textBody =
                typeof msg.text === "string"
                    ? msg.text
                    : typeof msg.data === "string"
                        ? msg.data
                        : typeof msg.payload === "string"
                            ? msg.payload
                            : null;
            const previewSource = textBody || JSON.stringify(msg.payload ?? msg.data ?? msg);
            const preview = String(previewSource || "")
                .replace(/\s+/g, " ")
                .slice(0, 200);
            logger.log(
                `[${sessionId}] DC-DATA: action=${inferredAction} phase=${phase} preview="${preview}"`,
            );
            if (typeof handleDataMessage === "function") {
                handleDataMessage(sessionId, msg, phase).catch((err) => {
                    logger.error(`[${sessionId}] DC-DATA forward failed: ${err.message}`);
                });
            }
            return;
        }

        logger.log(
            `[${sessionId}] DC-IN unhandled msgType=${msgType} phase=${phase} keys=${Object.keys(msg || {}).join(",")}`,
        );
    }

    return {
        enqueueSignaling,
        onDataChannelMessage,
    };
}

module.exports = {
    createSignalingHandlers,
};
