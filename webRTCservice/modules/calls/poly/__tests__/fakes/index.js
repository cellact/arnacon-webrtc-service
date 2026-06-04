// In-memory test doubles implementing the segregated ports. No real PC/SIP/net,
// so every test is deterministic and runs in-process.

const { CallNegotiationPort, MediaControllerPort } = require("../../ports");
const { LEG_STATES } = require("../../states");
const { WebRtcLeg } = require("../../legs/WebRtcLeg");
const { SipLeg } = require("../../legs/SipLeg");

const silentLogger = { log() {}, error() {}, warn() {} };

// Records every intent the SessionLeg base delegates to it. Does not mutate leg
// state (the base owns that); just captures the call + the `from`/`mode`.
class FakeNegotiation extends CallNegotiationPort {
    // deferConnect: model a callee whose connect only fires an invite and waits
    // for its transport to open (returns { deferred: true }).
    // endResult: what a P-initiated endCall returns -- webrtc defers (waits for
    // the client's end-call answer), sip settles disconnected.
    constructor({ id, deferConnect = false, endResult = { deferred: true } } = {}) {
        super();
        this.id = id;
        this.deferConnect = deferConnect;
        this.endResult = endResult;
        this.calls = [];
        this.mediaEndpoint = { id: id || "ep", kind: "fake-media" };
    }

    _record(name, ctx) {
        this.calls.push({ name, from: ctx?.from ?? null, mode: ctx?.mode ?? null, type: ctx?.type ?? null });
    }

    async connect(ctx) { this._record("connect", ctx); return this.deferConnect ? { deferred: true } : undefined; }
    async ring(ctx) { this._record("ring", ctx); }
    async ackConnected(ctx) { this._record("ackConnected", ctx); }
    async ackRing(ctx) { this._record("ackRing", ctx); }
    async answer(ctx) { this._record("answer", ctx); }
    async ackEnd(ctx) { this._record("ackEnd", ctx); return { state: LEG_STATES.CONNECTED }; }
    async applyOffer(ctx) { this._record("applyOffer", ctx); }
    async applyAnswer(ctx) { this._record("applyAnswer", ctx); }
    async applySessionAnswer(ctx) { this._record("applySessionAnswer", ctx); }
    // P-initiated end returns the transport's resolution; a remote (completing /
    // absorbing) call only applies SDP, leaving state to the leg's ingress.
    async endCall(ctx) { this._record("endCall", ctx); return ctx?.mode === "remote" ? undefined : this.endResult; }
    async handleAux(ctx) { this._record("aux", ctx); }
    getMediaEndpoint() { return this.mediaEndpoint; }
    async dispose(ctx) { this._record("dispose", ctx); }

    named(name) {
        return this.calls.filter((c) => c.name === name);
    }
}

class FakeMediaController extends MediaControllerPort {
    constructor() {
        super();
        this.connects = [];
        this.disconnects = [];
        this._seq = 0;
    }

    async connect(a, b, ctx = {}) {
        this.connects.push({ a, b, ctx });
        const handle = { id: ctx.id || `graph-${++this._seq}`, stopped: false, stop: async () => { handle.stopped = true; } };
        return handle;
    }

    async disconnect(handle) {
        this.disconnects.push(handle);
        if (handle && typeof handle.stop === "function") await handle.stop();
    }
}

function makeWebRtcLeg(id, opts = {}) {
    const negotiation = new FakeNegotiation({ id, ...opts });
    const leg = new WebRtcLeg({ id, endpoint: id, negotiation, logger: silentLogger });
    return { leg, negotiation };
}

function makeSipLeg(id) {
    // SIP cannot stay connected after a BYE -> a P-initiated end disconnects it.
    const negotiation = new FakeNegotiation({ id, endResult: { state: LEG_STATES.DISCONNECTED } });
    const leg = new SipLeg({ id, endpoint: id, negotiation, logger: silentLogger });
    return { leg, negotiation };
}

// Captures outbound signaling messages (would go over a data channel).
class FakeSignaling {
    constructor() {
        this.sent = [];
    }

    send(message) {
        this.sent.push(message);
    }

    isOpen() {
        return true;
    }

    lastOfType(msgType, action) {
        return [...this.sent].reverse().find(
            (m) => m.msgType === msgType && (action === undefined || m.action === action || m.payload?.type === action),
        );
    }
}

// Minimal werift-shaped peer connection for negotiation adapter tests.
class FakeTransceiver {
    constructor(kind) {
        this.kind = kind;
        this.direction = "sendrecv";
        this.sender = { replaceTrack: async () => {} };
    }

    setDirection(d) {
        this.direction = d;
    }
}

class FakePeerConnection {
    constructor({ offerSdp = "v=0\r\nm=audio 9 UDP a=mid:0\r\n", answerSdp = "v=0\r\nm=audio 9 UDP a=mid:0\r\n" } = {}) {
        this.transceivers = [new FakeTransceiver("audio")];
        this.localDescription = null;
        this.remoteDescription = null;
        this._offerSdp = offerSdp;
        this._answerSdp = answerSdp;
        this.closed = false;
    }

    getTransceivers() { return this.transceivers; }
    addTrack() { return { kind: "audio" }; }
    async createOffer() { return { type: "offer", sdp: this._offerSdp }; }
    async createAnswer() { return { type: "answer", sdp: this._answerSdp }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    close() { this.closed = true; }
}

function fakePrimitives() {
    return {
        RTCSessionDescription: class { constructor(sdp, type) { this.sdp = sdp; this.type = type; } },
        MediaStreamTrack: class { constructor(o) { this.kind = o?.kind; } writeRtp() {} },
        waitForIceGathering: async () => {},
        formatIceCandidates: () => [],
        getRelayCandidates: () => [],
        embedCandidatesInSdp: (sdp) => sdp,
        patchInactiveToSendrecv: (sdp) => sdp.replace(/a=inactive/g, "a=sendrecv"),
        // real (pure) narrowing so codec-policy tests exercise the actual logic
        narrowAudioOfferForCodecPolicy: require("../../../../media/negotiation/SdpCodecNegotiator").narrowAudioOfferForCodecPolicy,
        ensureLocalAudioTrack: () => {},
        createAnswerSdp: async (pc) => (await pc.createAnswer()).sdp,
        logSdp: () => {},
    };
}

module.exports = {
    silentLogger,
    FakeNegotiation,
    FakeMediaController,
    FakeSignaling,
    FakePeerConnection,
    fakePrimitives,
    makeWebRtcLeg,
    makeSipLeg,
};
