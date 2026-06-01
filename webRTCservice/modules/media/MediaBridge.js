const { adaptRtpPayloadType } = require("./codecs/rtp");

class MediaBridge {
    constructor({
        sessionId,
        a,
        b,
        logger = console,
        statsIntervalMs = 2000,
    } = {}) {
        if (!a || !b) throw new Error("MediaBridge requires two media legs");
        this.sessionId = sessionId || `${a.id}<->${b.id}`;
        this.a = a;
        this.b = b;
        this.logger = logger;
        this.statsIntervalMs = statsIntervalMs;
        this.active = false;
        this.disposers = [];
        this.statsTimer = null;
        this.stats = {
            aToB: 0,
            bToA: 0,
            aToBTranscoded: 0,
            bToATranscoded: 0,
            startedAt: null,
            stoppedAt: null,
        };
    }

    async start() {
        if (this.active) return;
        this.active = true;
        this.stats.startedAt = Date.now();
        this.stats.stoppedAt = null;
        await this.a.start();
        await this.b.start();
        this.disposers.push(this.a.onRtp((packet) => this.forward(this.a, this.b, packet, "aToB")));
        this.disposers.push(this.b.onRtp((packet) => this.forward(this.b, this.a, packet, "bToA")));
        this.statsTimer = setInterval(() => this.logStats(), this.statsIntervalMs);
        this.logger.log(
            `[${this.sessionId}] MEDIA bridge started ` +
            `a=${this.a.kind}:${this.a.id} b=${this.b.kind}:${this.b.id} ` +
            `a_pt=${this.a.payloadType ?? "?"} b_pt=${this.b.payloadType ?? "?"}`,
        );
    }

    forward(from, to, packet, direction) {
        if (!this.active || !packet) return;
        const outgoing = adaptRtpPayloadType(packet, to.payloadType);
        if (outgoing !== packet) this.stats[`${direction}Transcoded`] += 1;
        this.stats[direction] += 1;
        to.writeRtp(outgoing);
    }

    async stop() {
        if (!this.active && !this.statsTimer) return;
        this.active = false;
        this.stats.stoppedAt = Date.now();
        for (const dispose of this.disposers.splice(0)) {
            try { dispose(); } catch (_) {}
        }
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        await this.a.stop();
        await this.b.stop();
        this.logger.log(`[${this.sessionId}] MEDIA bridge stopped`);
    }

    health() {
        return {
            sessionId: this.sessionId,
            active: this.active,
            ...this.stats,
            a: this.a.health(),
            b: this.b.health(),
        };
    }

    logStats() {
        if (!this.active) return;
        const a = this.a.health();
        const b = this.b.health();
        this.logger.log(
            `[${this.sessionId}] MEDIA-STATS ` +
            `a=${a.kind}:${a.id} b=${b.kind}:${b.id} ` +
            `a_to_b=${this.stats.aToB} b_to_a=${this.stats.bToA} ` +
            `a_in=${a.inboundPackets} a_out=${a.outboundPackets} ` +
            `b_in=${b.inboundPackets} b_out=${b.outboundPackets} ` +
            `a_silence_ms=${a.inboundSilenceMs ?? "n/a"} b_silence_ms=${b.inboundSilenceMs ?? "n/a"} ` +
            `a_pt=${a.payloadType ?? "?"} b_pt=${b.payloadType ?? "?"} ` +
            `a2b_xcode=${this.stats.aToBTranscoded} b2a_xcode=${this.stats.bToATranscoded}`,
        );
    }
}

module.exports = {
    MediaBridge,
};
