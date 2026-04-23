"use strict";

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
            logger.log(`[Notify] Raw body: ${body}`);
            const rawData = JSON.parse(body);
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
