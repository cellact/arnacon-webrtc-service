"use strict";

const DOMAINS = ["esimeratest.global", "esimera.global"];
const INTERNAL_TARGETS = ["esimeratest.global", "secnumtest.global", "secnum.global"];

function getDomains(helpers) {
    const configured = helpers.getServiceConstants()?.domains;
    return Array.isArray(configured) && configured.length ? configured : DOMAINS;
}

function resolveInboundValue(payload, helpers) {
    return (
        helpers.selectInboundLookupValue({
            payload,
            lookupField: "diversion",
        }) ||
        payload.to ||
        ""
    );
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
        const normalized = helpers.normalizePhone(parsedTo.value);
        const webrtcHit = await helpers.tryInternalWebrtcLookup(normalized, INTERNAL_TARGETS);
        if (webrtcHit) return webrtcHit;
        return { route: "sbc", number: normalized };
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

    if (parsedTo.type === "email") {
        const emailDomain = getDomains(helpers)[0] || "esimeratest.global";
        const emailEns = helpers.emailToEnsName(parsedTo.value, emailDomain);
        const addr = await helpers.lookupEnsAddress(emailEns);
        if (addr && addr !== helpers.zeroAddress) {
            return { route: "webrtc", wallet: addr, ensName: emailEns };
        }
        const domainPart = String(parsedTo.value || "").split("@")[1] || parsedTo.value;
        const businessNumber = await helpers.lookupBusinessNumber(domainPart);
        if (businessNumber) return { route: "sbc", number: businessNumber };
    }

    return { route: "reject", reason: `Unsupported destination type: ${parsedTo.type}` };
}

async function resolveCallerId(ctx) {
    const { parsedFrom, walletAddress, helpers } = ctx;
    const value = parsedFrom?.value || parsedFrom?.full || "";
    if (walletAddress) {
        const owned = await helpers.lookupNftOwnedNumber(walletAddress);
        if (owned) {
            return { callerId: owned, privateId: value };
        }
    }
    const pooled = await helpers.assignPoolFromNumber();
    return { callerId: pooled || null, privateId: value };
}

function normalizeIdentity(ctx) {
    return ctx.value;
}

async function shapeNotifyPayload(ctx) {
    return ctx.message;
}

module.exports = {
    id: "esimera",
    providerId: "esimera",
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
