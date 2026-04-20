"use strict";

const DOMAINS = ["secnumtest.global", "secnum.global", "cellactm.global", "cellactl.global"];
const HARD_CODED_MULTI_RING = {
    callerEns: "972111000.secnumtest.global",
    ringTargets: [
        "9726767.secnumtest.global",
        "972420420.secnumtest.global",
    ],
};

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

async function buildHardcodedMultiRing(parsedFrom, helpers) {
    const fromEns = String(parsedFrom?.full || "").toLowerCase();
    if (fromEns !== HARD_CODED_MULTI_RING.callerEns) {
        return null;
    }

    const targets = [];
    for (const ensName of HARD_CODED_MULTI_RING.ringTargets) {
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
        ruleId: "hardcoded-secnumtest-972111000",
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

    const multiRing = await buildHardcodedMultiRing(parsedFrom, helpers);
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
    const { parsedFrom } = ctx;
    const value = parsedFrom?.value || parsedFrom?.full || "";
    return { callerId: parsedFrom?.full || value, privateId: null };
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
