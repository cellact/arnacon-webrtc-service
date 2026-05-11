"use strict";

const DOMAINS = ["phonemyemail.global"];

function getDomains(helpers) {
    const configured = helpers.getServiceConstants()?.domains;
    return Array.isArray(configured) && configured.length ? configured : DOMAINS;
}

function looksLikeBusinessDomain(value) {
    const target = String(value || "").trim().toLowerCase();
    return !!target && !/^[+*]?\d+$/.test(target) && !target.includes("@") && !target.endsWith(".global");
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
        const normalized = helpers.normalizePhone(parsedTo.value);
        if (looksLikeBusinessDomain(normalized)) {
            const businessNumber = await helpers.lookupBusinessNumberCascade(normalized);
            helpers.logRouteDecision?.({
                serviceId: "phonemyemail",
                route: "business-domain-cascade",
                target: normalized,
                result: businessNumber || null,
            });
            if (businessNumber) return { route: "sbc", number: businessNumber };
            return { route: "reject", reason: `No business mapping for ${normalized}` };
        }
        const webrtcHit = await helpers.tryInternalWebrtcLookup(normalized, helpers.getAllServiceDomains());
        if (webrtcHit) return webrtcHit;
        return { route: "sbc", number: normalized };
    }

    if (parsedTo.type === "ens") {
        const addr = await helpers.lookupEnsAddress(parsedTo.full);
        if (addr && addr !== helpers.zeroAddress) {
            return { route: "webrtc", wallet: addr, ensName: parsedTo.full };
        }
        return { route: "sbc", number: helpers.normalizePhone(parsedTo.value) };
    }

    return { route: "reject", reason: `Unsupported destination type: ${parsedTo.type}` };
}

async function resolveCallerId(ctx) {
    const { parsedFrom, walletAddress, helpers } = ctx;
    const value = parsedFrom?.value || parsedFrom?.full || "";
    const withProviderDomain = (callerId) => ({
        callerId,
        privateId: value,
        identity: {
            fromUser: `${callerId}.${getDomains(helpers)[0] || "phonemyemail.global"}`,
        },
    });
    if (walletAddress) {
        const owned = await helpers.lookupNftOwnedNumber(walletAddress);
        if (owned) {
            return withProviderDomain(owned);
        }
    }
    const pooled = await helpers.assignPoolFromNumber();
    return pooled ? withProviderDomain(pooled) : { callerId: null, privateId: value };
}

function normalizeIdentity(ctx) {
    return ctx.value;
}

async function shapeNotifyPayload(ctx) {
    return ctx.message;
}

module.exports = {
    id: "phonemyemail",
    providerId: "phonemyemail",
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
