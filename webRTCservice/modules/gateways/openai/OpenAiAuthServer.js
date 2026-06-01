class OpenAiAuthServer {
    constructor({
        createServer,
        authPath,
        transferPath,
        authPort,
        authBindIp,
        scheme,
        readJsonRequest,
        sendJson,
        authorizeIncomingOpenAiCall,
        transferOpenAiCall,
        logger = console,
    }) {
        Object.assign(this, {
            createServer,
            authPath,
            transferPath,
            authPort,
            authBindIp,
            scheme,
            readJsonRequest,
            sendJson,
            authorizeIncomingOpenAiCall,
            transferOpenAiCall,
            logger,
            server: null,
        });
    }

    start() {
        if (this.server) return this.server;
        const allowedPaths = new Set([this.authPath, "/openai-call-auth", this.transferPath]);
        this.server = this.createServer(async (req, res) => {
            const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
            if (req.method === "GET" && url.pathname === "/health") {
                this.sendJson(res, 200, { ok: true, service: "openai-sip-auth" });
                return;
            }
            if (req.method !== "POST" || !allowedPaths.has(url.pathname)) {
                this.sendJson(res, 404, { allowed: false, reason: "not found" });
                return;
            }
            try {
                const body = await this.readJsonRequest(req);
                if (url.pathname === this.transferPath) {
                    const result = await this.transferOpenAiCall(body);
                    this.sendJson(res, 200, result);
                    return;
                }
                const decision = this.authorizeIncomingOpenAiCall(body);
                this.sendJson(res, decision.allowed ? 200 : 403, decision);
            } catch (err) {
                this.sendJson(res, err.statusCode || 400, { allowed: false, reason: err.message });
            }
        });
        this.server.on("error", (err) => {
            this.logger.error(`[OpenAI-SIP-Auth] server error: ${err.message}`);
        });
        this.server.listen(this.authPort, this.authBindIp, () => {
            this.logger.log(`[OpenAI-SIP-Auth] ${this.scheme} listening on ${this.authBindIp}:${this.authPort}${this.authPath}`);
        });
        return this.server;
    }

    stop() {
        if (!this.server) return;
        const server = this.server;
        this.server = null;
        server.close((err) => {
            if (err) this.logger.warn(`[OpenAI-SIP-Auth] close failed: ${err.message}`);
        });
    }
}

module.exports = {
    OpenAiAuthServer,
};
