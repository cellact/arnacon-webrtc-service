const DOMAINS = ["secnum.global", "secnumtest.global"];
const LIGHTPBX_DOMAIN = "secnumtest.global";
const IVR_WAITING_AUDIO_FILE = "waiting.mp3";
const FORCED_IVR_SIP_URI =
    process.env.SECNUM_FORCED_IVR_SIP_URI ||
    "sip:proj_7yVgTSBvJC4MpWvg257qY6kk@sip.api.openai.com;transport=tls";
const HARDCODED_OPENAI_INBOUND_DIDS = new Set(["972557012403"]);
const MULTIRING_CONFIG_BASE_URL = "https://lightpbx-save-config-343948402138.europe-west1.run.app";
const MULTIRING_CONFIG_TIMEOUT_MS = 2500;

function getDomains(helpers) {
    const configured = helpers.getServiceConstants()?.domains;
    if (!Array.isArray(configured) || configured.length === 0) return DOMAINS;
    const allowed = new Set(DOMAINS);
    const filtered = configured.map((domain) => String(domain || "").toLowerCase()).filter((domain) => allowed.has(domain));
    return filtered.length ? filtered : DOMAINS;
}

function resolveInboundValue(payload, helpers) {
    const raw =
        helpers.selectInboundLookupValue({
            payload,
            lookupField: "to",
        }) ||
        payload.to ||
        "";
    const rawStr = String(raw || "").trim();
    if (!rawStr) return "";

    // Handle either plain number ("972...") or ENS-like target by taking the first label only.
    const firstLabel = rawStr.includes(".") ? rawStr.split(".")[0] : rawStr;
    return helpers.normalizePhone(firstLabel);
}

function deriveWeb2Identity(value, helpers) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const firstLabel = raw.includes(".") ? raw.split(".")[0] : raw;
    const normalized = helpers.normalizePhone(firstLabel).replace(/\D/g, "");
    return /^\d+$/.test(normalized) ? normalized : "";
}

async function resolveEnsWallet(helpers, ensName, options = {}) {
    const web2identity = String(options.web2identity || deriveWeb2Identity(ensName, helpers)).trim();
    if (web2identity && typeof helpers.lookupWalletByWeb2Identity === "function") {
        const mapped = await helpers.lookupWalletByWeb2Identity(web2identity);
        if (mapped && mapped !== helpers.zeroAddress) {
            return mapped;
        }
    }
    const addr = await helpers.lookupEnsAddress(ensName);
    if (addr && addr !== helpers.zeroAddress) {
        return addr;
    }
    const owner = await helpers.lookupEnsOwner(ensName);
    if (owner && owner !== helpers.zeroAddress) {
        return owner;
    }
    return null;
}

function buildExactEnsCandidates(value, domains) {
    const target = String(value || "").trim().toLowerCase();
    if (!target) return [];
    if (target.endsWith(".global")) return [target];
    return domains.map((domain) => `${target}.${domain}`);
}

function lightPbxLookupContext(targetValue, payload) {
    if (!/^\d+$/.test(targetValue)) return null;
    const rawTo = String(payload?.to || "").trim().toLowerCase();
    const toDomain = String(payload?.toDomain || "").trim().toLowerCase();
    const expectedIdentity = `${targetValue}.${LIGHTPBX_DOMAIN}`;
    if (rawTo === expectedIdentity) {
        return { identity: expectedIdentity, provisionRequired: true };
    }
    if (rawTo === targetValue && toDomain === LIGHTPBX_DOMAIN) {
        return { identity: expectedIdentity, provisionRequired: true };
    }
    // The SBC commonly sends only the numeric DID, so the original SIP domain
    // is unavailable at this boundary. Probe LightPBX before legacy ENS routing;
    // a miss may still be a legacy Secnum DID, while a hit is authoritative.
    if (rawTo === targetValue && !toDomain) {
        return { identity: expectedIdentity, provisionRequired: false };
    }
    return null;
}

async function resolveLightPbxInbound(targetValue, lookupContext, payload, helpers) {
    if (!lookupContext || typeof helpers.readLightPbxProvision !== "function") {
        return null;
    }
    const { identity: fullIdentity, provisionRequired } = lookupContext;

    let provision;
    try {
        provision = await helpers.readLightPbxProvision(targetValue, fullIdentity);
    } catch (error) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "lightpbx-error",
            targetValue,
            callId: payload?.callId || null,
            errorCode: error.code || "LIGHTPBX_UNKNOWN_ERROR",
        });
        throw error;
    }

    if (!provision) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "lightpbx-unconfigured",
            targetValue,
            identity: fullIdentity,
            callId: payload?.callId || null,
        });
        // LightPBX is optional at runtime: if missing, continue with the
        // standard inbound routing flow (ENS/WebRTC lookup and downstream policy).
        // This prevents hard-failing regular calls just because a DID has no
        // LightPBX provision.
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: provisionRequired ? "lightpbx-unconfigured-fallback" : "lightpbx-miss-fallback",
            targetValue,
            identity: fullIdentity,
            callId: payload?.callId || null,
        });
        return null;
    }

    if (provision.type === "IVR") {
        // Keep LightPBX IVR routing type, but force the trunk target to the
        // configured OpenAI project URI used by runtime.
        const sipUri = FORCED_IVR_SIP_URI;
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "lightpbx-ivr",
            targetValue,
            callId: payload?.callId || null,
            provisionIdentifier: provision.provisionIdentifier,
            sipUri,
            revision: provision.revision,
        });
        return {
            route: "external-sip",
            sipUri,
            targetValue,
            routingSource: "lightpbx",
            routingRevision: provision.revision,
        };
    }

    if (provision.type === "DIRECT") {
        const ensName = provision.targets[0];
        const wallet = await resolveEnsWallet(helpers, ensName, { web2identity: targetValue });
        if (!wallet) {
            helpers.logRouteDecision?.({
                serviceId: "secnum",
                route: "lightpbx-direct-target-unavailable",
                targetValue,
                callId: payload?.callId || null,
                provisionIdentifier: provision.provisionIdentifier,
                ensName,
                revision: provision.revision,
            });
            return {
                route: "reject",
                statusCode: 404,
                reason: `LightPBX DIRECT target is unavailable for ${targetValue}`,
            };
        }

        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "lightpbx-direct",
            targetValue,
            callId: payload?.callId || null,
            provisionIdentifier: provision.provisionIdentifier,
            ensName,
            wallet,
            revision: provision.revision,
        });
        return {
            route: "webrtc",
            wallet,
            ensName,
            targetValue,
            routingSource: "lightpbx",
            routingRevision: provision.revision,
        };
    }

    const resolvedTargets = await Promise.all(provision.targets.map(async (ensName) => ({
        ensName,
        wallet: await resolveEnsWallet(helpers, ensName, { web2identity: deriveWeb2Identity(ensName, helpers) }),
    })));
    const targets = resolvedTargets.filter((target) => target.wallet);
    for (const target of resolvedTargets.filter((item) => !item.wallet)) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "lightpbx-multiring-target-skipped",
            targetValue,
            callId: payload?.callId || null,
            provisionIdentifier: provision.provisionIdentifier,
            ensName: target.ensName,
            revision: provision.revision,
        });
    }
    if (targets.length === 0) {
        return {
            route: "reject",
            statusCode: 404,
            reason: `No LightPBX MULTI_RING targets currently resolve for ${targetValue}`,
        };
    }
    helpers.logRouteDecision?.({
        serviceId: "secnum",
        route: "lightpbx-multiring",
        targetValue,
        callId: payload?.callId || null,
        provisionIdentifier: provision.provisionIdentifier,
        groupId: provision.groupId,
        resolvedTargetCount: targets.length,
        rejectedTargetCount: provision.rejectedTargetCount,
        revision: provision.revision,
    });
    return {
        route: "webrtc-multiring",
        mode: "first-verified-answer-wins",
        targets,
        groupId: provision.groupId,
        ruleId: `lightpbx:${targetValue}:v${provision.revision}`,
        targetValue,
        routingSource: "lightpbx",
        routingRevision: provision.revision,
    };
}

function normalizeMultiringEndpoint(value, helpers) {
    const firstLabel = String(value || "").trim().split(".")[0] || "";
    return helpers.normalizePhone(firstLabel).replace(/\D/g, "");
}

async function fetchMultiringConfig(endpoint, helpers) {
    if (!endpoint || typeof fetch !== "function") return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MULTIRING_CONFIG_TIMEOUT_MS);
    try {
        const url = `${MULTIRING_CONFIG_BASE_URL}/get_mutiring/${encodeURIComponent(endpoint)}`;
        const resp = await fetch(url, { method: "GET", signal: controller.signal });
        if (!resp.ok) {
            helpers.logRouteDecision?.({
                serviceId: "secnum",
                route: "multiring-config",
                endpoint,
                status: resp.status,
            });
            return null;
        }
        return await resp.json();
    } catch (err) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "multiring-config",
            endpoint,
            error: err.message,
        });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function extractMultiringEmails(config) {
    if (!config || config.ok === false || config.found === false) return [];
    if (config?.route?.type !== "multi_ring") return [];

    const directEmails = config?.route?.multiRing?.group?.selectedEmails;
    if (Array.isArray(directEmails)) return directEmails;

    const groupId = config?.route?.multiRing?.groupId;
    if (!groupId || !Array.isArray(config?.groups)) return [];
    const group = config.groups.find((item) => item?.id === groupId);
    return Array.isArray(group?.selectedEmails) ? group.selectedEmails : [];
}

function multiringTargetToEnsName(target, helpers, targetDomain) {
    const value = String(target || "").trim().toLowerCase();
    if (!value) return null;

    if (value.includes("@") && !value.endsWith(".global")) {
        return helpers.emailToEnsName(helpers.normalizeEmail(value), targetDomain);
    }

    if (value.endsWith(".global")) {
        return value;
    }

    const normalizedPhone = helpers.normalizePhone(value).replace(/\D/g, "");
    if (normalizedPhone) {
        return `${normalizedPhone}.${targetDomain}`;
    }

    return null;
}

async function buildConfiguredMultiRing(parsedTo, helpers) {
    const rawTarget = helpers.normalizePhone(parsedTo?.value || parsedTo?.full || "");
    if (!/^\d+$/.test(rawTarget)) return null;

    const endpoint = normalizeMultiringEndpoint(rawTarget, helpers);
    if (!endpoint) return null;

    const config = await fetchMultiringConfig(endpoint, helpers);
    const ringTargets = extractMultiringEmails(config)
        .map((target) => String(target || "").trim())
        .filter(Boolean);
    if (ringTargets.length === 0) return null;

    const targetDomain = getDomains(helpers)[0];
    const targets = [];
    const seenEnsNames = new Set();
    for (const ringTarget of ringTargets) {
        const ensName = multiringTargetToEnsName(ringTarget, helpers, targetDomain);
        if (!ensName || seenEnsNames.has(ensName)) continue;
        seenEnsNames.add(ensName);
        const wallet = await resolveEnsWallet(helpers, ensName, { web2identity: endpoint });
        if (!wallet) continue;
        targets.push({ wallet, ensName });
    }

    if (targets.length === 0) {
        return { route: "reject", reason: "Multiring configured but no target wallet resolved" };
    }

    return {
        route: "webrtc-multiring",
        mode: "first-verified-answer-wins",
        targets,
        ruleId: `gcp-secnum-multiring:${endpoint}`,
    };
}

async function resolveInboundTarget(ctx) {
    const { payload, helpers } = ctx;
    const targetValue = resolveInboundValue(payload, helpers);
    if (!targetValue) {
        return {
            route: "reject",
            reason: `No WebRTC user for (target empty, raw to='${String(payload?.to || "")}')`,
        };
    }
    if (HARDCODED_OPENAI_INBOUND_DIDS.has(targetValue)) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "hardcoded-openai-inbound",
            targetValue,
            callId: payload?.callId || null,
            sipUri: FORCED_IVR_SIP_URI,
        });
        return {
            route: "external-sip",
            sipUri: FORCED_IVR_SIP_URI,
            targetValue,
            routingSource: "hardcoded-openai-inbound",
        };
    }
    const lightPbxLookup = lightPbxLookupContext(targetValue, payload);
    const lightPbxTarget = await resolveLightPbxInbound(
        targetValue,
        lightPbxLookup,
        payload,
        helpers,
    );
    if (lightPbxTarget) return lightPbxTarget;

    const inboundDomain = String(payload?.toDomain || "").trim().toLowerCase();
    const allowedDomains = new Set(getDomains(helpers));
    const domains = Array.from(new Set([
        allowedDomains.has(inboundDomain) ? inboundDomain : null,
        ...getDomains(helpers),
    ].filter(Boolean)));
    const candidates = buildExactEnsCandidates(targetValue, domains);
    for (const ensName of candidates) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "inbound-webrtc-check",
            targetValue,
            toDomain: inboundDomain || null,
            ensName,
        });
        const wallet = await resolveEnsWallet(helpers, ensName, { web2identity: targetValue });
        if (wallet) {
            helpers.logRouteDecision?.({
                serviceId: "secnum",
                route: "inbound-webrtc-found",
                targetValue,
                toDomain: inboundDomain || null,
                ensName,
                wallet,
            });
            return { route: "webrtc", wallet, ensName, targetValue };
        }
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "inbound-webrtc-miss",
            targetValue,
            toDomain: inboundDomain || null,
            ensName,
            wallet: null,
        });
    }
    return { route: "reject", reason: `No WebRTC user for ${targetValue}` };
}

async function resolveNumberAsOwnServiceTarget(parsedTo, helpers) {
    const rawValue = parsedTo?.value || parsedTo?.full || "";
    const targetValue = helpers.normalizePhone(rawValue).replace(/\D/g, "");
    if (!targetValue) return null;

    const candidates = buildExactEnsCandidates(targetValue, getDomains(helpers));
    for (const ensName of candidates) {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "number-to-own-webrtc-check",
            targetValue,
            ensName,
        });
        const wallet = await resolveEnsWallet(helpers, ensName, { web2identity: targetValue });
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: wallet ? "number-to-own-webrtc-found" : "number-to-own-webrtc-miss",
            targetValue,
            ensName,
            wallet: wallet || null,
        });
        if (wallet) {
            helpers.logRouteDecision?.({
                serviceId: "secnum",
                route: "number-to-own-webrtc",
                targetValue,
                ensName,
            });
            return { route: "webrtc", wallet, ensName, targetValue };
        }
    }
    helpers.logRouteDecision?.({
        serviceId: "secnum",
        route: "number-to-own-webrtc-none",
        targetValue,
        candidates,
    });
    helpers.logRouteDecision?.({
        serviceId: "secnum",
        route: "number-to-sbc-fallback",
        targetValue,
    });
    return null;
}

async function resolveDestination(ctx) {
    const { parsedTo, parsedFrom, helpers } = ctx;
    if (!parsedTo) return { route: "reject", reason: "Missing destination" };

    const normalizedTarget = helpers.normalizePhone(parsedTo.value || parsedTo.full || "");
    if (normalizedTarget === "2006") {
        return {
            route: "ivr",
            providerId: "secnum",
            target: "2006",
            waitingAudioFile: IVR_WAITING_AUDIO_FILE,
        };
    }
    if (normalizedTarget === "2005") {
        return { route: "openai-sip", number: "2005", target: "openai-realtime" };
    }

    if (parsedTo.type === "raw" || parsedTo.type === "unknown") {
        const ownNumberTarget = await resolveNumberAsOwnServiceTarget(parsedTo, helpers);
        if (ownNumberTarget) return ownNumberTarget;
    }

    const multiRing = await buildConfiguredMultiRing(parsedTo, helpers);
    if (multiRing) return multiRing;

    if (parsedTo.type === "raw" || parsedTo.type === "unknown") {
        helpers.logRouteDecision?.({
            serviceId: "secnum",
            route: "raw-destination-sbc-fallback",
            targetValue: helpers.normalizePhone(parsedTo.value),
        });
        return { route: "sbc", number: helpers.normalizePhone(parsedTo.value) };
    }

    if (parsedTo.type === "ens") {
        const ownDomains = getDomains(helpers);
        if (ownDomains.includes(parsedTo.domain || "")) {
            const wallet = await resolveEnsWallet(helpers, parsedTo.full, {
                web2identity: deriveWeb2Identity(parsedTo.full, helpers),
            });
            if (wallet) {
                return { route: "webrtc", wallet, ensName: parsedTo.full };
            }
        }
        return { route: "sbc", number: helpers.normalizePhone(parsedTo.value) };
    }

    return { route: "reject", reason: `Unsupported destination type: ${parsedTo.type}` };
}

async function resolveCallerId(ctx) {
    const { parsedFrom, helpers } = ctx;
    const value = parsedFrom?.value || parsedFrom?.full || "";
    const callerId = helpers.normalizePhone(value);
    return {
        callerId,
        privateId: null,
        identity: parsedFrom?.full
            ? { fromUser: parsedFrom.full }
            : null,
    };
}

function normalizeIdentity(ctx) {
    return ctx.value;
}

async function shapeNotifyPayload(ctx) {
    return ctx.message;
}

module.exports = {
    id: "secnum",
    providerId: "secnum",
    primaryDomain: DOMAINS[0],
    domainAliases: DOMAINS.slice(1),
    ivrWaitingAudioFile: IVR_WAITING_AUDIO_FILE,
    resolveDestination,
    resolveCallerId,
    resolveInboundTarget,
    normalizeIdentity,
    shapeNotifyPayload,
    hooks: {
        normalizeIncomingPayload(payload) {
            return payload;
        },
        normalizeInboundCallbackPayload(payload) {
            return payload;
        },
    },
};
