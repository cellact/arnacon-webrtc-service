function joinUrl(baseUrl, path) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    const suffix = String(path || "").startsWith("/") ? path : `/${path || ""}`;
    return `${base}${suffix}`;
}

function createSecnumLogicClient(config = {}) {
    const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 3000;
    const endpoints = {
        auth: config.endpoints?.auth || "/auth",
        route: config.endpoints?.route || "/route",
        minutes: config.endpoints?.minutes || "/minutes",
        action: config.endpoints?.action || "/action",
    };

    async function post(path, body, baseUrl = config.baseUrl) {
        if (!baseUrl) {
            const err = new Error("secnumLogic baseUrl is not configured");
            err.code = "SECNUM_LOGIC_NOT_CONFIGURED";
            throw err;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(joinUrl(baseUrl, path), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body || {}),
                signal: controller.signal,
            });
            const text = await resp.text().catch(() => "");
            let json = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch (_) {
                json = null;
            }
            if (!resp.ok) {
                const err = new Error(
                    (json && (json.reason || json.message)) ||
                    `secnumLogic ${path} failed: HTTP ${resp.status}`,
                );
                err.status = resp.status;
                err.code = json?.code || "SECNUM_LOGIC_HTTP_ERROR";
                err.body = json;
                throw err;
            }
            return json;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        config,
        enabled: config.enabled === true && Boolean(config.baseUrl),
        auth(body) {
            return post(endpoints.auth, body);
        },
        route(body) {
            return post(endpoints.route, body);
        },
        minutes(body) {
            return post(endpoints.minutes, body);
        },
        action(body) {
            return post(endpoints.action, body);
        },
    };
}

function readSecnumLogicConfig(serviceConstants = {}) {
    const cfg = serviceConstants?.secnumLogic;
    if (!cfg || typeof cfg !== "object") return null;
    return {
        enabled: cfg.enabled === true,
        baseUrl: String(cfg.baseUrl || "").trim(),
        timeoutMs: Number(cfg.timeoutMs) || 3000,
        endpoints: cfg.endpoints && typeof cfg.endpoints === "object" ? cfg.endpoints : {},
    };
}

module.exports = {
    createSecnumLogicClient,
    readSecnumLogicConfig,
};
