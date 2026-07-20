const crypto = require("crypto");
const ArnaconSDK = require("arnacon-sdk");

const EMAIL_IDENTITY = /^[a-f0-9]{64}\.email\.global$/;
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
                { cause },
            );
        }
    }
    if (!rawProvision || typeof rawProvision !== "object" || Array.isArray(rawProvision)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_PAYLOAD_INVALID",
            "LightPBX provision payload is missing or invalid",
        );
    }
    return rawProvision;
}

function toCanonicalRoute({ provisionIdentifier, provisionKey, provision }, expectedLabel) {
    const label = String(expectedLabel || "");
    if (provision.schema !== "arnacon.lightpbx.endpoint.v1") {
        throw new LightPbxProvisionError(
            "LIGHTPBX_SCHEMA_UNSUPPORTED",
            "Unsupported LightPBX provision schema",
        );
    }
    if (provision.kind !== "lightpbx_external_extension") {
        throw new LightPbxProvisionError(
            "LIGHTPBX_KIND_INVALID",
            "Unexpected LightPBX provision kind",
        );
    }
    if (String(provision.label) !== label) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_LABEL_MISMATCH",
            "LightPBX provision label does not match the called number",
        );
    }
    if (!OWNER_ADDRESS.test(String(provision.owner || ""))) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_OWNER_INVALID",
            "LightPBX provision owner is invalid",
        );
    }

    const type = String(provision.routing?.type || "").toUpperCase();
    if (!ROUTE_TYPES.has(type)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_ROUTE_UNSUPPORTED",
            `Unsupported LightPBX route type: ${type || "missing"}`,
        );
    }

    const rawTargets = provision.routing?.targets;
    if (rawTargets !== undefined && !Array.isArray(rawTargets)) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_TARGETS_INVALID",
            "LightPBX route targets must be an array",
        );
    }
    const targets = [...new Set((rawTargets || []).map((target) => String(target).toLowerCase()))];
    if (!targets.every((target) => EMAIL_IDENTITY.test(target))) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_TARGET_INVALID",
            "LightPBX provision contains an invalid target identity",
        );
    }
    if (type === "DIRECT" && targets.length !== 1) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_DIRECT_TARGET_COUNT",
            "LightPBX DIRECT routing requires exactly one target",
        );
    }
    if (type === "MULTI_RING" && targets.length < 1) {
        throw new LightPbxProvisionError(
            "LIGHTPBX_MULTIRING_TARGET_COUNT",
            "LightPBX MULTI_RING routing requires at least one target",
        );
    }

    return {
        source: "chain",
        provisionIdentifier,
        provisionKey,
        identity: provision.identity || null,
        owner: provision.owner,
        type,
        targets,
        groupId: provision.routing?.groupId || null,
        revision: provision.routing?.revision ?? null,
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
    tenantName = "cellact",
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

    const cache = new Map();

    function log(event, fields) {
        logger.log("[LightPBX]", { event, ...fields });
    }

    async function readUncached(label) {
        const provisionIdentifier = `lightpbx.${label}`.toLowerCase();
        const startedAt = now();
        let provisionKey;
        try {
            provisionKey = await sdk.getRecord(provisionIdentifier, tenantName);
        } catch (cause) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_RECORD_LOOKUP_FAILED",
                "LightPBX resolver lookup failed",
                { cause },
            );
        }

        if (!provisionKey) {
            log("lookup-miss", {
                label,
                provisionIdentifier,
                latencyMs: Math.max(0, now() - startedAt),
            });
            return null;
        }

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
        }, label);
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

    async function readLightPbxProvision(inputLabel) {
        const label = String(inputLabel || "").trim();
        if (!/^\d+$/.test(label)) {
            throw new LightPbxProvisionError(
                "LIGHTPBX_LABEL_INVALID",
                "Called destination is not a numeric LightPBX label",
                { statusCode: 400 },
            );
        }

        const cacheKey = `${tenantName}:${label}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expiresAt > now()) {
            log("cache-hit", {
                label,
                result: cached.value === null ? "miss" : "route",
            });
            return cached.value;
        }
        cache.delete(cacheKey);

        const route = await withTimeout(readUncached(label), Number(timeoutMs));
        cache.set(cacheKey, {
            value: route,
            expiresAt: now() + (route === null ? Number(missTtlMs) : Number(routeTtlMs)),
        });
        return route;
    }

    return {
        readLightPbxProvision,
        clearCache: () => cache.clear(),
    };
}

module.exports = {
    EMAIL_IDENTITY,
    LightPbxProvisionError,
    createLightPbxProvisionReader,
    parseProvision,
    toCanonicalRoute,
};
