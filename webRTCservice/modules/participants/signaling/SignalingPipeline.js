class SignalingAuthVerifier {
    constructor({ blockchainGateway, sessions }) {
        if (!blockchainGateway) throw new Error("SignalingAuthVerifier requires blockchainGateway");
        this.blockchainGateway = blockchainGateway;
        this.sessions = sessions;
    }

    verify(payload = {}, signalingPlan = {}) {
        const type = payload.type || "offer";
        if (type === "offer") return this.blockchainGateway.verifyInitialOfferSignature(payload, signalingPlan);
        if (type === "answer") return this.blockchainGateway.verifyAnswerSignature(payload, this.sessions.get(payload.sessionId), signalingPlan);
        if (type === "ice-batch" || type === "cancel") {
            return this.blockchainGateway.verifyAnswerSignature(payload, this.sessions.get(payload.sessionId), signalingPlan);
        }
        throw new Error(`Unsupported HTTP signaling auth type: ${type}`);
    }
}

function createSignalingPipeline({
    onIncomingOffer,
    handleInboundCallRequest,
    verifyHttpNotifySignature,
    authVerifier = null,
    createHttpError,
    enforceNotifySignatures = true,
}) {
    function parseObjectPayload(value) {
        if (!value) return null;
        if (typeof value === "object" && !Array.isArray(value)) return { ...value };
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            const parsed = JSON.parse(trimmed);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function firstValueForKey(objects, keys) {
        for (const obj of objects) {
            if (!obj || typeof obj !== "object") continue;
            for (const key of keys) {
                if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
                    return obj[key];
                }
            }
        }
        return null;
    }

    function normalizeNotifyPayload(rawPayload) {
        const source = rawPayload || {};
        const nestedPayload = parseObjectPayload(source.payload);
        const bodyPayload = parseObjectPayload(source.body);
        const dataPayload = parseObjectPayload(source.data);
        const dataBodyPayload = parseObjectPayload(source.data?.body);
        const normalized = nestedPayload ||
            bodyPayload ||
            dataBodyPayload ||
            (dataPayload?.type ? dataPayload : null) ||
            { ...source };

        const authSources = [source, source.data, nestedPayload, bodyPayload, dataPayload, dataBodyPayload, normalized];
        const xsign = firstValueForKey(authSources, ["xsign", "x-sign"]);
        const xdata = firstValueForKey(authSources, ["xdata", "x-data"]);
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
                if (authVerifier) await authVerifier.verify(context.payload, signalingPlan);
                else await verifyHttpNotifySignature(context.payload, signalingPlan);
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
    SignalingAuthVerifier,
    createSignalingPipeline,
};
