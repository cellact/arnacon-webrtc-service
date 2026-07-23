const crypto = require("crypto");
const ArnaconSDK = require("arnacon-sdk");

const EMAIL_IDENTITY = /^[a-f0-9]{64}\.email\.global$/;
const OPENAI_SIP_TARGET = /^sip:(proj_[A-Za-z0-9]+)@sip\.api\.openai\.com;transport=tls$/;
const OWNER_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ROUTE_TYPES = new Set(["DIRECT", "MULTI_RING", "IVR"]);
const REQUIRED_CONTRACTS = ["ENSRegistry", "PublicResolver", "ProvisionRegistry"];

class LightPbxProvisionError extends Error {
    constructor(code, message, { cause = null, statusCode = 503 } = {}) {
        super(message);
        this.name = "LightPbxProvisionError";
        this.code = code;
        this.statusCode = statusCode;
        if (cause) this.cause = cause;
    }
}

function requireConfig(condition, message) {
    if (!condition) {
        throw new LightPbxProvisionError("LIGHTPBX_CONFIG_INVALID", message);
    }
}

function validateContractAddresses(contractAddresses) {
    requireConfig(
        contractAddresses && typeof contractAddresses === "object" && !Array.isArray(contractAddresses),
        "LightPBX contract address map is required",
    );
    for (const name of REQUIRED_CONTRACTS) {
        const value = String(contractAddresses[name] || "");
        requireConfig(
            /^0x[a-fA-F0-9]{40}$/.test(value),
            `LightPBX contract address '${name}' is missing or invalid`,
        );
    }
}

function parseProvision(rawProvision) {
    if (typeof rawProvision === "string") {
        try {
            return JSON.parse(rawProvision);
        } catch (cause) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_PAYLOAD_INVALID_JSON",
                "LightPBX provision payload is not valid JSON",
                { cause, statusCode: 422 },
            );
        }
    }
    if (!rawProvision || typeof rawProvision !== "object" || Array.isArray(rawProvision)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_PAYLOAD_INVALID",
            "LightPBX provision payload is missing or invalid",
            { statusCode: 422 },
        );
    }
    return rawProvision;
}

function toCanonicalRoute(
    { provisionIdentifier, provisionKey, provision },
    { expectedLabel, expectedIdentity },
) {
    const label = String(expectedLabel || "");
    const identity = String(expectedIdentity || "").toLowerCase();
    if (provision.schema !== "arnacon.lightpbx.endpoint.v1") {
        throw new LightPbxProvisionError(
            "LIGHTPBX_SCHEMA_UNSUPPORTED",
            "Unsupported LightPBX provision schema",
            { statusCode: 422 },
        );
    }
    if (provision.kind !== "lightpbx_external_extension") {
        throw new LightPbxProvisionError(
            "LIGHTPBX_KIND_INVALID",
            "Unexpected LightPBX provision kind",
            { statusCode: 422 },
        );
    }
    if (String(provision.label) !== label) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_LABEL_MISMATCH",
            "LightPBX provision label does not match the called number",
            { statusCode: 422 },
        );
    }
    if (String(provision.identity || "").toLowerCase() !== identity) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_IDENTITY_MISMATCH",
            "LightPBX provision identity does not match the called identity",
            { statusCode: 422 },
        );
    }
    if (String(provision.provider || "").toLowerCase() !== "cellact") {
        throw new LightPbxProvisionError(
            "LIGHTPBX_PROVIDER_INVALID",
            "LightPBX provision provider is invalid",
            { statusCode: 422 },
        );
    }
    if (!OWNER_ADDRESS.test(String(provision.owner || ""))) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_OWNER_INVALID",
            "LightPBX provision owner is invalid",
            { statusCode: 422 },
        );
    }

    const type = String(provision.routing?.type || "").toUpperCase();
    if (!ROUTE_TYPES.has(type)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_ROUTE_UNSUPPORTED",
            `Unsupported LightPBX route type: ${type || "missing"}`,
            { statusCode: 422 },
        );
    }

    const rawTargets = provision.routing?.targets;
    if (rawTargets !== undefined && !Array.isArray(rawTargets)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_TARGETS_INVALID",
            "LightPBX route targets must be an array",
            { statusCode: 422 },
        );
    }
    const rawTargetValues = (rawTargets || []).map((target) => String(target).trim());
    if (type === "DIRECT" && rawTargetValues.length !== 1) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_DIRECT_TARGET_COUNT",
            "LightPBX DIRECT routing requires exactly one target",
            { statusCode: 422 },
        );
    }
    if (type === "MULTI_RING" && (rawTargetValues.length < 1 || rawTargetValues.length > 5)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_MULTIRING_TARGET_COUNT",
            "LightPBX MULTI_RING routing requires between one and five targets",
            { statusCode: 422 },
        );
    }
    if (type === "IVR" && rawTargetValues.length !== 1) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_IVR_TARGET_COUNT",
            "LightPBX IVR routing requires exactly one SIP target",
            { statusCode: 422 },
        );
    }

    let targets;
    let rejectedTargetCount;
    if (type === "IVR") {
        const match = OPENAI_SIP_TARGET.exec(rawTargetValues[0] || "");
        if (!match) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_IVR_TARGET_INVALID",
                "LightPBX IVR target must be an OpenAI project SIP URI over TLS",
                { statusCode: 422 },
            );
        }
        targets = [`sip:${match[1]}@sip.api.openai.com;transport=tls`];
        rejectedTargetCount = 0;
    } else {
        const normalizedTargets = rawTargetValues.map((target) => target.toLowerCase());
        targets = [...new Set(normalizedTargets.filter((target) => EMAIL_IDENTITY.test(target)))];
        rejectedTargetCount = normalizedTargets.length - targets.length;
    }
    if (targets.length === 0 || (type === "DIRECT" && rejectedTargetCount > 0)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_TARGET_INVALID",
            "LightPBX provision has no valid target identities",
            { statusCode: 422 },
        );
    }
    const revision = Number(provision.routing?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_REVISION_INVALID",
            "LightPBX routing revision is invalid",
            { statusCode: 422 },
        );
    }

    return {
        source: "chain",
        provisionIdentifier,
        provisionKey,
        identity,
        owner: provision.owner,
        type,
        targets,
        rejectedTargetCount,
        groupId: provision.routing?.groupId || null,
        revision,
        configHash: provision.routing?.configHash || null,
    };
}

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new LightPbxProvisionError(
                "LIGHTPBX_LOOKUP_TIMEOUT",
                `LightPBX provision lookup exceeded ${timeoutMs}ms`,
            ));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createLightPbxProvisionReader({
    rpcUrl,
    contractAddresses,
    tenantName = "secnumtest",
    chainId = 137,
    timeoutMs = 1200,
    routeTtlMs = 45000,
    missTtlMs = 10000,
    sdkFactory = (config) => new ArnaconSDK(config),
    logger = console,
    now = () => Date.now(),
} = {}) {
    requireConfig(typeof rpcUrl === "string" && rpcUrl.trim(), "LightPBX Polygon RPC URL is required");
    requireConfig(/^[a-z0-9-]+$/i.test(tenantName), "LightPBX tenant name is invalid");
    requireConfig(Number.isFinite(Number(chainId)), "LightPBX chain ID is invalid");
    requireConfig(Number(timeoutMs) > 0, "LightPBX lookup timeout must be positive");
    validateContractAddresses(contractAddresses);

    const sdk = sdkFactory({ chainId: Number(chainId), rpcUrl: rpcUrl.trim() });
    requireConfig(sdk && typeof sdk.setContractAddresses === "function", "Arnacon SDK is invalid");
    requireConfig(typeof sdk.getRecord === "function", "Arnacon SDK getRecord() is unavailable");
    requireConfig(typeof sdk.getProvision === "function", "Arnacon SDK getProvision() is unavailable");
    sdk.setContractAddresses(contractAddresses);

    const provisionCache = new Map();
    const missCache = new Map();
    const highestRevisionByIdentity = new Map();

    function log(event, fields) {
        logger.log("[LightPBX]", { event, ...fields });
    }

    async function resolveProvisionKey(label) {
        try {
            return await sdk.getRecord(`lightpbx.${label}`.toLowerCase(), tenantName);
        } catch (cause) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_RECORD_LOOKUP_FAILED",
                "LightPBX resolver lookup failed",
                { cause },
            );
        }
    }

    async function fetchProvision({ label, expectedIdentity, provisionIdentifier, provisionKey }) {
        let rawProvision;
        try {
            rawProvision = await sdk.getProvision(tenantName, provisionIdentifier);
        } catch (cause) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_PAYLOAD_LOOKUP_FAILED",
                "LightPBX provision payload lookup failed",
                { cause },
            );
        }
        if (rawProvision === null || rawProvision === undefined || rawProvision === "") {
            throw new LightPbxProvisionError(
                "LIGHTPBX_PAYLOAD_MISSING",
                "LightPBX resolver key exists but its provision payload is unavailable",
            );
        }

        const route = toCanonicalRoute({
            provisionIdentifier,
            provisionKey,
            provision: parseProvision(rawProvision),
        }, {
            expectedLabel: label,
            expectedIdentity,
        });
        const highestRevision = highestRevisionByIdentity.get(expectedIdentity);
        if (highestRevision !== undefined && route.revision < highestRevision) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_REVISION_ROLLBACK",
                "LightPBX resolver points to an older routing revision",
                { statusCode: 422 },
            );
        }
        highestRevisionByIdentity.set(
            expectedIdentity,
            Math.max(highestRevision ?? route.revision, route.revision),
        );
        return route;
    }

    async function readUncached(label, expectedIdentity) {
        const provisionIdentifier = `lightpbx.${label}`.toLowerCase();
        const startedAt = now();
        const provisionKey = await resolveProvisionKey(label);

        if (!provisionKey) {
            log("lookup-miss", {
                label,
                provisionIdentifier,
                latencyMs: Math.max(0, now() - startedAt),
            });
            return null;
        }

        const provisionCacheKey = `${expectedIdentity}:${String(provisionKey)}`;
        const cached = provisionCache.get(provisionCacheKey);
        let route;
        if (cached && cached.expiresAt > now()) {
            route = cached.route;
            const highestRevision = highestRevisionByIdentity.get(expectedIdentity);
            if (highestRevision !== undefined && route.revision < highestRevision) {
                throw new LightPbxProvisionError(
                    "LIGHTPBX_REVISION_ROLLBACK",
                    "LightPBX resolver points to an older routing revision",
                    { statusCode: 422 },
                );
            }
            log("provision-cache-hit", {
                label,
                provisionIdentifier,
                provisionKeyHash: crypto.createHash("sha256").update(String(provisionKey)).digest("hex").slice(0, 12),
                revision: route.revision,
            });
        } else {
            route = await fetchProvision({
                label,
                expectedIdentity,
                provisionIdentifier,
                provisionKey,
            });
            provisionCache.set(provisionCacheKey, {
                route,
                expiresAt: now() + Number(routeTtlMs),
            });
        }
        log("lookup-hit", {
            label,
            provisionIdentifier,
            provisionKeyHash: crypto.createHash("sha256").update(String(provisionKey)).digest("hex").slice(0, 12),
            routeType: route.type,
            revision: route.revision,
            targetCount: route.targets.length,
            latencyMs: Math.max(0, now() - startedAt),
        });
        return route;
    }

    async function readLightPbxProvision(inputLabel, inputIdentity = null) {
        const label = String(inputLabel || "").trim();
        if (!/^\d+$/.test(label)) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_LABEL_INVALID",
                "Called destination is not a numeric LightPBX label",
                { statusCode: 400 },
            );
        }
        const expectedIdentity = String(
            inputIdentity || `${label}.${tenantName}.global`,
        ).trim().toLowerCase();
        if (expectedIdentity !== `${label}.${tenantName}.global`) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_CALLED_IDENTITY_INVALID",
                "Called identity is not an exact LightPBX number identity",
                { statusCode: 400 },
            );
        }

        const cachedMiss = missCache.get(expectedIdentity);
        if (cachedMiss && cachedMiss.expiresAt > now()) {
            log("cache-hit", {
                label,
                result: "miss",
            });
            return null;
        }
        missCache.delete(expectedIdentity);

        const route = await withTimeout(
            readUncached(label, expectedIdentity),
            Number(timeoutMs),
        );
        if (route === null) {
            missCache.set(expectedIdentity, {
                expiresAt: now() + Math.min(Number(missTtlMs), 10000),
            });
        }
        return route;
    }

    return {
        readLightPbxProvision,
        clearCache: () => {
            provisionCache.clear();
            missCache.clear();
            highestRevisionByIdentity.clear();
        },
    };
}

module.exports = {
    EMAIL_IDENTITY,
    LightPbxProvisionError,
    createLightPbxProvisionReader,
    parseProvision,
    toCanonicalRoute,
};
