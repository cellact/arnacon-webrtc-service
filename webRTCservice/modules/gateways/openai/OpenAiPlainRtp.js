const { RtpHeader, RtpPacket } = require("werift");
const { CRLF } = require("./OpenAiSipTransport");

const DEFAULT_RTP_PAYLOAD_TYPE = 0;

function parseSdpRemote(sdp) {
    const lines = String(sdp || "").split(/\r\n|\n/);
    let ip = "";
    let port = 0;
    let payloadType = DEFAULT_RTP_PAYLOAD_TYPE;

    for (const line of lines) {
        const c = line.match(/^c=IN IP4\s+(.+)$/i);
        if (c) ip = c[1].trim();

        const m = line.match(/^m=audio\s+(\d+)\s+RTP\/AVP\s+(.+)$/i);
        if (m) {
            port = Number(m[1]);
            const payloads = m[2].trim().split(/\s+/).map(Number).filter(Number.isFinite);
            if (payloads.includes(DEFAULT_RTP_PAYLOAD_TYPE)) payloadType = DEFAULT_RTP_PAYLOAD_TYPE;
            else if (payloads.length) payloadType = payloads[0];
        }
    }

    if (!ip || !port) return null;
    return { ip, port, payloadType };
}

function buildPlainRtpSdp({ mediaIp, mediaPort, sessionId, payloadType = DEFAULT_RTP_PAYLOAD_TYPE }) {
    const rtpmap = payloadType === 0 ? "PCMU/8000" : "PCMA/8000";
    return [
        "v=0",
        `o=arnacon ${Date.now()} 1 IN IP4 ${mediaIp}`,
        "s=Arnacon OpenAI SIP Bridge",
        `c=IN IP4 ${mediaIp}`,
        "t=0 0",
        `m=audio ${mediaPort} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${rtpmap}`,
        "a=ptime:20",
        "a=sendrecv",
        "",
    ].join(CRLF);
}

function cloneRtpHeaderForPlainRtp(header, payloadType) {
    return {
        ...header,
        padding: false,
        extension: false,
        extensions: [],
        extensionProfile: 0,
        csrc: [],
        csrcLength: 0,
        payloadType,
    };
}

function serializePlainRtp(packet, payloadType) {
    if (Buffer.isBuffer(packet)) return packet;
    if (!packet || !packet.header || !packet.payload) return null;

    const header = cloneRtpHeaderForPlainRtp(packet.header, payloadType);
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload || []);
    if (typeof RtpHeader === "function" && typeof RtpPacket === "function") {
        const cleanPacket = new RtpPacket(new RtpHeader(header), payload);
        if (typeof cleanPacket.serialize === "function") return cleanPacket.serialize();
    }
    if (typeof packet.serialize === "function") {
        packet.header = header;
        packet.payload = payload;
        return packet.serialize();
    }
    return null;
}

function deserializeRtpPacket(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (typeof RtpPacket?.deSerialize === "function") return RtpPacket.deSerialize(buffer);
    if (typeof RtpPacket?.deserialize === "function") return RtpPacket.deserialize(buffer);
    return null;
}

module.exports = {
    DEFAULT_RTP_PAYLOAD_TYPE,
    parseSdpRemote,
    buildPlainRtpSdp,
    serializePlainRtp,
    deserializeRtpPacket,
};
