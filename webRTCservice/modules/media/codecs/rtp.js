const { RTP_PT_PCMA, RTP_PT_PCMU, transcodeG711Payload } = require("./g711");

function parsePrimaryAudioPayloadType(sdp) {
    const audioSection = String(sdp || "").match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
    const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
    const pt = Number(mLine.split(/\s+/).slice(3)[0]);
    return Number.isFinite(pt) ? pt : null;
}

function payloadTypeFromCodecPolicy(policy) {
    if (policy === "pcmu") return RTP_PT_PCMU;
    if (policy === "pcma") return RTP_PT_PCMA;
    return null;
}

function codecPolicyFromPayloadType(payloadType) {
    const pt = Number(payloadType);
    if (pt === RTP_PT_PCMU) return "pcmu";
    if (pt === RTP_PT_PCMA) return "pcma";
    return null;
}

function derivePeerConnectionPayloadType(pc) {
    return (
        parsePrimaryAudioPayloadType(pc?.remoteDescription?.sdp) ??
        parsePrimaryAudioPayloadType(pc?.localDescription?.sdp)
    );
}

function deriveSessionPayloadType(session) {
    const fromPolicy = payloadTypeFromCodecPolicy(session?.mediaCodecPolicy);
    if (fromPolicy !== null) return fromPolicy;
    return derivePeerConnectionPayloadType(session?.peerConnection);
}

function cloneRtpPacketWithPayload(packet, payloadType, payload = packet?.payload) {
    if (!packet || !packet.header) return packet;
    const out = Object.assign(Object.create(Object.getPrototypeOf(packet)), packet);
    out.header = Object.assign(Object.create(Object.getPrototypeOf(packet.header)), packet.header);
    out.header.payloadType = Number(payloadType);
    out.payload = payload;
    return out;
}

function adaptRtpPayloadType(packet, targetPayloadType) {
    if (targetPayloadType === null || targetPayloadType === undefined) return packet;
    const sourcePayloadType = Number(packet?.header?.payloadType);
    const targetPt = Number(targetPayloadType);
    if (!packet || !packet.header || !Number.isFinite(sourcePayloadType) || !Number.isFinite(targetPt)) {
        return packet;
    }
    if (sourcePayloadType === targetPt) return packet;

    const convertedPayload = transcodeG711Payload(packet.payload, sourcePayloadType, targetPt);
    if (convertedPayload === packet.payload && !(
        (sourcePayloadType === RTP_PT_PCMU && targetPt === RTP_PT_PCMA) ||
        (sourcePayloadType === RTP_PT_PCMA && targetPt === RTP_PT_PCMU)
    )) {
        return packet;
    }

    return cloneRtpPacketWithPayload(packet, targetPt, convertedPayload);
}

module.exports = {
    parsePrimaryAudioPayloadType,
    payloadTypeFromCodecPolicy,
    codecPolicyFromPayloadType,
    derivePeerConnectionPayloadType,
    deriveSessionPayloadType,
    cloneRtpPacketWithPayload,
    adaptRtpPayloadType,
};
