const { MediaLeg } = require("../MediaLeg");

class MediaAdapterLeg extends MediaLeg {
    constructor({
        id,
        adapter,
        remoteMedia = null,
        payloadType = null,
        kind = "adapter",
        logger = console,
    } = {}) {
        super({ id, kind, payloadType, logger });
        if (!adapter) throw new Error("MediaAdapterLeg requires adapter");
        this.adapter = adapter;
        this.remoteMedia = remoteMedia;
    }

    onRtp(handler) {
        if (typeof this.adapter.subscribeSourceRtp !== "function") return () => {};
        const unsubscribe = this.adapter.subscribeSourceRtp((packet) => {
            if (!this.active) return;
            this.noteInbound();
            handler(packet);
        });
        const dispose = typeof unsubscribe === "function" ? unsubscribe : () => {};
        this.addDisposer(dispose);
        return dispose;
    }

    writeRtp(packet) {
        if (typeof this.adapter.writeOpenAiRtp !== "function") return;
        this.adapter.writeOpenAiRtp(packet, this.remoteMedia);
        this.noteOutbound();
    }
}

module.exports = {
    MediaAdapterLeg,
};
