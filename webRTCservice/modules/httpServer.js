"use strict";

const http = require("http");
const https = require("https");

function createPublicServer({
    tlsOptions,
    httpPort,
    handlers,
    sendJsonError,
    logger = console,
    verifyExternalRequest = null,
}) {
    const publicHttp = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sign, x-data");

        logger.log(`Incoming request: ${req.method} ${req.url}`);

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== "POST") {
            sendJsonError(res, 404, "Not found");
            return;
        }

        if (req.url === "/notify") {
            if (verifyExternalRequest) {
                try {
                    await verifyExternalRequest(req);
                } catch (err) {
                    sendJsonError(res, 401, err.message || "Unauthorized");
                    return;
                }
            }
            await handlers.handleNotify(req, res);
            return;
        }

        sendJsonError(res, 404, "Not found");
    });

    const publicHttps = https.createServer(tlsOptions, publicHttp.listeners("request")[0]);
    function start() {
        publicHttps.listen(httpPort, () => {
            logger.log(`WebRTCManager HTTPS listening on port ${httpPort}`);
        });
    }
    function stop() {
        return new Promise((resolve) => publicHttps.close(() => resolve()));
    }
    return { start, stop, server: publicHttps };
}

function createInternalServer({
    internalHttpPort,
    internalBindIp,
    handlers,
    sendJsonError,
    logger = console,
}) {
    const internalServer = http.createServer(async (req, res) => {
        logger.log(`[Internal] Incoming request: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        if (req.method !== "POST") {
            sendJsonError(res, 404, "Not found");
            return;
        }
        if (req.url !== "/inbound-call") {
            sendJsonError(res, 404, "Not found");
            return;
        }
        await handlers.handleInboundCall(req, res);
    });
    function start() {
        internalServer.listen(internalHttpPort, internalBindIp, () => {
            logger.log(`WebRTCManager internal HTTP listening on ${internalBindIp}:${internalHttpPort}`);
        });
    }
    function stop() {
        return new Promise((resolve) => internalServer.close(() => resolve()));
    }
    return { start, stop, server: internalServer };
}

function createHttpServers({
    tlsOptions,
    httpPort,
    internalHttpPort,
    internalBindIp,
    handlers,
    sendJsonError,
    logger = console,
    verifyExternalRequest = null,
}) {
    const publicServer = createPublicServer({
        tlsOptions,
        httpPort,
        handlers,
        sendJsonError,
        logger,
        verifyExternalRequest,
    });
    const internalServer = createInternalServer({
        internalHttpPort,
        internalBindIp,
        handlers,
        sendJsonError,
        logger,
    });

    function startPublicServer() {
        publicServer.start();
    }

    function startInternalServer() {
        internalServer.start();
    }

    function stopServers() {
        return Promise.all([
            publicServer.stop(),
            internalServer.stop(),
        ]);
    }

    return {
        startPublicServer,
        startInternalServer,
        stopServers,
        publicHttps: publicServer.server,
        internalServer: internalServer.server,
    };
}

module.exports = {
    createPublicServer,
    createInternalServer,
    createHttpServers,
};
