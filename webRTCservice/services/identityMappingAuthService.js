const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createIdentityMappingAuthService({
    identityMappingConfig = {},
    logger = console,
    timeoutMs = 2500,
    fetchImpl = fetch,
}) {
    const tokenFile = String(
        process.env.GCP_MAPPING_TOKEN_FILE ||
        process.env.ARNACON_GCP_MAPPING_TOKEN_FILE ||
        identityMappingConfig.tokenFile ||
        "",
    ).trim();
    const tokenFileResolved = tokenFile ? path.resolve(tokenFile) : "";

    const serviceAccountJsonFile = String(
        process.env.GCP_SERVICE_ACCOUNT_JSON_FILE ||
        process.env.ARNACON_GCP_SERVICE_ACCOUNT_JSON_FILE ||
        identityMappingConfig.serviceAccountJsonFile ||
        "",
    ).trim();
    const serviceAccountJsonFileResolved = serviceAccountJsonFile ? path.resolve(serviceAccountJsonFile) : "";

    const idTokenAudience = String(
        process.env.GCP_ID_TOKEN_AUDIENCE ||
        process.env.ARNACON_GCP_ID_TOKEN_AUDIENCE ||
        identityMappingConfig.idTokenAudience ||
        "",
    ).trim();

    const oauthTokenUrl = String(
        process.env.GCP_OAUTH_TOKEN_URL ||
        process.env.ARNACON_GCP_OAUTH_TOKEN_URL ||
        identityMappingConfig.oauthTokenUrl ||
        "https://oauth2.googleapis.com/token",
    ).trim();

    let configLogged = false;
    let tokenCachePath = "";
    let tokenCacheMtimeMs = 0;
    let tokenCacheValue = "";
    let serviceAccountCachePath = "";
    let serviceAccountCacheMtimeMs = 0;
    let serviceAccountCacheValue = null;
    const idTokenCacheByAudience = new Map();

    function maskToken(token) {
        if (!token) return "";
        const trimmed = String(token).trim();
        if (trimmed.length <= 12) return "***";
        return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
    }

    function getTimeoutMs() {
        return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2500;
    }

    function getConfigSnapshot() {
        const hasServiceAccount = Boolean(serviceAccountJsonFileResolved);
        const hasTokenFile = Boolean(tokenFileResolved);
        return {
            hasServiceAccount,
            hasTokenFile,
            authMode: hasServiceAccount ? "service_account_json" : hasTokenFile ? "token_file" : "none",
            tokenFile: tokenFileResolved || null,
            serviceAccountJsonFile: serviceAccountJsonFileResolved || null,
            idTokenAudience: idTokenAudience || null,
            oauthTokenUrl: oauthTokenUrl || null,
        };
    }

    function logConfigOnce(extra = {}) {
        if (configLogged) return;
        configLogged = true;
        logger.log("[IdentityMapping] config", {
            ...getConfigSnapshot(),
            ...extra,
        });
    }

    function readTokenFromFile() {
        if (!tokenFileResolved) return "";
        try {
            const stats = fs.statSync(tokenFileResolved);
            if (
                tokenCachePath === tokenFileResolved &&
                tokenCacheMtimeMs === stats.mtimeMs &&
                tokenCacheValue
            ) {
                return tokenCacheValue;
            }

            const token = String(fs.readFileSync(tokenFileResolved, "utf8") || "").trim();
            tokenCachePath = tokenFileResolved;
            tokenCacheMtimeMs = stats.mtimeMs;
            tokenCacheValue = token;
            logger.log("[IdentityMapping] bearer token loaded", {
                tokenFile: tokenFileResolved,
                tokenMask: maskToken(token),
            });
            return token;
        } catch (err) {
            logger.warn(`[IdentityMapping] failed reading token file '${tokenFileResolved}': ${err.message}`);
            return "";
        }
    }

    function base64urlEncode(input) {
        const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
        return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function base64urlDecode(str) {
        const normalized = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
        const padding = (4 - (normalized.length % 4)) % 4;
        return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64");
    }

    function decodeJwtExpEpochSec(token) {
        try {
            const parts = String(token || "").split(".");
            if (parts.length < 2) return 0;
            const payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
            const exp = Number(payload?.exp || 0);
            return Number.isFinite(exp) && exp > 0 ? exp : 0;
        } catch (_) {
            return 0;
        }
    }

    function audienceForBaseUrl(baseUrl) {
        if (idTokenAudience) return idTokenAudience;
        return String(baseUrl || "").split("?")[0].trim();
    }

    function readServiceAccountJson() {
        if (!serviceAccountJsonFileResolved) return null;
        try {
            const stats = fs.statSync(serviceAccountJsonFileResolved);
            if (
                serviceAccountCachePath === serviceAccountJsonFileResolved &&
                serviceAccountCacheMtimeMs === stats.mtimeMs &&
                serviceAccountCacheValue
            ) {
                return serviceAccountCacheValue;
            }

            const raw = String(fs.readFileSync(serviceAccountJsonFileResolved, "utf8") || "").trim();
            const parsed = JSON.parse(raw);
            if (!parsed?.client_email || !parsed?.private_key) {
                logger.warn("[IdentityMapping] invalid service-account JSON (missing client_email/private_key)");
                return null;
            }

            serviceAccountCachePath = serviceAccountJsonFileResolved;
            serviceAccountCacheMtimeMs = stats.mtimeMs;
            serviceAccountCacheValue = parsed;
            logger.log("[IdentityMapping] service-account JSON loaded", {
                jsonFile: serviceAccountJsonFileResolved,
                clientEmail: parsed.client_email,
            });
            return parsed;
        } catch (err) {
            logger.warn(`[IdentityMapping] failed reading service-account JSON '${serviceAccountJsonFileResolved}': ${err.message}`);
            return null;
        }
    }

    async function mintIdToken(audience, contextLabel) {
        const serviceAccount = readServiceAccountJson();
        if (!serviceAccount || !audience) return "";

        const nowSec = Math.floor(Date.now() / 1000);
        const cacheKey = String(audience).trim();
        const cached = idTokenCacheByAudience.get(cacheKey);
        if (cached?.token && cached.expEpochSec && (cached.expEpochSec - nowSec) > 120) {
            return cached.token;
        }

        const header = { alg: "RS256", typ: "JWT" };
        const payload = {
            iss: serviceAccount.client_email,
            sub: serviceAccount.client_email,
            aud: oauthTokenUrl,
            iat: nowSec,
            exp: nowSec + 3600,
            target_audience: audience,
        };

        const unsigned = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(unsigned);
        signer.end();
        const signature = signer.sign(serviceAccount.private_key);
        const assertion = `${unsigned}.${base64urlEncode(signature)}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), getTimeoutMs());
        try {
            logger.log("[IdentityMapping] minting ID token", {
                context: contextLabel,
                audience,
                oauthTokenUrl: oauthTokenUrl,
                clientEmail: serviceAccount.client_email,
            });

            const body = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion,
            }).toString();

            const resp = await fetchImpl(oauthTokenUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
                signal: controller.signal,
            });
            if (!resp.ok) {
                const errBody = await resp.text().catch(() => "");
                logger.warn(`[IdentityMapping] token mint failed http ${resp.status}: ${errBody}`);
                return "";
            }

            const tokenPayload = await resp.json().catch(() => null);
            const idToken = String(tokenPayload?.id_token || "").trim();
            if (!idToken) {
                logger.warn("[IdentityMapping] token mint response missing id_token");
                return "";
            }

            const expEpochSec = decodeJwtExpEpochSec(idToken) || (nowSec + Number(tokenPayload?.expires_in || 3600));
            idTokenCacheByAudience.set(cacheKey, {
                token: idToken,
                expEpochSec,
            });
            logger.log("[IdentityMapping] ID token minted", {
                context: contextLabel,
                audience,
                tokenMask: maskToken(idToken),
                expiresInSec: Math.max(0, expEpochSec - nowSec),
            });
            return idToken;
        } catch (err) {
            logger.warn(`[IdentityMapping] token mint request error (${contextLabel}): ${err.message}`);
            return "";
        } finally {
            clearTimeout(timer);
        }
    }

    async function getBearerToken(baseUrl, contextLabel) {
        const audience = audienceForBaseUrl(baseUrl);
        if (serviceAccountJsonFileResolved) {
            const minted = await mintIdToken(audience, contextLabel);
            if (minted) return minted;
        }
        return readTokenFromFile();
    }

    return {
        logConfigOnce,
        getConfigSnapshot,
        getBearerToken,
    };
}

module.exports = {
    createIdentityMappingAuthService,
};
