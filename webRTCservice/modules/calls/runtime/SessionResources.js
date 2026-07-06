class MediaSession {
    constructor({ sessionId, session, resources, logger = console } = {}) {
        this.sessionId = sessionId;
        this.session = session;
        this.resources = resources;
        this.logger = logger;
    }

    attachGraph(graph) {
        this.session.mediaGraph = graph || null;
        this.session.mediaRelayActive = Boolean(graph);
        this.session.media = graph
            ? {
                legs: graph.legs,
                bridge: graph.bridge,
                activeCallId: this.session.callId || graph.id,
                health: () => graph.health(),
            }
            : null;
        this.resources.register("mediaSession", (reason) => this.stop(reason || "registered-media-stop"));
        return graph;
    }

    getGraph() {
        return this.session.mediaGraph || null;
    }

    getLeg(role) {
        return this.getGraph()?.getLeg?.(role) || this.session.media?.legs?.[role] || null;
    }

    async stop(reason = "media-stop") {
        const graph = this.getGraph();
        if (graph?.stop) await graph.stop(reason);
        else if (this.session.media?.bridge?.stop) await this.session.media.bridge.stop(reason);
        this.clearReusableMediaState(reason);
        this.session.mediaGraph = null;
        this.session.media = null;
        this.session.mediaRelayActive = false;
        this.resources.remove("mediaSession");
        this.logger.log(`[${this.sessionId}] Media session released reason=${reason}`);
    }

    clearReusableMediaState(reason = "media-stop") {
        // Keep signaling transport/PC alive for reuse, but drop per-call media state.
        this.session.localAudioTrack = null;
        this.session.sipLocalAudioTrack = null;
        this.session.remoteTracks = [];
        this.logger.log(`[${this.sessionId}] Media reuse state reset reason=${reason}`);
    }
}

class SessionResources {
    constructor({ sessionId, session, logger = console } = {}) {
        this.sessionId = sessionId;
        this.session = session;
        this.logger = logger;
        this.disposers = new Map();
        this.mediaOwner = new MediaSession({ sessionId, session, resources: this, logger });
    }

    register(name, disposer) {
        if (!name || typeof disposer !== "function") return null;
        this.disposers.set(name, disposer);
        return disposer;
    }

    remove(name) {
        this.disposers.delete(name);
    }

    async stop(name, reason = "resource-stop") {
        const disposer = this.disposers.get(name);
        if (!disposer) return false;
        await Promise.resolve(disposer(reason));
        this.disposers.delete(name);
        return true;
    }

    async stopAll(reason = "resource-stop-all") {
        const stopOrder = ["bridge", "ivr", "mediaSession", "openAiLeg", "sipLeg"];
        const entriesByName = new Map(this.disposers.entries());
        const ordered = stopOrder
            .filter((name) => entriesByName.has(name))
            .map((name) => [name, entriesByName.get(name)]);
        const unordered = Array.from(entriesByName.entries()).filter(([name]) => !stopOrder.includes(name));
        const entries = [...ordered, ...unordered.reverse()];
        this.disposers.clear();
        for (const [name, disposer] of entries) {
            try {
                await Promise.resolve(disposer(reason));
            } catch (err) {
                this.logger.warn(`[${this.sessionId}] Resource ${name} cleanup failed: ${err.message}`);
            }
        }
    }

    sipLeg() {
        return {
            close: async ({ closeSipSession = null, stopMediaRelay = null, finishMinuteCounter = null, reason = "sip-leg-close" } = {}) => {
                if (typeof stopMediaRelay === "function") await Promise.resolve(stopMediaRelay(this.sessionId));
                if (typeof finishMinuteCounter === "function") finishMinuteCounter(this.session);
                if (typeof closeSipSession === "function") await Promise.resolve(closeSipSession(this.sessionId));
                this.session.sipConnection = null;
                this.session.sipPeerConnection = null;
                this.session.sipLocalAudioTrack = null;
                this.remove("sipLeg");
                this.logger.log(`[${this.sessionId}] SIP leg released reason=${reason}`);
            },
            clear: ({ stopMediaRelay = null, finishMinuteCounter = null, reason = "sip-leg-clear" } = {}) =>
                this.sipLeg().close({ stopMediaRelay, finishMinuteCounter, reason }),
            release: (options = {}) => this.sipLeg().clear(options),
            getSession: () => this.session.sipConnection?.inviter || this.session.sipConnection?.invitation || null,
            setHold: (enabled) => {
                if (this.session.sipLocalAudioTrack) this.session.sipLocalAudioTrack.enabled = enabled;
            },
        };
    }

    openAiLeg() {
        return {
            close: async ({ closeOpenAiSipSession = null, stopMediaRelay = null, finishMinuteCounter = null, reason = "openai-leg-close" } = {}) => {
                if (typeof finishMinuteCounter === "function") finishMinuteCounter(this.session);
                if (typeof stopMediaRelay === "function") await Promise.resolve(stopMediaRelay(this.sessionId));
                if (typeof closeOpenAiSipSession === "function") await Promise.resolve(closeOpenAiSipSession(this.sessionId));
                this.session.openAiSipConnection = null;
                this.remove("openAiLeg");
                this.logger.log(`[${this.sessionId}] OpenAI SIP leg released reason=${reason}`);
            },
            clear: ({ stopMediaRelay = null, finishMinuteCounter = null, reason = "openai-leg-clear" } = {}) =>
                this.openAiLeg().close({ stopMediaRelay, finishMinuteCounter, reason }),
            release: (options = {}) => this.openAiLeg().clear(options),
        };
    }

    mediaSession() {
        return this.mediaOwner;
    }

    ivrHandle() {
        return {
            stop: async ({ stopIvr = null, reason = "ivr-stop" } = {}) => {
                if (typeof stopIvr === "function") await Promise.resolve(stopIvr(this.sessionId, reason));
                this.remove("ivr");
            },
        };
    }
}

class SessionResourceRegistry {
    constructor({ sessions, logger = console } = {}) {
        if (!sessions) throw new Error("SessionResourceRegistry requires sessions");
        this.sessions = sessions;
        this.logger = logger;
    }

    forSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        if (!session.resources) {
            session.resources = new SessionResources({ sessionId, session, logger: this.logger });
        }
        return session.resources;
    }
}

module.exports = {
    MediaSession,
    SessionResources,
    SessionResourceRegistry,
};
