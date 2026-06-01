class WebRtcBridgeCoordinator {
    constructor({
        sessions,
        mediaGraphFactory,
        logger = console,
    } = {}) {
        if (!sessions) throw new Error("WebRtcBridgeCoordinator requires sessions");
        if (!mediaGraphFactory) throw new Error("WebRtcBridgeCoordinator requires mediaGraphFactory");
        this.sessions = sessions;
        this.mediaGraphFactory = mediaGraphFactory;
        this.logger = logger;
    }

    async connect(callerSessionId, calleeSessionId) {
        const callerSession = this.sessions.get(callerSessionId);
        const calleeSession = this.sessions.get(calleeSessionId);
        if (!callerSession || !calleeSession) return null;

        callerSession.bridgedWith = calleeSessionId;
        calleeSession.bridgedWith = callerSessionId;
        callerSession.linkedSessionId = calleeSessionId;
        calleeSession.linkedSessionId = callerSessionId;

        const graph = await this.mediaGraphFactory.webrtcToWebrtc(callerSession, calleeSession);
        callerSession.resources?.mediaSession?.().attachGraph(graph);
        calleeSession.resources?.mediaSession?.().attachGraph(graph);
        this.logger.log(`[Bridge] WebRTC media bridge initiated between ${callerSessionId} and ${calleeSessionId}`);
        return graph;
    }
}

module.exports = {
    WebRtcBridgeCoordinator,
};
