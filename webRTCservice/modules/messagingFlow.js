"use strict";

function createMessagingFlow({
    sendDataChannelMessage,
    processorUrl,
    fetchImpl = fetch,
    logger = console,
    createHttpError,
}) {
    function toForwardPayload(msg) {
        if (typeof msg?.payload === "string") return msg.payload;
        if (msg?.payload != null) return JSON.stringify(msg.payload);
        if (typeof msg?.data === "string") return msg.data;
        if (msg?.data != null) return JSON.stringify(msg.data);
        return JSON.stringify(msg || {});
    }

    function safeParseJson(raw) {
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function buildProcessorRequestBody(sessionId, msgId, payloadString) {
        const parsedPayload = safeParseJson(payloadString);
        const payloadObject = parsedPayload && typeof parsedPayload === "object"
            ? parsedPayload
            : { raw: payloadString };

        // Send a superset schema:
        // - payload (object) for strict object validators
        // - payloadRaw (string) for legacy consumers
        // - top-level fields for processors that assert required keys directly on body
        return {
            sessionId,
            msgId: msgId || null,
            payload: payloadObject,
            payloadRaw: payloadString,
            type: payloadObject.type ?? null,
            messageId: payloadObject.messageId ?? null,
            author: payloadObject.author ?? null,
            recipient: payloadObject.recipient ?? null,
            text: payloadObject.text ?? null,
        };
    }

    async function forwardMessageToProcessor(sessionId, msgId, payloadString) {
        if (!processorUrl) {
            throw createHttpError(500, "Messaging processor URL is not configured");
        }
        const requestBody = buildProcessorRequestBody(sessionId, msgId, payloadString);
        const response = await fetchImpl(processorUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw createHttpError(
                502,
                `Message processor failed: status=${response.status} body=${body.slice(0, 300)}`,
            );
        }
    }

    async function handleDataMessage(sessionId, msg, phase = "unknown") {
        const msgId = msg?.msgId || "";
        const payloadString = toForwardPayload(msg);
        logger.log(
            `[${sessionId}] MSG-FWD start: msgId=${msgId || "none"} phase=${phase} payloadLen=${payloadString.length}`,
        );

        await forwardMessageToProcessor(sessionId, msgId, payloadString);

        if (msgId) {
            sendDataChannelMessage(sessionId, { msgType: "ack", msgId });
            logger.log(`[${sessionId}] MSG-ACK sent: msgId=${msgId}`);
        } else {
            logger.log(`[${sessionId}] MSG-ACK skipped: missing msgId`);
        }
    }

    return {
        handleDataMessage,
    };
}

module.exports = {
    createMessagingFlow,
};
