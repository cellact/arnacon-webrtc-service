const { MediaLeg } = require("../MediaLeg");

class OpenAiSipLeg extends MediaLeg {
    constructor({
        call,
        remoteMedia,
        offeredPayloadType = 0,
        serializePlainRtp,
        deserializeRtpPacket,
        logger = console,
    } = {}) {
        super({
            id: call?.sessionId,
            kind: "openai-sip",
            payloadType: Number.isFinite(remoteMedia?.payloadType) ? remoteMedia.payloadType : offeredPayloadType,
            logger,
        });
        if (!call) throw new Error("OpenAiSipLeg requires call");
        if (!remoteMedia) throw new Error("OpenAiSipLeg requires remoteMedia");
        if (typeof serializePlainRtp !== "function") throw new Error("OpenAiSipLeg requires serializePlainRtp");
        if (typeof deserializeRtpPacket !== "function") throw new Error("OpenAiSipLeg requires deserializeRtpPacket");
        this.call = call;
        this.remoteMedia = remoteMedia;
        this.offeredPayloadType = offeredPayloadType;
        this.serializePlainRtp = serializePlainRtp;
        this.deserializeRtpPacket = deserializeRtpPacket;
    }

    onRtp(handler) {
        const onMessage = (buffer) => {
            if (!this.active) return;
            const packet = this.deserializeRtpPacket(buffer);
            if (!packet) return;
            this.noteInbound();
            handler(packet);
        };
        this.call.rtpSocket.on("message", onMessage);
        const dispose = () => {
            try { this.call.rtpSocket.off("message", onMessage); } catch (_) {}
        };
        this.addDisposer(dispose);
        return dispose;
    }

    writeRtp(packet) {
        const outboundPayloadType = Number.isFinite(this.remoteMedia.payloadType)
            ? this.remoteMedia.payloadType
            : this.offeredPayloadType;
        const raw = this.serializePlainRtp(packet, outboundPayloadType);
        if (!raw) return;
        this.call.rtpSocket.send(raw, this.remoteMedia.port, this.remoteMedia.ip);
        this.noteOutbound();
    }
}

module.exports = {
    OpenAiSipLeg,
};
