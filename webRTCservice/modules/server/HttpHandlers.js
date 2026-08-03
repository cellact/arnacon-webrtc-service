const crypto = require("crypto");

function isPrivacyEnabled(serviceRuntime) {
    return serviceRuntime?.serviceConstants?.logPrivacy?.enabled === true;
}

function hashIdentity(value) {
    const str = String(value ?? "").trim();
    if (!str) return null;
    return crypto.createHash("sha256").update(str).digest("hex");
}

function parseMaybeJson(value) {
    if (!value || typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
        return null;
    }
}

function summarizeNotifyPayload(rawData, body) {
    const nestedPayload = parseMaybeJson(rawData?.payload);
    const source = nestedPayload || rawData || {};
    return {
        type: source.type || rawData?.type || null,
        fromHash: hashIdentity(source.from || source.caller || source.author || rawData?.from || null),
        toHash: hashIdentity(source.to || source.callee || source.recipient || rawData?.to || null),
        sizeBytes: Buffer.byteLength(String(body || ""), "utf8"),
    };
}

function createHandlers({
    buildSignalingContextFromNotify,
    buildSignalingContextFromInbound,
    executeSignalingPipeline,
    serviceRuntime,
    readBody,
    sendJsonError,
    logger = console,
}) {
    async function handleNotify(req, res) {
        try {
            const body = await readBody(req);
            const rawData = JSON.parse(body);
            if (isPrivacyEnabled(serviceRuntime)) {
                logger.log("[Notify] payload received", summarizeNotifyPayload(rawData, body));
            } else {
                logger.log(`[Notify] Raw body: ${body}`);
            }
            const headerXSign = req.headers["x-sign"] || req.headers.xsign;
            const headerXData = req.headers["x-data"] || req.headers.xdata;
            if (headerXSign && !rawData.xsign && !rawData["x-sign"]) {
                rawData.xsign = headerXSign;
            }
            if (headerXData && !rawData.xdata && !rawData["x-data"]) {
                rawData.xdata = headerXData;
            }
            const data = serviceRuntime?.hooks?.normalizeIncomingPayload
                ? serviceRuntime.hooks.normalizeIncomingPayload(rawData)
                : rawData;
            const context = buildSignalingContextFromNotify(data, {
                serviceId: serviceRuntime?.id || null,
                providerId: serviceRuntime?.providerId || null,
            });
            const result = await executeSignalingPipeline(context);
            res.writeHead(result.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.responseBody));
        } catch (err) {
            logger.error(`${req.url} error:`, err.message);
            sendJsonError(res, err.statusCode || 500, err.message);
        }
    }

    async function handleInboundCall(req, res) {
        try {
            const body = await readBody(req);
            const rawData = JSON.parse(body);
            const data = serviceRuntime?.hooks?.normalizeInboundCallbackPayload
                ? serviceRuntime.hooks.normalizeInboundCallbackPayload(rawData)
                : rawData;
            const context = buildSignalingContextFromInbound(data, {
                serviceId: serviceRuntime?.id || null,
                providerId: serviceRuntime?.providerId || null,
            });
            const result = await executeSignalingPipeline(context);
            res.writeHead(result.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.responseBody));
        } catch (err) {
            logger.error(`[Internal] ${req.url} error:`, err.message);
            sendJsonError(res, err.statusCode || 500, err.message);
        }
    }

    return {
        handleNotify,
        handleInboundCall,
    };
}

module.exports = {
    createHandlers,
};
