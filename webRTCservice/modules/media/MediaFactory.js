const { MediaBridge } = require("./MediaBridge");
const { MediaGraphFactory } = require("./MediaGraphFactory");
const { WebRtcClientLeg } = require("./legs/WebRtcClientLeg");
const { SipLeg } = require("./legs/SipLeg");

class MediaFactory extends MediaGraphFactory {
    constructor({
        sessions,
        MediaStreamTrack = globalThis.MediaStreamTrack,
        logger = console,
    } = {}) {
        super({ sessions, MediaStreamTrack, logger });
    }

    createWebRtcClientLeg(sessionOrId) {
        const session = typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
        return new WebRtcClientLeg({
            session,
            MediaStreamTrack: this.MediaStreamTrack,
            logger: this.logger,
        });
    }

    createSipLeg(sessionOrId) {
        const session = typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
        return new SipLeg({
            session,
            logger: this.logger,
        });
    }

    createBridge({ sessionId, a, b }) {
        return new MediaBridge({
            sessionId,
            a,
            b,
            logger: this.logger,
        });
    }

    async startWebRtcToSipBridge(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const graph = await this.webrtcToSip(session);
        return graph.bridge;
    }

    async stopSessionMedia(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        await session.resources?.mediaSession?.().stop("stop-session-media");
    }
}

module.exports = {
    MediaFactory,
};
