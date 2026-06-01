class MediaLeg {
    constructor({
        id,
        kind,
        codec = null,
        payloadType = null,
        logger = console,
    } = {}) {
        if (!id) throw new Error("MediaLeg requires id");
        if (!kind) throw new Error("MediaLeg requires kind");
        this.id = id;
        this.kind = kind;
        this.codec = codec;
        this.payloadType = Number.isFinite(Number(payloadType)) ? Number(payloadType) : null;
        this.logger = logger;
        this.active = false;
        this.disposers = [];
        this.stats = {
            inboundPackets: 0,
            outboundPackets: 0,
            lastInboundAt: null,
            lastOutboundAt: null,
            startedAt: null,
            stoppedAt: null,
        };
    }

    async start() {
        this.active = true;
        this.stats.startedAt = Date.now();
        this.stats.stoppedAt = null;
    }

    async stop() {
        this.active = false;
        this.stats.stoppedAt = Date.now();
        for (const dispose of this.disposers.splice(0)) {
            try { dispose(); } catch (_) {}
        }
    }

    addDisposer(dispose) {
        if (typeof dispose === "function") this.disposers.push(dispose);
        return dispose;
    }

    onRtp() {
        throw new Error(`${this.kind} leg does not implement onRtp`);
    }

    writeRtp() {
        throw new Error(`${this.kind} leg does not implement writeRtp`);
    }

    noteInbound() {
        this.stats.inboundPackets += 1;
        this.stats.lastInboundAt = Date.now();
    }

    noteOutbound() {
        this.stats.outboundPackets += 1;
        this.stats.lastOutboundAt = Date.now();
    }

    health(now = Date.now()) {
        return {
            id: this.id,
            kind: this.kind,
            codec: this.codec,
            payloadType: this.payloadType,
            active: this.active,
            inboundPackets: this.stats.inboundPackets,
            outboundPackets: this.stats.outboundPackets,
            lastInboundAt: this.stats.lastInboundAt,
            lastOutboundAt: this.stats.lastOutboundAt,
            inboundSilenceMs: this.stats.lastInboundAt ? now - this.stats.lastInboundAt : null,
            outboundSilenceMs: this.stats.lastOutboundAt ? now - this.stats.lastOutboundAt : null,
        };
    }
}

module.exports = {
    MediaLeg,
};
