const CODEC_POLICIES = Object.freeze({
    Opus: "opus",
    Pcma: "pcma",
    Pcmu: "pcmu",
    G711: "g711",
});

function routeToCodecPolicy(destination, { isInbound = false } = {}) {
    if (isInbound) return null;
    if (destination?.route === "sbc") return CODEC_POLICIES.Pcma;
    if (destination?.route === "openai-sip") return CODEC_POLICIES.Pcmu;
    if (destination?.route === "ivr") return CODEC_POLICIES.G711;
    if (destination?.route === "webrtc" || destination?.route === "webrtc-multiring") return CODEC_POLICIES.Pcma;
    return null;
}

function payloadsForPolicy(policy) {
    if (policy === CODEC_POLICIES.Opus) return ["111"];
    if (policy === CODEC_POLICIES.Pcma) return ["8"];
    if (policy === CODEC_POLICIES.Pcmu) return ["0"];
    if (policy === CODEC_POLICIES.G711) return ["0", "8"];
    return null;
}

function labelForPolicy(policy) {
    if (policy === CODEC_POLICIES.Opus) return "OPUS";
    if (policy === CODEC_POLICIES.Pcma) return "PCMA";
    if (policy === CODEC_POLICIES.Pcmu) return "PCMU";
    if (policy === CODEC_POLICIES.G711) return "PCMU/PCMA";
    return "unknown";
}

module.exports = {
    CODEC_POLICIES,
    routeToCodecPolicy,
    payloadsForPolicy,
    labelForPolicy,
};
