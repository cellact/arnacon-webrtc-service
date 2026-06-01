const { MediaFactory } = require("./MediaFactory");

class MediaRelayController {
    constructor({ sessions, MediaStreamTrack, logger = console } = {}) {
        this.sessions = sessions;
        this.logger = logger;
        this.mediaFactory = new MediaFactory({
            sessions,
            MediaStreamTrack,
            logger,
        });
    }

    async startWebRtcToSip(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        return this.mediaFactory.startWebRtcToSipBridge(sessionId);
    }

    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        return this.mediaFactory.stopSessionMedia(sessionId);
    }
}

module.exports = {
    MediaRelayController,
};
