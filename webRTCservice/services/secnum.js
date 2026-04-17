"use strict";

const DOMAINS = ["secnumtest.global", "secnum.global", "cellactm.global", "cellactl.global"];

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

    const parsed = helpers.parseIdentity(raw);
    if (parsed?.type === "ens") {
        return parsed.value || "";
    }
    return raw;
}

async function resolveInboundTarget(ctx) {
    const { payload, helpers } = ctx;
    const targetValue = resolveInboundValue(payload, helpers);
    const candidates = helpers.buildInboundCandidates({
        value: targetValue,
        domains: getDomains(helpers),
    });
    for (const ensName of candidates) {
        const addr = await helpers.lookupEnsAddress(ensName);
        if (addr && addr !== helpers.zeroAddress) {
            return { route: "webrtc", wallet: addr, ensName, targetValue };
        }
        // Some names may have no resolver addr record set, but still have a valid owner.
        // For inbound ringing, owner is enough to map to the connected wallet session.
        const owner = await helpers.lookupEnsOwner(ensName);
        if (owner && owner !== helpers.zeroAddress) {
            return { route: "webrtc", wallet: owner, ensName, targetValue };
        }
    }
    return { route: "reject", reason: `No WebRTC user for ${targetValue}` };
}

async function resolveDestination(ctx) {
    const { parsedTo, helpers } = ctx;
    if (!parsedTo) return { route: "reject", reason: "Missing destination" };

    if (parsedTo.type === "raw" || parsedTo.type === "unknown") {
        return { route: "sbc", number: helpers.normalizePhone(parsedTo.value) };
    }

    if (parsedTo.type === "ens") {
        const ownDomains = getDomains(helpers);
        if (ownDomains.includes(parsedTo.domain || "")) {
            const addr = await helpers.lookupEnsAddress(parsedTo.full);
            if (addr && addr !== helpers.zeroAddress) {
                return { route: "webrtc", wallet: addr, ensName: parsedTo.full };
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
