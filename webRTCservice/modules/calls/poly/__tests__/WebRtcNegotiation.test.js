const { test } = require("node:test");
const assert = require("node:assert/strict");

const { WebRtcNegotiation } = require("../negotiation/WebRtcNegotiation");
const { FakeSignaling, FakePeerConnection, fakePrimitives, silentLogger } = require("./fakes");
const { CallSdpUseCases } = require("../../useCases/CallSdpUseCases");
const { addIceCandidates: addIceCandidatesUtil } = require("../../../media/negotiation/SdpUtils");

function build({ offerSdp, answerSdp } = {}) {
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new FakePeerConnection({ offerSdp, answerSdp }),
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: fakePrimitives(),
        logger: silentLogger,
    });
    return { neg, signaling, session };
}

class MidStrictPeerConnection extends FakePeerConnection {
    constructor(opts = {}) {
        super(opts);
        // Model werift's transceiver map keyed by negotiated mids.
        this.transceivers = [{ kind: "application", mid: "0", setDirection() {}, sender: { replaceTrack: async () => {} } }];
    }

    addTrack(track) {
        if (track?.kind === "audio" && !this.transceivers.find((t) => t.kind === "audio")) {
            this.transceivers.push({
                kind: "audio",
                mid: "1",
                setDirection() {},
                sender: { replaceTrack: async () => {} },
            });
        }
        return { kind: track?.kind || "audio" };
    }

    async setRemoteDescription(d) {
        // Reproduces prod failure:
        // "Transceiver with mid=1 not found" on redial offer after end/reuse.
        const hasAudioTransceiver = this.transceivers.some((t) => t.kind === "audio" || t.mid === "1");
        if (d?.type === "offer" && /a=mid:1/.test(d?.sdp || "") && !hasAudioTransceiver) {
            throw new Error("Transceiver with mid=1 not found");
        }
        this.remoteDescription = d;
    }
}

class MidLifecyclePeerConnection extends FakePeerConnection {
    constructor({ throwOn = "none", audioMid = "2", ...opts } = {}) {
        super(opts);
        this.throwOn = throwOn;
        this.transceivers = [
            { kind: "application", mid: "0", setDirection() {}, sender: { replaceTrack: async () => {} } },
            { kind: "audio", mid: audioMid, setDirection() {}, sender: { replaceTrack: async () => {} } },
        ];
        this._remoteOfferAudioMid = null;
    }

    _extractAudioMid(sdp = "") {
        const sections = String(sdp).split(/\r?\nm=/);
        for (const rawSection of sections) {
            const section = rawSection.startsWith("m=") ? rawSection : `m=${rawSection}`;
            if (!/^m=audio\b/m.test(section)) continue;
            const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1];
            if (mid) return mid;
        }
        return null;
    }

    _hasTransceiverMid(mid) {
        if (!mid) return true;
        return this.transceivers.some((t) => String(t.mid) === String(mid));
    }

    addTrack(track) {
        // Simulate a stale transceiver map on reused sessions: addTrack does not
        // necessarily repair a wrong/missing negotiated MID binding.
        return { kind: track?.kind || "audio" };
    }

    async setRemoteDescription(d) {
        if (d?.type === "offer") {
            this._remoteOfferAudioMid = this._extractAudioMid(d?.sdp || "");
        }
        this.remoteDescription = d;
    }

    async createAnswer() {
        if (
            this.throwOn === "createAnswer" &&
            this._remoteOfferAudioMid &&
            !this._hasTransceiverMid(this._remoteOfferAudioMid)
        ) {
            throw new Error(`Transceiver with mid=${this._remoteOfferAudioMid} not found`);
        }
        return { type: "answer", sdp: this._answerSdp };
    }

    async setLocalDescription(d) {
        if (
            this.throwOn === "setLocalDescription" &&
            this._remoteOfferAudioMid &&
            !this._hasTransceiverMid(this._remoteOfferAudioMid)
        ) {
            throw new Error(`Transceiver with mid=${this._remoteOfferAudioMid} not found`);
        }
        this.localDescription = d;
    }
}

class DuplicateTrackOnRecoveryPeerConnection extends FakePeerConnection {
    constructor({ audioMid = "2", ...opts } = {}) {
        super(opts);
        this.transceivers = [
            { kind: "application", mid: "0", setDirection() {}, sender: { replaceTrack: async () => {} } },
            { kind: "audio", mid: audioMid, setDirection() {}, sender: { replaceTrack: async () => {}, track: null } },
        ];
        this._remoteOfferAudioMid = null;
    }

    _extractAudioMid(sdp = "") {
        const sections = String(sdp).split(/\r?\nm=/);
        for (const rawSection of sections) {
            const section = rawSection.startsWith("m=") ? rawSection : `m=${rawSection}`;
            if (!/^m=audio\b/m.test(section)) continue;
            const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1];
            if (mid) return String(mid);
        }
        return null;
    }

    _hasAudioMid(mid) {
        return this.transceivers.some((t) => t.kind === "audio" && String(t.mid || "") === String(mid || ""));
    }

    addTrack(track) {
        const audio = this.transceivers.find((t) => t.kind === "audio");
        if (audio?.sender?.track === track) {
            throw new Error("Track already added");
        }
        if (audio?.sender) audio.sender.track = track;
        return { kind: track?.kind || "audio" };
    }

    async setRemoteDescription(d) {
        if (d?.type === "offer") {
            this._remoteOfferAudioMid = this._extractAudioMid(d?.sdp || "");
            if (this._remoteOfferAudioMid && !this._hasAudioMid(this._remoteOfferAudioMid)) {
                throw new Error(`Transceiver with mid=${this._remoteOfferAudioMid} not found`);
            }
        }
        this.remoteDescription = d;
    }
}

class MidMapLagPeerConnection extends FakePeerConnection {
    constructor({ initialAudioMid = "1", ...opts } = {}) {
        super(opts);
        this.acceptedAudioMids = new Set([String(initialAudioMid)]);
        this._remoteOfferAudioMid = null;
        this.addTrackCalls = 0;
        this.addTransceiverCalls = 0;
        this.transceivers = [
            { kind: "application", mid: "0", setDirection() {}, sender: { replaceTrack: async () => {}, track: null } },
            this._makeAudioTransceiver(String(initialAudioMid)),
        ];
    }

    _makeAudioTransceiver(initialMid, track = null) {
        const self = this;
        let currentMid = String(initialMid || "").trim();
        const created = {
            kind: "audio",
            setDirection() {},
            sender: { replaceTrack: async () => {}, track },
        };
        Object.defineProperty(created, "mid", {
            get() {
                return currentMid;
            },
            set: (newMid) => {
                const normalized = String(newMid ?? "").trim();
                if (normalized === currentMid) return;
                if (currentMid) self.acceptedAudioMids.delete(currentMid);
                currentMid = normalized;
                if (currentMid) self.acceptedAudioMids.add(currentMid);
            },
            enumerable: true,
            configurable: true,
        });
        if (currentMid) this.acceptedAudioMids.add(currentMid);
        return created;
    }

    _extractAudioMid(sdp = "") {
        const sections = String(sdp).split(/\r?\nm=/);
        for (const rawSection of sections) {
            const section = rawSection.startsWith("m=") ? rawSection : `m=${rawSection}`;
            if (!/^m=audio\b/m.test(section)) continue;
            const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1];
            if (mid) return String(mid).trim();
        }
        return null;
    }

    addTrack(track) {
        this.addTrackCalls += 1;
        const audio = this.transceivers.find((t) => t.kind === "audio");
        if (audio?.sender) audio.sender.track = track;
        return { kind: track?.kind || "audio" };
    }

    addTransceiver(kindOrTrack) {
        this.addTransceiverCalls += 1;
        const isAudio = kindOrTrack === "audio" || kindOrTrack?.kind === "audio";
        if (!isAudio) return null;
        // Still models stack growth — production must not call this when audio exists.
        const existingNumericMids = this.transceivers
            .map((t) => Number.parseInt(String(t.mid ?? ""), 10))
            .filter((n) => Number.isFinite(n));
        const nextMid = String(existingNumericMids.length ? Math.max(...existingNumericMids) + 1 : 1);
        const created = this._makeAudioTransceiver(
            nextMid,
            kindOrTrack?.kind === "audio" ? kindOrTrack : null,
        );
        this.transceivers.push(created);
        return created;
    }

    async setRemoteDescription(d) {
        if (d?.type === "offer") {
            this._remoteOfferAudioMid = this._extractAudioMid(d?.sdp || "");
            if (this._remoteOfferAudioMid && !this.acceptedAudioMids.has(this._remoteOfferAudioMid)) {
                throw new Error(`Transceiver with mid=${this._remoteOfferAudioMid} not found`);
            }
        }
        this.remoteDescription = d;
    }
}

class MidMapLagTrackCreateFailsPeerConnection extends MidMapLagPeerConnection {
    addTransceiver(kindOrTrack) {
        if (kindOrTrack && typeof kindOrTrack === "object" && kindOrTrack.kind === "audio") {
            throw new Error("Track already added");
        }
        return super.addTransceiver(kindOrTrack);
    }
}

class CandidateMLineStrictPeerConnection extends FakePeerConnection {
    constructor(opts = {}) {
        super(opts);
        this._remoteMLineCount = 0;
        this.appliedCandidates = [];
    }

    async setRemoteDescription(d) {
        this.remoteDescription = d;
        const sdp = String(d?.sdp || "");
        this._remoteMLineCount = (sdp.match(/^m=/gm) || []).length;
    }

    async addIceCandidate(candidate) {
        const idx = Number(candidate?.sdpMLineIndex);
        if (Number.isFinite(idx) && (idx < 0 || idx >= this._remoteMLineCount)) {
            throw new Error("m line not found");
        }
        this.appliedCandidates.push(candidate);
    }
}

class ParserMLineRecoveryPeerConnection extends FakePeerConnection {
    constructor(opts = {}) {
        super(opts);
        const makeSender = () => ({
            track: null,
            async replaceTrack(nextTrack) {
                this.track = nextTrack || null;
            },
        });
        this.transceivers = [
            { kind: "application", mid: "0", setDirection() {}, sender: makeSender() },
            { kind: "audio", mid: "1", setDirection() {}, sender: makeSender() },
        ];
        this.failOnce = true;
    }

    addTrack(track) {
        const audio = this.transceivers.find((t) => t.kind === "audio");
        if (audio?.sender) audio.sender.track = track;
        return { kind: track?.kind || "audio" };
    }

    async setRemoteDescription(d) {
        const sdp = String(d?.sdp || "");
        const hasAudio = /^m=audio\b/m.test(sdp);
        const audio = this.transceivers.find((t) => t.kind === "audio");
        if (!hasAudio && this.failOnce && audio?.sender?.track) {
            this.failOnce = false;
            throw new Error("Cannot read properties of undefined (reading 'iceParams')");
        }
        this.remoteDescription = d;
    }
}

function deepLifecyclePrimitives() {
    const base = fakePrimitives();
    const callSdpUseCases = new CallSdpUseCases({
        sessions: new Map(),
        MediaStreamTrack: base.MediaStreamTrack,
        patchInactiveToSendrecv: base.patchInactiveToSendrecv,
        logSdp: () => {},
        enqueueSignaling: (_sessionId, _label, fn) => Promise.resolve().then(fn),
        sendDataChannelMessage: () => {},
        callRuntime: null,
        logger: silentLogger,
    });
    return {
        ...base,
        ensureLocalAudioTrack: (...args) => callSdpUseCases.ensureLocalAudioTrack(...args),
        createAnswerSdp: (...args) => callSdpUseCases.createAnswerSdp(...args),
        addIceCandidates: (...args) =>
            addIceCandidatesUtil(...args, class RTCIceCandidate {
                constructor(init = {}) {
                    Object.assign(this, init);
                }
            }),
    };
}

// Models a reused PC after end-call: mid=0 DC + mid=1 audio. addTrack while
// audio already exists invents mid=2 (the production poison). createOffer SDP
// reflects live audio transceiver mids/directions.
class ContinuityPeerConnection extends FakePeerConnection {
    constructor(opts = {}) {
        super(opts);
        this.addTrackCalls = 0;
        this.addTransceiverCalls = 0;
        const makeSender = (track = null) => ({
            track,
            async replaceTrack(next) { this.track = next || null; },
            registerTrack(next) { this.track = next || null; },
        });
        this.transceivers = [
            {
                kind: "application",
                mid: "0",
                direction: "sendrecv",
                setDirection(d) { this.direction = d; },
                sender: makeSender(),
            },
            {
                kind: "audio",
                mid: "1",
                direction: "inactive",
                setDirection(d) { this.direction = d; },
                sender: makeSender(null),
            },
        ];
    }

    addTrack(track) {
        this.addTrackCalls += 1;
        const existing = this.transceivers.filter((t) => t.kind === "audio");
        if (existing.length > 0) {
            // Poison model: second audio m-line (mid=2) when mid=1 already exists.
            const nextMid = String(
                Math.max(
                    0,
                    ...this.transceivers.map((t) => Number.parseInt(String(t.mid ?? ""), 10)).filter(Number.isFinite),
                ) + 1,
            );
            this.transceivers.push({
                kind: "audio",
                mid: nextMid,
                direction: "sendrecv",
                setDirection(d) { this.direction = d; },
                sender: {
                    track,
                    async replaceTrack(next) { this.track = next || null; },
                    registerTrack(next) { this.track = next || null; },
                },
            });
            return { kind: "audio" };
        }
        this.transceivers.push({
            kind: "audio",
            mid: "1",
            direction: "sendrecv",
            setDirection(d) { this.direction = d; },
            sender: {
                track,
                async replaceTrack(next) { this.track = next || null; },
                registerTrack(next) { this.track = next || null; },
            },
        });
        return { kind: "audio" };
    }

    addTransceiver(kindOrTrack) {
        this.addTransceiverCalls += 1;
        return this.addTrack(kindOrTrack?.kind === "audio" ? kindOrTrack : { kind: "audio" });
    }

    async createOffer() {
        const audioMids = this.transceivers
            .filter((t) => t.kind === "audio")
            .map((t) => String(t.mid));
        const bundle = ["0", ...audioMids].join(" ");
        let sdp = `v=0\r\na=group:BUNDLE ${bundle}\r\n`;
        sdp += "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
        for (const t of this.transceivers.filter((x) => x.kind === "audio")) {
            const dir = t.direction || "sendrecv";
            sdp += `m=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:${t.mid}\r\na=${dir}\r\n`;
        }
        return { type: "offer", sdp };
    }
}

test("ring sends a signaling offer with the caller's bare label", async () => {
    const { neg, signaling } = build();
    await neg.ring({ from: "alice.secnum.global" });
    const msg = signaling.lastOfType("signaling", "offer");
    assert.ok(msg, "expected a signaling offer to be sent");
    assert.equal(msg.payload.from, "alice");
    assert.equal(msg.payload.to, "bob.secnum.global");
    assert.ok(msg.payload.sdp);
});

test("applyAnswer applies remote answer and acks", async () => {
    const { neg, signaling, session } = build();
    await neg.applyAnswer({ payload: { sdp: "answer-sdp" } });
    assert.equal(session.peerConnection.remoteDescription.type, "answer");
    const ack = signaling.lastOfType("call", "ack");
    assert.ok(ack);
    assert.ok(Number.isInteger(ack.callId) && ack.callId > 0);
});

test("pre-negotiated MULTI_RING pickup does not emit or apply a second SDP", async () => {
    const { neg, signaling, session } = build();
    session.multiRingPreNegotiated = true;

    await neg.ring({ from: "972501234567" });
    assert.equal(signaling.lastOfType("signaling", "offer"), undefined);

    await neg.applyAnswer({ payload: {} });
    assert.equal(session.peerConnection.remoteDescription, null);
    const ack = signaling.lastOfType("call", "ack");
    assert.ok(ack);
    assert.ok(Number.isInteger(ack.callId) && ack.callId > 0);
});

test("endCall (remote inactive offer) replies with an end-call answer, audio kept reusable", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    await neg.endCall({
        mode: "remote",
        payload: {
            type: "offer",
            from: "alice.secnum.global",
            to: "bob.secnum.global",
            sessionId: "alice.secnum.global|bob.secnum.global",
            callId: 12345,
            sdp: "v=0\r\na=group:BUNDLE 0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n",
        },
    });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.callId, 12345);
    assert.equal(msg.payload.type, "answer");
    assert.equal(msg.payload.callId, 12345);
    assert.equal(msg.payload.to, "alice.secnum.global");
    assert.equal(msg.payload.sessionId, "alice.secnum.global|bob.secnum.global");
    assert.match(msg.payload.sdp, /m=audio 9 /);
});

test("endCall (initiator) sends an inactive end-call offer and defers", async () => {
    const { neg, signaling } = build({ offerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    await neg.applyOffer({
        payload: {
            type: "offer",
            from: "alice.secnum.global",
            to: "bob.secnum.global",
            sessionId: "alice.secnum.global|bob.secnum.global",
            callId: 9876,
            sdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n",
        },
    });
    const result = await neg.endCall({ from: "bob.secnum.global" });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.callId, 9876);
    assert.equal(msg.payload.type, "offer");
    assert.equal(msg.payload.from, "bob.secnum.global");
    assert.equal(msg.payload.to, "alice.secnum.global");
    assert.equal(msg.payload.sessionId, "alice.secnum.global|bob.secnum.global");
    assert.equal(msg.payload.callId, 9876);
    assert.match(msg.payload.sdp, /m=audio 9 /);
    assert.deepEqual(result, { deferred: true }, "the leg stays ENDING until the client's end-call answer");
});

test("endCall completion (peer answered our offer) applies the answer AND sends the call/end signal", async () => {
    const { neg, signaling, session } = build();
    await neg.endCall({
        mode: "remote",
        payload: {
            type: "answer",
            from: "alice.secnum.global",
            to: "bob.secnum.global",
            sessionId: "alice.secnum.global|bob.secnum.global",
            callId: 54321,
            sdp: "end-ans-sdp",
        },
    });
    assert.equal(session.peerConnection.remoteDescription.type, "answer", "the end-call answer is applied");
    const endSignal = signaling.sent.find((m) => m.msgType === "signaling" && m.action === "end-call");
    assert.ok(endSignal, "the call-level END signal must be sent so the client's UI actually ends");
    assert.equal(endSignal.callId, 54321);
});

test("ackEnd answers the client's end-call offer (audio off) and reports CONNECTED", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    const result = await neg.ackEnd({
        payload: {
            type: "offer",
            from: "alice.secnum.global",
            to: "bob.secnum.global",
            sessionId: "alice.secnum.global|bob.secnum.global",
            callId: 321,
            sdp: "v=0\r\na=group:BUNDLE 0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n",
        },
    });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.callId, 321);
    assert.equal(msg.payload.type, "answer");
    assert.equal(msg.payload.callId, 321);
    assert.equal(msg.payload.to, "alice.secnum.global");
    assert.match(msg.payload.sdp, /m=audio 9 /);
    assert.equal(result.state, "connected", "the leg returns to connected, transport kept");
});

test("ackEnd with no offer yet (bare call/end arrived first) returns CONNECTED without answering", async () => {
    // iOS sends the bare `call`/`end` signal BEFORE its end-call reneg offer, so
    // ackEnd can fire with no offer to answer. It must NOT try to createAnswer.
    const { neg, signaling } = build();
    const result = await neg.ackEnd({});
    assert.equal(result.state, "connected", "leg returns to connected; reneg offer is answered later");
    assert.equal(
        signaling.lastOfType("signaling", "answer"),
        undefined,
        "no offer to answer => no end-call answer is sent",
    );
});

test("endCall remote with a bare signal (no SDP) does NOT re-initiate an end-call offer", async () => {
    const { neg, signaling } = build();
    const result = await neg.endCall({ mode: "remote", payload: { msgType: "call", action: "end" } });
    assert.equal(result, undefined, "remote bare end never returns deferred (it must not initiate)");
    assert.equal(
        signaling.lastOfType("signaling", "offer"),
        undefined,
        "a bare remote end must not emit a fresh end-call offer",
    );
});

test("getMediaEndpoint returns a media leg bound to the peer connection", () => {
    const { neg, session } = build();
    const ep = neg.getMediaEndpoint();
    assert.equal(ep.kind, "webrtc");
    assert.equal(ep.peerConnection, session.peerConnection);
});

test("ice-restart applyOffer answers without re-adding the local audio track", async () => {
    let ensured = 0;
    const primitives = fakePrimitives();
    primitives.ensureLocalAudioTrack = () => { ensured += 1; };
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new FakePeerConnection({ answerSdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\n" }),
    };
    const neg = new WebRtcNegotiation({ id: "alice", endpoint: "alice.secnum.global", session, signaling, primitives, logger: silentLogger });
    await neg.applyOffer({ mode: "ice-restart", payload: { sdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\n" } });
    assert.equal(ensured, 0, "ice-restart must not re-ensure the audio track");
    assert.equal(session.peerConnection.remoteDescription.type, "offer");
    assert.ok(signaling.lastOfType("signaling", "answer"), "expected an answer back for the restart");
});

test("applyOffer (ring) holds the answer AND does not ack: P decides when", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n" });
    await neg.applyOffer({ mode: "ring", payload: { sdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n" } });
    assert.equal(
        signaling.lastOfType("signaling", "answer"),
        undefined,
        "answer must NOT be sent while the call is only ringing",
    );
    assert.equal(
        signaling.lastOfType("call", "ack"),
        undefined,
        "applyOffer must NOT ack on its own -- PolySession decides when via the ACK intent",
    );
});

test("ackConnected sends a ring ack on every call (no persistent guard; P gates frequency)", async () => {
    const { neg, signaling } = build();
    await neg.applyOffer({ mode: "ring", payload: { sdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n" } });
    await neg.ackConnected();
    await neg.ackConnected();
    const acks = signaling.sent.filter((m) => m.msgType === "call" && m.action === "ack" && m.ackFor === "ring");
    assert.equal(acks.length, 2, "each ackConnected sends a ring ack -- two rings => two acks");
});

test("ackRing is a no-op for webrtc (the caller was already acked at connect)", async () => {
    const { neg, signaling } = build();
    await neg.ackRing();
    assert.equal(
        signaling.sent.filter((m) => m.msgType === "call" && m.action === "ack").length,
        0,
        "ackRing must send nothing for webrtc",
    );
});

test("applySessionAnswer applies the remote SDP but does NOT ack and does NOT advance", async () => {
    const { neg, signaling, session } = build();
    await neg.applySessionAnswer({ payload: { sdp: "session-answer-sdp" } });
    assert.equal(session.peerConnection.remoteDescription.type, "answer");
    assert.equal(
        signaling.lastOfType("call", "ack"),
        undefined,
        "session answer is a transport step, not a call accept -- no ack",
    );
});

test("answer() flushes the held answer once the peer picks up", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n" });
    await neg.applyOffer({ mode: "ring", payload: { sdp: "v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n" } });
    await neg.answer();
    assert.ok(signaling.lastOfType("signaling", "answer"), "answer should be flushed once the peer picks up");
    assert.ok(signaling.lastOfType("call", "ack"));
});

const MULTI_CODEC_AUDIO =
    "v=0\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8\r\n" +
    "a=mid:0\r\n" +
    "a=sendrecv\r\n" +
    "a=rtpmap:111 opus/48000/2\r\n" +
    "a=rtpmap:0 PCMU/8000\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n";

test("applyOffer narrows the incoming offer to the session codec policy (PCMA) before answering", async () => {
    const { neg, session } = build({ answerSdp: MULTI_CODEC_AUDIO });
    session.mediaCodecPolicy = "pcma";
    await neg.applyOffer({ mode: "ring", payload: { sdp: MULTI_CODEC_AUDIO } });
    const remote = session.peerConnection.remoteDescription.sdp;
    assert.match(remote, /m=audio 9 \S+ 8\r\n/, "m-line should be narrowed to PT 8 only");
    assert.doesNotMatch(remote, /opus/, "opus must be stripped so the client can only send PCMA");
});

test("ring narrows the callee ring offer to the session codec policy (PCMA)", async () => {
    const { neg, signaling, session } = build({ offerSdp: MULTI_CODEC_AUDIO });
    session.mediaCodecPolicy = "pcma";
    await neg.ring({ from: "alice.secnum.global" });
    const msg = signaling.lastOfType("signaling", "offer");
    assert.ok(msg, "expected a signaling offer");
    assert.match(msg.payload.sdp, /m=audio 9 \S+ 8\r\n/, "ring offer should be narrowed to PT 8 only");
    assert.doesNotMatch(msg.payload.sdp, /opus/, "opus must be stripped from the ring offer");
});

test("ring after end-call reuses mid=1 audio transceiver (no mid=2)", async () => {
    const signaling = new FakeSignaling();
    const pc = new ContinuityPeerConnection();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "bob",
        endpoint: "bob.secnum.global",
        session,
        signaling,
        primitives: fakePrimitives(),
        logger: silentLogger,
    });

    await neg.endCall({ from: "alice.secnum.global" });
    assert.equal(session.localAudioTrack, null, "end-call nulls localAudioTrack");
    assert.equal(pc.transceivers.filter((t) => t.kind === "audio").length, 1);

    await neg.ring({ from: "alice.secnum.global" });
    const msg = signaling.lastOfType("signaling", "offer");
    assert.ok(msg?.payload?.sdp, "expected ring offer");
    assert.equal(pc.addTrackCalls, 0, "must not addTrack when mid=1 audio already exists");
    assert.equal(pc.addTransceiverCalls, 0);
    assert.equal(pc.transceivers.filter((t) => t.kind === "audio").length, 1);
    assert.equal(String(pc.transceivers.find((t) => t.kind === "audio").mid), "1");
    assert.match(msg.payload.sdp, /a=mid:1/);
    assert.doesNotMatch(msg.payload.sdp, /a=mid:2/, "ring must not invent mid=2");
    assert.match(msg.payload.sdp, /a=group:BUNDLE 0 1/);
    assert.ok(session.localAudioTrack, "fresh track attached to existing transceiver");
    assert.equal(pc.transceivers.find((t) => t.kind === "audio").direction, "sendrecv");
});

test("ring on inactive mid=1 PC reuses transceiver without addTrack", async () => {
    const signaling = new FakeSignaling();
    const pc = new ContinuityPeerConnection();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "bob",
        endpoint: "bob.secnum.global",
        session,
        signaling,
        primitives: fakePrimitives(),
        logger: silentLogger,
    });

    await neg.ring({ from: "alice.secnum.global" });
    assert.equal(pc.addTrackCalls, 0);
    assert.equal(pc.transceivers.filter((t) => t.kind === "audio").length, 1);
    assert.equal(String(pc.transceivers.find((t) => t.kind === "audio").mid), "1");
    const msg = signaling.lastOfType("signaling", "offer");
    assert.doesNotMatch(msg.payload.sdp, /a=mid:2/);
});

test("callee leg connect delegates to inviteCallee (deferred) and binds the returned leg session", async () => {
    const signaling = new FakeSignaling();
    const legSession = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new FakePeerConnection(),
    };
    let invited = null;
    const neg = new WebRtcNegotiation({
        id: "bob",
        endpoint: "bob.secnum.global",
        role: "callee",
        destination: { wallet: "0xbob", ensName: "bob.secnum.global" },
        inviteCallee: async (ctx) => { invited = ctx; return legSession; },
        signaling,
        primitives: fakePrimitives(),
        logger: silentLogger,
    });
    const result = await neg.connect({ from: "alice.secnum.global" });
    assert.deepEqual(result, { deferred: true }, "callee connect waits for its DC to open");
    assert.ok(invited, "expected inviteCallee to be called on callee connect");
    assert.equal(invited.destination.wallet, "0xbob");
    assert.equal(neg.session, legSession, "leg session should bind to the created outbound leg");
    assert.equal(neg.getMediaEndpoint().peerConnection, legSession.peerConnection);
});

test("callee leg connect without inviteCallee transport throws", async () => {
    const neg = new WebRtcNegotiation({
        id: "bob",
        endpoint: "bob.secnum.global",
        role: "callee",
        destination: { wallet: "0xbob" },
        signaling: new FakeSignaling(),
        primitives: fakePrimitives(),
        logger: silentLogger,
    });
    await assert.rejects(() => neg.connect({}), /no inviteCallee transport/);
});

test("BUG REPRO: redial offer after end/reuse must not fail on mid mismatch", async () => {
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new MidStrictPeerConnection(),
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: fakePrimitives(),
        logger: silentLogger,
    });

    const redialOfferWithAudioMid =
        "v=0\r\n" +
        "a=group:BUNDLE 0 1\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:1\r\n" +
        "a=sendrecv\r\n";

    // RED test first: today this throws exactly like prod logs.
    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: redialOfferWithAudioMid } }),
        "redial offer should recover from transceiver mismatch instead of wedging",
    );
});

test("DEEP BUG REPRO: stale audio MID can fail during createAnswer (not only setRemoteDescription)", async () => {
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new MidLifecyclePeerConnection({
            throwOn: "createAnswer",
            audioMid: "2", // stale vs incoming offer's mid=1
            answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:1\r\na=sendrecv\r\n",
        }),
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });

    const redialOfferWithAudioMid =
        "v=0\r\n" +
        "a=group:BUNDLE 0 1\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:1\r\n" +
        "a=sendrecv\r\n";

    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: redialOfferWithAudioMid } }),
        "redial offer should not wedge even when MID mismatch surfaces at createAnswer time",
    );
});

test("DEEP BUG REPRO: stale audio MID can fail during setLocalDescription", async () => {
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new MidLifecyclePeerConnection({
            throwOn: "setLocalDescription",
            audioMid: "2", // stale vs incoming offer's mid=1
            answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:1\r\na=sendrecv\r\n",
        }),
        localAudioTrack: null,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });

    const redialOfferWithAudioMid =
        "v=0\r\n" +
        "a=group:BUNDLE 0 1\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:1\r\n" +
        "a=sendrecv\r\n";

    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: redialOfferWithAudioMid } }),
        "redial offer should not wedge even when MID mismatch surfaces at setLocalDescription time",
    );
});

test("DEEP BUG REPRO: recovery must not throw when local track is already bound", async () => {
    const signaling = new FakeSignaling();
    const localTrack = { kind: "audio" };
    const pc = new DuplicateTrackOnRecoveryPeerConnection({
        audioMid: "2",
        answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:1\r\na=sendrecv\r\n",
    });
    pc.transceivers.find((t) => t.kind === "audio").sender.track = localTrack;
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: localTrack,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });

    const redialOfferWithAudioMid =
        "v=0\r\n" +
        "a=group:BUNDLE 0 1\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:1\r\n" +
        "a=sendrecv\r\n";

    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: redialOfferWithAudioMid } }),
        "recovery should tolerate already-bound tracks and continue",
    );
});

test("mid mismatch recovers by retagging existing audio transceiver (no second mid)", async () => {
    const signaling = new FakeSignaling();
    const localTrack = { kind: "audio" };
    const pc = new MidMapLagPeerConnection({
        initialAudioMid: "1",
        answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:2\r\na=sendrecv\r\n",
    });
    pc.transceivers.find((t) => t.kind === "audio").sender.track = localTrack;
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: localTrack,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });

    const offerWithAudioMid2 =
        "v=0\r\n" +
        "a=group:BUNDLE 0 2\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:2\r\n" +
        "a=sendrecv\r\n";

    const audioCountBefore = pc.transceivers.filter((t) => t.kind === "audio").length;
    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: offerWithAudioMid2 } }),
        "recovery should retag existing mid=1 → mid=2 without inventing a new transceiver",
    );
    assert.equal(pc.addTransceiverCalls, 0, "must not addTransceiver when audio already exists");
    assert.equal(
        pc.transceivers.filter((t) => t.kind === "audio").length,
        audioCountBefore,
        "audio transceiver count must stay stable",
    );
    assert.equal(String(pc.transceivers.find((t) => t.kind === "audio").mid), "2");
});

test("repeated mid retags reuse one audio transceiver (no mid=2 then mid=3 growth)", async () => {
    const signaling = new FakeSignaling();
    const localTrack = { kind: "audio" };
    const pc = new MidMapLagPeerConnection({
        initialAudioMid: "1",
        answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:3\r\na=sendrecv\r\n",
    });
    pc.transceivers.find((t) => t.kind === "audio").sender.track = localTrack;
    const session = {
        sessionId: "alice|bob",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: localTrack,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });

    const offerMid2 =
        "v=0\r\n" +
        "a=group:BUNDLE 0 2\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:2\r\n" +
        "a=sendrecv\r\n";
    const offerMid3 =
        "v=0\r\n" +
        "a=group:BUNDLE 0 3\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:3\r\n" +
        "a=sendrecv\r\n";

    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: offerMid2 } }),
        "first reuse cycle should retag mid without growth",
    );
    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: offerMid3 } }),
        "second reuse cycle should retag mid without growth",
    );
    assert.equal(pc.addTransceiverCalls, 0);
    assert.equal(pc.transceivers.filter((t) => t.kind === "audio").length, 1);
    assert.equal(String(pc.transceivers.find((t) => t.kind === "audio").mid), "3");
});

test("mid recovery retags even when addTransceiver(track) would fail", async () => {
    const signaling = new FakeSignaling();
    const localTrack = { kind: "audio" };
    const pc = new MidMapLagTrackCreateFailsPeerConnection({
        initialAudioMid: "1",
        answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:2\r\na=sendrecv\r\n",
    });
    pc.transceivers.find((t) => t.kind === "audio").sender.track = localTrack;
    const session = {
        sessionId: "alice|bob|mid2-fallback",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: localTrack,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });
    const offerWithAudioMid2 =
        "v=0\r\n" +
        "a=group:BUNDLE 0 2\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:2\r\n" +
        "a=sendrecv\r\n";
    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: offerWithAudioMid2 } }),
        "mid recovery should retag existing transceiver and never need addTransceiver",
    );
    assert.equal(pc.addTransceiverCalls, 0);
    assert.equal(pc.transceivers.filter((t) => t.kind === "audio").length, 1);
});

test("DEEP MATRIX: createAnswer recovery handles missing mids 1/2/3", async () => {
    for (const mid of ["1", "2", "3"]) {
        const signaling = new FakeSignaling();
        const session = {
            sessionId: `alice|bob|create|${mid}`,
            callerEns: "alice.secnum.global",
            toIdentity: "bob.secnum.global",
            peerConnection: new MidLifecyclePeerConnection({
                throwOn: "createAnswer",
                audioMid: "9",
                answerSdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:${mid}\r\na=sendrecv\r\n`,
            }),
            localAudioTrack: null,
        };
        const neg = new WebRtcNegotiation({
            id: "alice",
            endpoint: "alice.secnum.global",
            session,
            signaling,
            primitives: deepLifecyclePrimitives(),
            logger: silentLogger,
        });
        const offer =
            "v=0\r\n" +
            `a=group:BUNDLE 0 ${mid}\r\n` +
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
            "a=mid:0\r\n" +
            "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
            `a=mid:${mid}\r\n` +
            "a=sendrecv\r\n";
        await assert.doesNotReject(
            () => neg.applyOffer({ mode: "ring", payload: { sdp: offer } }),
            `createAnswer recovery should handle missing mid=${mid}`,
        );
    }
});

test("DEEP MATRIX: setLocalDescription recovery handles missing mids 1/2/3", async () => {
    for (const mid of ["1", "2", "3"]) {
        const signaling = new FakeSignaling();
        const session = {
            sessionId: `alice|bob|setlocal|${mid}`,
            callerEns: "alice.secnum.global",
            toIdentity: "bob.secnum.global",
            peerConnection: new MidLifecyclePeerConnection({
                throwOn: "setLocalDescription",
                audioMid: "9",
                answerSdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:${mid}\r\na=sendrecv\r\n`,
            }),
            localAudioTrack: null,
        };
        const neg = new WebRtcNegotiation({
            id: "alice",
            endpoint: "alice.secnum.global",
            session,
            signaling,
            primitives: deepLifecyclePrimitives(),
            logger: silentLogger,
        });
        const offer =
            "v=0\r\n" +
            `a=group:BUNDLE 0 ${mid}\r\n` +
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
            "a=mid:0\r\n" +
            "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
            `a=mid:${mid}\r\n` +
            "a=sendrecv\r\n";
        await assert.doesNotReject(
            () => neg.applyOffer({ mode: "ring", payload: { sdp: offer } }),
            `setLocalDescription recovery should handle missing mid=${mid}`,
        );
    }
});

test("DEEP BUG REPRO: ice-restart after reuse survives stale mid map", async () => {
    const signaling = new FakeSignaling();
    const session = {
        sessionId: "alice|bob|icerestart",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: new MidLifecyclePeerConnection({
            throwOn: "setLocalDescription",
            audioMid: "9",
            answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=mid:2\r\na=sendrecv\r\n",
        }),
        localAudioTrack: { kind: "audio" },
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });
    const restartOffer =
        "v=0\r\n" +
        "a=group:BUNDLE 0 2\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
        "a=mid:2\r\n" +
        "a=sendrecv\r\n";
    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ice-restart", payload: { sdp: restartOffer } }),
        "ice-restart path should recover from stale reused mid mappings",
    );
});

test("DEEP BUG REPRO: applyOffer ignores stale ICE candidate m-line mismatch", async () => {
    const signaling = new FakeSignaling();
    const pc = new CandidateMLineStrictPeerConnection({
        answerSdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n",
    });
    const session = {
        sessionId: "alice|bob|mline",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: { kind: "audio" },
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });
    const dataOnlyOffer =
        "v=0\r\n" +
        "a=group:BUNDLE 0\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n";
    await assert.doesNotReject(
        () =>
            neg.applyOffer({
                mode: "ring",
                payload: {
                    sdp: dataOnlyOffer,
                    candidates: [
                        { candidate: "candidate:1 1 udp 1 1.1.1.1 11111 typ host", sdpMid: "0", sdpMLineIndex: 0 },
                        { candidate: "candidate:2 1 udp 1 2.2.2.2 22222 typ host", sdpMid: "1", sdpMLineIndex: 1 },
                    ],
                },
            }),
        "stale candidate with missing m-line must be ignored instead of failing offer ingress",
    );
    assert.equal(pc.appliedCandidates.length, 1, "valid candidate should still be applied");
    assert.equal(pc.appliedCandidates[0].sdpMLineIndex, 0);
});

test("DEEP BUG REPRO: parser m-line failure realigns on data-only offer", async () => {
    const signaling = new FakeSignaling();
    const localTrack = { kind: "audio" };
    const pc = new ParserMLineRecoveryPeerConnection({
        answerSdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n",
    });
    pc.transceivers.find((t) => t.kind === "audio").sender.track = localTrack;
    const session = {
        sessionId: "alice|bob|parser-mline",
        callerEns: "alice.secnum.global",
        toIdentity: "bob.secnum.global",
        peerConnection: pc,
        localAudioTrack: localTrack,
    };
    const neg = new WebRtcNegotiation({
        id: "alice",
        endpoint: "alice.secnum.global",
        session,
        signaling,
        primitives: deepLifecyclePrimitives(),
        logger: silentLogger,
    });
    const dataOnlyOffer =
        "v=0\r\n" +
        "a=group:BUNDLE 0\r\n" +
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
        "a=mid:0\r\n";

    await assert.doesNotReject(
        () => neg.applyOffer({ mode: "ring", payload: { sdp: dataOnlyOffer } }),
        "parser-style m-line failures should realign and recover on data-only offers",
    );
    assert.equal(pc.transceivers.find((t) => t.kind === "audio")?.sender?.track, null);
});

test("ring signaling keeps canonical caller label in payload", async () => {
    const { neg, signaling } = build();
    await neg.ring({ from: "alice.secnum.global" });
    const message = signaling.sent.at(-1);
    assert.equal(message?.msgType, "signaling");
    assert.equal(message?.payload?.type, "offer");
    assert.equal(message?.payload?.from, "alice");
    assert.equal(message?.payload?.to, "bob.secnum.global");
});
