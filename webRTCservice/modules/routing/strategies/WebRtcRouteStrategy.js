const { RouteStrategy } = require("./RouteStrategy");

class WebRtcRouteStrategy extends RouteStrategy {
    constructor({
        webRtcBridgePort = null,
        notifyAndBridge,
        stopWebRtcSession = null,
        logger = console,
    } = {}) {
        super();
        this.webRtcBridgePort = webRtcBridgePort || {
            notifyAndBridge,
            stopMedia: null,
            stopSession: stopWebRtcSession,
        };
        this.logger = logger;
    }

    async start(context, event) {
        if (typeof this.webRtcBridgePort.notifyAndBridge !== "function") return undefined;
        return this.webRtcBridgePort.notifyAndBridge(context.sessionId, event.destination || context.session.routeDestination);
    }

    async connect() {
        return "webrtc";
    }

    async end(context, event) {
        if (typeof this.webRtcBridgePort.cancelPendingBridge === "function") {
            this.webRtcBridgePort.cancelPendingBridge(context.sessionId, event.reason || "webrtc-end");
        }
        const mediaSession = context.resources?.mediaSession?.();
        if (mediaSession?.getGraph?.()) {
            await mediaSession.stop(event.reason || "webrtc-end");
        } else if (typeof this.webRtcBridgePort.stopMedia === "function") {
            await Promise.resolve(this.webRtcBridgePort.stopMedia(context.sessionId, event.reason || "webrtc-end"));
        }
        return "webrtc";
    }

    async cancel(context, event) {
        if (typeof this.webRtcBridgePort.cancelPendingBridge === "function") {
            this.webRtcBridgePort.cancelPendingBridge(context.sessionId, event.reason || "webrtc-end");
        }
        if (typeof this.webRtcBridgePort.stopSession === "function") {
            return this.webRtcBridgePort.stopSession(context.sessionId, event.reason || "webrtc-end");
        }
        return "webrtc";
    }

    async fail(context, event) {
        if (typeof this.webRtcBridgePort.cancelPendingBridge === "function") {
            this.webRtcBridgePort.cancelPendingBridge(context.sessionId, event.reason || "webrtc-failed");
        }
        if (typeof this.webRtcBridgePort.stopSession === "function") {
            return this.webRtcBridgePort.stopSession(context.sessionId, event.reason || "webrtc-failed");
        }
        return "webrtc";
    }
}

module.exports = {
    WebRtcRouteStrategy,
};
