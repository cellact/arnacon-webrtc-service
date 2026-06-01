const { MediaLeg } = require("../MediaLeg");

class IvrLeg extends MediaLeg {
    constructor({
        id,
        payloadType = 8,
        logger = console,
    } = {}) {
        super({
            id,
            kind: "ivr",
            codec: payloadType === 0 ? "pcmu" : "pcma",
            payloadType,
            logger,
        });
        this.handlers = new Set();
    }

    onRtp(handler) {
        this.handlers.add(handler);
        const dispose = () => this.handlers.delete(handler);
        this.addDisposer(dispose);
        return dispose;
    }

    emitRtp(packet) {
        if (!this.active || !packet) return;
        this.noteInbound();
        for (const handler of this.handlers) {
            try { handler(packet); } catch (err) {
                this.logger.warn(`[${this.id}] IVR leg handler failed: ${err.message}`);
            }
        }
    }

    writeRtp() {
        // IVR currently produces audio only. Inbound media can be added later for speech input.
    }
}

module.exports = {
    IvrLeg,
};
