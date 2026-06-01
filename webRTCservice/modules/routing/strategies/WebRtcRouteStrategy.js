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
        if (typeof this.webRtcBridgePort.stopSession === "function") {
            return this.webRtcBridgePort.stopSession(context.sessionId, event.reason || "webrtc-end");
        }
        return "webrtc";
    }

    async cancel(context, event) {
        return this.end(context, event);
    }

    async fail(context, event) {
        return this.end(context, event);
    }
}

module.exports = {
    WebRtcRouteStrategy,
};
