const { RouteStrategy } = require("./RouteStrategy");

class MultiringRouteStrategy extends RouteStrategy {
    constructor({
        webRtcBridgePort = null,
        notifyAndBridgeMulti,
        startPendingMultiBridge,
        stopWebRtcSession = null,
        logger = console,
    } = {}) {
        super();
        this.webRtcBridgePort = webRtcBridgePort || {
            notifyAndBridgeMulti,
            startPendingMultiBridge,
            stopMedia: null,
            stopSession: stopWebRtcSession,
        };
        this.logger = logger;
    }

    async start(context, event) {
        const destination = event.destination || context.session.routeDestination;
        if (typeof this.webRtcBridgePort.notifyAndBridgeMulti === "function") {
            await this.webRtcBridgePort.notifyAndBridgeMulti(context.sessionId, destination?.targets || []);
        }
        return "webrtc-multiring";
    }

    async connect(context) {
        if (typeof this.webRtcBridgePort.startPendingMultiBridge === "function") {
            return this.webRtcBridgePort.startPendingMultiBridge(context.sessionId);
        }
        return "webrtc-multiring";
    }

    async end(context, event) {
        const mediaSession = context.resources?.mediaSession?.();
        if (mediaSession?.getGraph?.()) {
            await mediaSession.stop(event.reason || "multiring-end");
        } else if (typeof this.webRtcBridgePort.stopMedia === "function") {
            await Promise.resolve(this.webRtcBridgePort.stopMedia(context.sessionId, event.reason || "multiring-end"));
        }
        return "webrtc-multiring";
    }

    async cancel(context, event) {
        if (typeof this.webRtcBridgePort.stopSession === "function") {
            return this.webRtcBridgePort.stopSession(context.sessionId, event.reason || "multiring-end");
        }
        return "webrtc-multiring";
    }

    async fail(context, event) {
        if (typeof this.webRtcBridgePort.stopSession === "function") {
            return this.webRtcBridgePort.stopSession(context.sessionId, event.reason || "multiring-failed");
        }
        return "webrtc-multiring";
    }
}

module.exports = {
    MultiringRouteStrategy,
};
