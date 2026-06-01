const { MediaBridge } = require("./MediaBridge");
const { WebRtcClientLeg } = require("./legs/WebRtcClientLeg");
const { SipLeg } = require("./legs/SipLeg");
const { IvrLeg } = require("./legs/IvrLeg");
const { OpenAiSipLeg } = require("./legs/OpenAiSipLeg");
const { MediaAdapterLeg } = require("./legs/MediaAdapterLeg");

class MediaGraph {
    constructor({ id, a, b, labels = {}, logger = console } = {}) {
        this.id = id;
        this.bridge = new MediaBridge({ sessionId: id, a, b, logger });
        this.legs = { a, b, ...labels };
        this.active = false;
    }

    async start() {
        if (this.active) return this;
        await this.bridge.start();
        this.active = true;
        return this;
    }

    async stop() {
        if (!this.active && !this.bridge.active) return;
        await this.bridge.stop();
        this.active = false;
    }

    getLeg(role) {
        return this.legs?.[role] || null;
    }

    health() {
        return this.bridge.health();
    }
}

class MediaGraphFactory {
    constructor({
        sessions,
        MediaStreamTrack = globalThis.MediaStreamTrack,
        logger = console,
    } = {}) {
        if (!sessions) throw new Error("MediaGraphFactory requires sessions");
        this.sessions = sessions;
        this.MediaStreamTrack = MediaStreamTrack;
        this.logger = logger;
    }

    getSession(sessionOrId) {
        return typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
    }

    createWebRtcLeg(sessionOrId) {
        const session = this.getSession(sessionOrId);
        return new WebRtcClientLeg({
            session,
            MediaStreamTrack: this.MediaStreamTrack,
            logger: this.logger,
        });
    }

    createSipLeg(sessionOrId) {
        return new SipLeg({
            session: this.getSession(sessionOrId),
            logger: this.logger,
        });
    }

    createIvrLeg({ id, payloadType = 8 }) {
        return new IvrLeg({ id, payloadType, logger: this.logger });
    }

    createOpenAiLeg(options) {
        return new OpenAiSipLeg({ ...options, logger: this.logger });
    }

    createAdapterLeg(options) {
        return new MediaAdapterLeg({ ...options, logger: this.logger });
    }

    async stopExistingGraph(session) {
        if (session?.resources?.mediaSession) {
            await session.resources.mediaSession().stop("replace-media-graph");
            return;
        }
        if (session?.mediaGraph?.stop) await session.mediaGraph.stop();
        else if (session?.media?.bridge) await session.media.bridge.stop();
    }

    async startGraph({ id, a, b, sessions = [], labels = {} }) {
        const graph = new MediaGraph({ id, a, b, labels, logger: this.logger });
        for (const session of sessions.filter(Boolean)) {
            await this.stopExistingGraph(session);
            session.resources?.mediaSession?.().attachGraph(graph);
        }
        await graph.start();
        return graph;
    }

    async webrtcToSip(sessionOrId) {
        const session = this.getSession(sessionOrId);
        if (!session) throw new Error("Session not found");
        const caller = this.createWebRtcLeg(session);
        const target = this.createSipLeg(session);
        return this.startGraph({
            id: session.sessionId,
            a: caller,
            b: target,
            sessions: [session],
            labels: { caller, target },
        });
    }

    async webrtcToWebrtc(callerSessionOrId, calleeSessionOrId) {
        const callerSession = this.getSession(callerSessionOrId);
        const calleeSession = this.getSession(calleeSessionOrId);
        if (!callerSession || !calleeSession) throw new Error("WebRTC media graph requires both sessions");
        const caller = this.createWebRtcLeg(callerSession);
        const callee = this.createWebRtcLeg(calleeSession);
        return this.startGraph({
            id: `${callerSession.sessionId}<->${calleeSession.sessionId}`,
            a: caller,
            b: callee,
            sessions: [callerSession, calleeSession],
            labels: { caller, callee },
        });
    }

    async ivrToWebrtc(sessionOrId, { payloadType = 8 } = {}) {
        const session = this.getSession(sessionOrId);
        if (!session) throw new Error("IVR media graph requires session");
        const ivr = this.createIvrLeg({ id: `${session.sessionId}:ivr`, payloadType });
        const caller = this.createWebRtcLeg(session);
        const graph = await this.startGraph({
            id: session.sessionId,
            a: ivr,
            b: caller,
            sessions: [session],
            labels: { ivr, caller },
        });
        return graph;
    }

    async openAiToTarget({ id, openAiLeg, targetLeg, sessions = [] }) {
        return this.startGraph({
            id,
            a: targetLeg,
            b: openAiLeg,
            sessions,
            labels: { target: targetLeg, openai: openAiLeg },
        });
    }
}

module.exports = {
    MediaGraph,
    MediaGraphFactory,
};
