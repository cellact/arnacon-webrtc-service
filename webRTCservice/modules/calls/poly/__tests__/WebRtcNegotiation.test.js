const { test } = require("node:test");
const assert = require("node:assert/strict");

const { WebRtcNegotiation } = require("../negotiation/WebRtcNegotiation");
const { FakeSignaling, FakePeerConnection, fakePrimitives, silentLogger } = require("./fakes");

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
    assert.ok(signaling.lastOfType("call", "ack"));
});

test("endCall (remote inactive offer) replies with an end-call answer, audio kept reusable", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    await neg.endCall({
        mode: "remote",
        payload: { type: "offer", sdp: "v=0\r\na=group:BUNDLE 0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" },
    });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.payload.type, "answer");
    assert.match(msg.payload.sdp, /m=audio 9 /);
});

test("endCall (initiator) sends an inactive end-call offer and defers", async () => {
    const { neg, signaling } = build({ offerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    const result = await neg.endCall({ from: "bob.secnum.global" });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.payload.type, "offer");
    assert.equal(msg.payload.from, "bob");
    assert.match(msg.payload.sdp, /m=audio 9 /);
    assert.deepEqual(result, { deferred: true }, "the leg stays ENDING until the client's end-call answer");
});

test("endCall completion (peer answered our offer) applies the answer AND sends the call/end signal", async () => {
    const { neg, signaling, session } = build();
    await neg.endCall({ mode: "remote", payload: { type: "answer", sdp: "end-ans-sdp" } });
    assert.equal(session.peerConnection.remoteDescription.type, "answer", "the end-call answer is applied");
    const endSignal = signaling.sent.find((m) => m.msgType === "call" && m.action === "end");
    assert.ok(endSignal, "the call-level END signal must be sent so the client's UI actually ends");
});

test("ackEnd answers the client's end-call offer (audio off) and reports CONNECTED", async () => {
    const { neg, signaling } = build({ answerSdp: "v=0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" });
    const result = await neg.ackEnd({
        payload: { type: "offer", sdp: "v=0\r\na=group:BUNDLE 0\r\nm=audio 0 UDP\r\na=mid:0\r\na=inactive\r\n" },
    });
    const msg = signaling.lastOfType("signaling");
    assert.equal(msg.action, "end-call");
    assert.equal(msg.payload.type, "answer");
    assert.match(msg.payload.sdp, /m=audio 9 /);
    assert.equal(result.state, "connected", "the leg returns to connected, transport kept");
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
