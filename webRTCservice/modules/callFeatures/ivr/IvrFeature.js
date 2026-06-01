class IvrFeature {
    constructor({ ivrRuntime, ivrAudioPlayback, logger = console } = {}) {
        if (!ivrRuntime) throw new Error("IvrFeature requires ivrRuntime");
        if (!ivrAudioPlayback) throw new Error("IvrFeature requires ivrAudioPlayback");
        this.ivrRuntime = ivrRuntime;
        this.ivrAudioPlayback = ivrAudioPlayback;
        this.logger = logger;
    }

    shouldStart(session, target) {
        return this.ivrRuntime.shouldStartForSession(session, target);
    }

    start(sessionId, meta = {}) {
        return this.ivrRuntime.startIvr(sessionId, meta);
    }

    stop(sessionId, reason = "stop") {
        this.ivrRuntime.stopIvr(sessionId, reason);
        return this.ivrAudioPlayback.stopSessionPlayback(sessionId, reason);
    }

    handleDtmf(sessionId, msg) {
        return this.ivrRuntime.handleDtmf(sessionId, msg);
    }
}

module.exports = {
    IvrFeature,
};
