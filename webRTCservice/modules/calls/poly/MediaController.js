// Adapter from PolySession's "media GO / STOP" to the unchanged media layer
// (MediaGraphFactory + MediaBridge). This is the ONLY place p touches media, and
// media never reads p/s state -- it only receives two media endpoints (MediaLeg
// instances produced by leg.getMediaEndpoint()).

const { MediaControllerPort } = require("./ports");

class MediaController extends MediaControllerPort {
    constructor({ mediaGraphFactory, logger = console } = {}) {
        super();
        if (!mediaGraphFactory) throw new Error("MediaController requires mediaGraphFactory");
        this.mediaGraphFactory = mediaGraphFactory;
        this.logger = logger;
    }

    async connect(endpointA, endpointB, ctx = {}) {
        if (!endpointA || !endpointB) {
            throw new Error("MediaController.connect requires two media endpoints");
        }
        const id = ctx.id || `${endpointA.id}<->${endpointB.id}`;
        const graph = await this.mediaGraphFactory.startGraph({
            id,
            a: endpointA,
            b: endpointB,
            labels: ctx.labels || {},
        });
        return graph;
    }

    async disconnect(handle) {
        if (handle && typeof handle.stop === "function") {
            await handle.stop();
        }
    }
}

module.exports = {
    MediaController,
};
