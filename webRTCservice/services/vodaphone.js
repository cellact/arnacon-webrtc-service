"use strict";

const DOMAINS = ["vodaphonetest.global", "vodaphone.global"];

function getDomains(helpers) {
    const configured = helpers.getServiceConstants()?.domains;
    return Array.isArray(configured) && configured.length ? configured : DOMAINS;
}

async function resolveInboundTarget(ctx) {
    const { payload, helpers } = ctx;
    const targetValue = helpers.selectInboundLookupValue({
        payload,
        lookupField: "to",
    }) || payload.to || "";
    const candidates = helpers.buildInboundCandidates({
        value: targetValue,
        domains: getDomains(helpers),
    });
    for (const ensName of candidates) {
        const addr = await helpers.lookupEnsAddress(ensName);
        if (addr && addr !== helpers.zeroAddress) {
            return { route: "webrtc", wallet: addr, ensName, targetValue };
        }
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
    return { callerId: parsedFrom?.full || value, privateId: value };
}

function normalizeIdentity(ctx) {
    return ctx.value;
}

async function shapeNotifyPayload(ctx) {
    return ctx.message;
}

module.exports = {
    id: "vodaphone",
    providerId: "vodaphone",
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
