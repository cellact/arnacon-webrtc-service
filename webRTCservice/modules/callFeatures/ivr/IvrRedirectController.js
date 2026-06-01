class IvrRedirectController {
    constructor({
        sessions,
        parseAddress,
        resolveDestination,
        notifyAndBridge,
        playWaitingAudio,
        stopIvr,
        stopAudioForSession,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            parseAddress,
            resolveDestination,
            notifyAndBridge,
            playWaitingAudio,
            stopIvr,
            stopAudioForSession,
            logger,
        });
    }

    async redirectToWebrtc(sessionId, targetEns, { reason = "ivr-redirect", waitingAudioFile = null } = {}) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            this.logger.warn(`[${sessionId}] IVR redirect skipped: session missing target=${targetEns}`);
            return false;
        }

        const serviceId = session.serviceId || "secnum";
        const parsedTo = this.parseAddress(targetEns, serviceId);
        const parsedFrom = this.parseAddress(session.callerEns, serviceId);
        const destination = await this.resolveDestination(parsedTo, parsedFrom, serviceId);
        if (destination?.route !== "webrtc") {
            this.logger.warn(
                `[${sessionId}] IVR redirect rejected target=${targetEns} ` +
                `route=${destination?.route || "n/a"} reason=${destination?.reason || "not-webrtc"}`
            );
            return false;
        }

        this.logger.log(`[${sessionId}] IVR redirect target=${targetEns} wallet=${destination.wallet} reason=${reason}`);
        const waitingFile = waitingAudioFile || session.ivr?.waitingAudioFile || null;
        try {
            if (waitingFile) {
                await this.playWaitingAudio(sessionId, waitingFile, {
                    interrupt: true,
                    reason: `redirect-waiting:${reason}`,
                    loop: true,
                });
                this.logger.log(`[${sessionId}] IVR redirect waiting audio started file=${waitingFile}`);
            }
            await this.notifyAndBridge(sessionId, destination);
            return true;
        } catch (err) {
            this.logger.warn(`[${sessionId}] IVR redirect failed target=${targetEns} reason=${reason} err=${err.message}`);
            return false;
        } finally {
            this.stopIvr(sessionId, `redirect:${reason}`);
            await this.stopAudioForSession(sessionId, `redirect:${reason}`);
        }
    }
}

module.exports = {
    IvrRedirectController,
};
