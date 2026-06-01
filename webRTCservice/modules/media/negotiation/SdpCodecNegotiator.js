const { payloadsForPolicy } = require("./CodecPolicy");

function narrowAudioOfferToPayloads(sdp, allowedPayloads) {
    if (!sdp || !sdp.includes("m=audio")) return sdp;
    const allowedPayloadSet = new Set((allowedPayloads || []).map(String));
    if (allowedPayloadSet.size === 0) return sdp;
    const sections = sdp.split(/\r\n(?=m=)/);
    return sections.map((section) => {
        if (!section.startsWith("m=audio")) return section;
        const lines = section.split(/\r\n/);
        const mLine = lines[0].split(" ");
        const payloads = mLine.slice(3).filter((pt) => allowedPayloadSet.has(pt));
        if (!payloads.length) return section;

        const allowed = new Set(payloads);
        const filtered = lines.filter((line, index) => {
            if (index === 0) return true;
            const payloadMatch = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:\s|$)/);
            return !payloadMatch || allowed.has(payloadMatch[1]);
        });
        filtered[0] = [...mLine.slice(0, 3), ...payloads].join(" ");
        return filtered.join("\r\n");
    }).join("\r\n");
}

function narrowAudioOfferForCodecPolicy(sdp, codecPolicy) {
    const payloads = payloadsForPolicy(codecPolicy);
    return payloads ? narrowAudioOfferToPayloads(sdp, payloads) : sdp;
}

function getPrimaryAudioPayload(sdp) {
    const audioSection = String(sdp || "").match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
    const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
    return mLine.split(/\s+/).slice(3)[0] || null;
}

function exactG711PolicyFromAnswer(answerSdp) {
    const primaryPt = getPrimaryAudioPayload(answerSdp);
    if (primaryPt === "0") return "pcmu";
    if (primaryPt === "8") return "pcma";
    return null;
}

module.exports = {
    narrowAudioOfferToPayloads,
    narrowAudioOfferForCodecPolicy,
    getPrimaryAudioPayload,
    exactG711PolicyFromAnswer,
};
