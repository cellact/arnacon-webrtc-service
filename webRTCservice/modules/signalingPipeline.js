"use strict";

function createSignalingPipeline({
    onIncomingOffer,
    handleInboundCallRequest,
    verifyHttpNotifySignature,
    createHttpError,
    enforceNotifySignatures = true,
}) {
    function normalizeNotifyPayload(rawPayload) {
        const source = rawPayload || {};
        const nested = source && typeof source.payload === "object" ? source.payload : null;
        const normalized = nested ? { ...nested } : { ...source };

        // Support both legacy keys (xsign/xdata) and new transport keys (x-sign/x-data).
        const xsign = source.xsign || source["x-sign"] || normalized.xsign || normalized["x-sign"];
        const xdata = source.xdata || source["x-data"] || normalized.xdata || normalized["x-data"];
        if (xsign && !normalized.xsign) normalized.xsign = xsign;
        if (xdata && !normalized.xdata) normalized.xdata = xdata;

        return normalized;
    }

    function buildSignalingContextFromNotify(payload, serviceContext = null) {
        return { source: "notify", payload: normalizeNotifyPayload(payload), serviceContext };
    }

    function buildSignalingContextFromInbound(payload, serviceContext = null) {
        return { source: "inbound-call", payload, serviceContext };
    }

    function defineSignaling(context) {
        const payload = context.payload || {};
        if (context.source === "notify") {
            const notifyType = payload.type || "offer";
            if (notifyType === "offer") {
                return { entryType: "notifyOffer", sessionMode: "create", routeMode: "sbcOrWebrtc" };
            }
            if (notifyType === "answer") {
                return { entryType: "notifyAnswer", sessionMode: "joinInbound", routeMode: "inboundBridge" };
            }
            if (notifyType === "ice-batch") {
                return { entryType: "notifyIceBatch", sessionMode: "join", routeMode: "inboundBridge" };
            }
            if (notifyType === "cancel") {
                return { entryType: "notifyCancel", sessionMode: "join", routeMode: "inboundBridge" };
            }
            throw createHttpError(400, `Unsupported signaling type over HTTP: ${notifyType}`);
        }
        if (context.source === "inbound-call") {
            return { entryType: "internalInbound", sessionMode: "create", routeMode: "inboundBridge" };
        }
        throw createHttpError(400, `Unsupported signaling source: ${context.source}`);
    }

    async function startSignaling(context, signalingPlan) {
        if (
            signalingPlan.entryType === "notifyOffer" ||
            signalingPlan.entryType === "notifyAnswer" ||
            signalingPlan.entryType === "notifyIceBatch" ||
            signalingPlan.entryType === "notifyCancel"
        ) {
            if (enforceNotifySignatures) {
                await verifyHttpNotifySignature(context.payload, signalingPlan);
            }
            const answerResponse = await onIncomingOffer(context.payload, context.serviceContext);
            return {
                statusCode: 200,
                responseBody: answerResponse || { ok: true, sessionId: context.payload?.sessionId },
            };
        }
        if (signalingPlan.entryType === "internalInbound") {
            const result = await handleInboundCallRequest(context.payload, context.serviceContext);
            return { statusCode: 202, responseBody: result };
        }
        throw createHttpError(400, `Unsupported signaling entryType: ${signalingPlan.entryType}`);
    }

    async function executeSignalingPipeline(context) {
        const signalingPlan = defineSignaling(context);
        return startSignaling(context, signalingPlan);
    }

    return {
        buildSignalingContextFromNotify,
        buildSignalingContextFromInbound,
        executeSignalingPipeline,
    };
}

module.exports = {
    createSignalingPipeline,
};
