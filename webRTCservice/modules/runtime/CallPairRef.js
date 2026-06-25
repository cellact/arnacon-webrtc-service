function identityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

function normalizeIdentityForKey(identity) {
    return identityLabel(String(identity || "").toLowerCase());
}

function createCallPairRef(caller, callee) {
    return {
        caller: caller || null,
        callee: callee || null,
    };
}

function pairKeyFromIdentities(a, b) {
    return [normalizeIdentityForKey(a), normalizeIdentityForKey(b)]
        .sort()
        .join("|");
}

function pairKeyFromRef(callPairRef) {
    if (!callPairRef) return pairKeyFromIdentities("", "");
    return pairKeyFromIdentities(callPairRef.caller, callPairRef.callee);
}

function normalizeSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== "string") return sessionId;
    if (!sessionId.includes("|")) return sessionId;
    return sessionId.split("|").map((part) => identityLabel(part)).join("|");
}

module.exports = {
    identityLabel,
    normalizeIdentityForKey,
    createCallPairRef,
    pairKeyFromIdentities,
    pairKeyFromRef,
    normalizeSessionId,
};
