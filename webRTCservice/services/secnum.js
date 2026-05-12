"use strict";

const DOMAINS = ["secnumtest.global", "secnum.global", "cellactm.global", "cellactl.global"];
const IVR_WAITING_AUDIO_FILE = "waiting.mp3";
const MULTIRING_CONFIG_BASE_URL = "https://lightpbx-save-config-343948402138.europe-west1.run.app";
const MULTIRING_CONFIG_TIMEOUT_MS = 2500;

function getDomains(helpers) {
    const configured = helpers.getServiceConstants()?.domains;
    return Array.isArray(configured) && configured.length ? configured : DOMAINS;
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

    // Handle either plain number ("972...") or ENS-like target
    // ("972....cellactm.global") by always taking the first label.
    const firstLabel = rawStr.includes(".") ? rawStr.split(".")[0] : rawStr;
    return helpers.normalizePhone(firstLabel);
}

async function resolveEnsWallet(helpers, ensName) {
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
        const wallet = await resolveEnsWallet(helpers, ensName);
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
    const candidates = helpers.buildInboundCandidates({
        value: targetValue,
        domains: getDomains(helpers),
    });
    for (const ensName of candidates) {
        const wallet = await resolveEnsWallet(helpers, ensName);
        if (wallet) {
            return { route: "webrtc", wallet, ensName, targetValue };
        }
    }
    return { route: "reject", reason: `No WebRTC user for ${targetValue}` };
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

    const multiRing = await buildConfiguredMultiRing(parsedTo, helpers);
    if (multiRing) return multiRing;

    if (parsedTo.type === "raw" || parsedTo.type === "unknown") {
        return { route: "sbc", number: helpers.normalizePhone(parsedTo.value) };
    }

    if (parsedTo.type === "ens") {
        const ownDomains = getDomains(helpers);
        if (ownDomains.includes(parsedTo.domain || "")) {
            const wallet = await resolveEnsWallet(helpers, parsedTo.full);
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
