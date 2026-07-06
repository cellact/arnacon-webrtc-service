const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PolySession } = require("../PolySession");
const { LEG_STATES: S } = require("../states");
const { LEG_EVENTS, makeLegEvent } = require("../ports");
const { FakeMediaController, makeWebRtcLeg, makeSipLeg, silentLogger } = require("./fakes");
const { MediaBridge } = require("../../../media/MediaBridge");
const { MediaLeg } = require("../../../media/MediaLeg");

function buildPoly(legAInfo, legBInfo) {
    const media = new FakeMediaController();
    const poly = new PolySession({
        id: "a<->b",
        legA: legAInfo.leg,
        legB: legBInfo.leg,
        mediaController: media,
        logger: silentLogger,
    });
    return { poly, media };
}

test("webrtc<->webrtc happy path: connect, ring, answer, media GO; then end returns both to connected", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);

    // both transports come up
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.CONNECTED);

    // alice's client offers -> bob gets rung
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.RINGING);
    assert.equal(b.negotiation.named("ring").length, 1);
    assert.equal(b.negotiation.named("ring")[0].from, "alice");

    // bob's client answers -> both in-call, media bridged once
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    assert.equal(a.leg.state, S.IN_CALL);
    assert.equal(b.leg.state, S.IN_CALL);
    assert.equal(media.connects.length, 1);
    assert.equal(media.disconnects.length, 0);

    // alice's client ends -> alice END_REQUESTED. P acks alice (-> connected) and
    // ends bob (-> ending), media stops.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    assert.equal(a.leg.state, S.CONNECTED, "ender returns to connected after ackEnd");
    assert.equal(b.leg.state, S.ENDING, "peer is ending until its client answers");
    assert.equal(media.disconnects.length, 1);
    assert.equal(a.negotiation.named("ackEnd").length, 1, "P drove ackEnd on the ender");
    const bEnds = b.negotiation.named("endCall");
    assert.equal(bEnds[0].from, "alice", "peer end attributed to alice");

    // bob's client answers the end-call offer -> bob back to connected (reusable).
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(b.leg.state, S.CONNECTED);
});

test("secnum<->secnum two-phase callee: connect -> session-answer -> ring -> accept -> media GO", async () => {
    const a = makeWebRtcLeg("alice");                      // caller: transport up via handshake
    const b = makeWebRtcLeg("bob", { deferConnect: true }); // callee: connect only invites
    const { poly, media } = buildPoly(a, b);

    // Caller transport up; callee still disconnected (no FCM yet).
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.DISCONNECTED);

    // Caller's audio offer -> caller CALLING. P acks the caller (ackConnected) and
    // brings the callee transport up (connect, deferred -> stays connecting).
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.CONNECTING);
    assert.equal(a.negotiation.named("ackConnected").length, 1, "caller acked once on the fresh ring");
    assert.equal(b.negotiation.named("connect").length, 1, "callee invited (connect) once");
    assert.equal(b.negotiation.named("ring").length, 0, "callee not rung until its DC opens");

    // Callee's session-establishment answer (/notify) lands while connecting:
    // applied as a session answer, NOT a call accept (stays connecting).
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "session-ans" }));
    assert.equal(b.leg.state, S.CONNECTING);
    assert.equal(b.negotiation.named("applySessionAnswer").length, 1);
    assert.equal(b.negotiation.named("applyAnswer").length, 0);

    // Callee's data channel opens -> connected -> P rings it (audio offer over DC),
    // and tells the caller the peer is ringing (ackRing, a no-op for webrtc).
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    assert.equal(b.leg.state, S.RINGING);
    assert.equal(b.negotiation.named("ring").length, 1, "callee rung once it is connected");
    assert.equal(a.negotiation.named("ackRing").length, 1, "caller told the peer is ringing");
    assert.equal(media.connects.length, 0, "no media before the callee accepts");

    // Callee's client accepts over the data channel (answer while ringing) -> the
    // real accept: both in-call, caller's held answer flushed, media bridged once.
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "accept-ans" }));
    assert.equal(b.leg.state, S.IN_CALL);
    assert.equal(a.leg.state, S.IN_CALL);
    assert.equal(b.negotiation.named("applyAnswer").length, 1, "DC accept applied as a real answer");
    assert.equal(a.negotiation.named("answer").length, 1, "caller's held answer flushed");
    assert.equal(media.connects.length, 1);
});

test("end-call staged flow: inCall/inCall -> endRequested/inCall -> connected/ending -> connected/connected", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    assert.equal(a.leg.state, S.IN_CALL);
    assert.equal(b.leg.state, S.IN_CALL);
    assert.equal(media.connects.length, 1);

    // alice's client sends its end-call reneg offer. In one reconcile pass: media
    // down, ackEnd(alice) -> connected, end(bob) -> ending. (endRequested is the
    // transient alice passes through before ackEnd lands.)
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END, { type: "offer", sdp: "end-offer" }));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.ENDING);
    assert.equal(media.disconnects.length, 1);

    // bob's client answers our end-call offer -> connected. Both reusable.
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.CONNECTED);
});

test("media is connected exactly once across repeated reconcile passes", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    // a redundant in-call answer event must not re-bridge
    await poly._settle();
    assert.equal(media.connects.length, 1);
});

test("one side disconnects mid-call: peer is ended, media stops, dropped side settles to disconnected", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));

    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
    assert.equal(b.leg.state, S.FAILED, "dropped side stays failed");
    assert.equal(a.leg.state, S.ENDING, "surviving peer is ended (waiting for its client answer)");
    assert.equal(media.disconnects.length, 1);

    // a's client answers the end-call offer -> a back to connected. Now that the
    // peer is no longer in an active call, the dropped leg is collapsed from its
    // transient FAILED (teardown trigger) to idle DISCONNECTED so it is reusable.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.DISCONNECTED);
});

test("webrtc<->sip: remote BYE on sip leg ends the webrtc caller", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeSipLeg("+15551234");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    assert.equal(media.connects.length, 1);

    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.REMOTE_BYE));
    assert.equal(b.leg.state, S.DISCONNECTED, "sip dialog gone -> disconnected, not connected");
    assert.equal(a.leg.state, S.ENDING, "webrtc caller ended (waiting for its client answer)");
    assert.equal(a.negotiation.named("endCall")[0].from, "+15551234");
    assert.equal(media.disconnects.length, 1);

    // webrtc caller's client answers the end-call offer -> back to connected.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(a.leg.state, S.CONNECTED);
});

test("sip ring failure ends the webrtc caller, then the sip leg recovers for reuse", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeSipLeg("+15551234");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));

    // The SIP INVITE is rejected before it establishes -> ring() rejects.
    const realRing = b.negotiation.ring.bind(b.negotiation);
    b.negotiation.ring = async () => { throw new Error("SIP call terminated before established"); };

    // Caller offers -> P rings the sip leg, which fails -> sip FAILED -> P ends the
    // caller via an end-call reneg (no media ever bridged).
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(b.leg.state, S.FAILED, "sip leg failed its ring");
    assert.equal(a.leg.state, S.ENDING, "caller is ended on the failed ring");
    assert.equal(a.negotiation.named("endCall").length, 1);
    assert.equal(media.connects.length, 0, "no media bridged for a failed ring");

    // Caller's client answers the end-call offer -> caller back to connected, and
    // the stuck FAILED sip leg recovers to its idle (DISCONNECTED) so it is reusable.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.DISCONNECTED, "failed sip leg recovered to idle for reuse");

    // Reuse: sip is reachable again -> a fresh offer connects + rings the sip leg
    // (a blocking INVITE that answers -> both in-call, media bridged).
    b.negotiation.ring = realRing;
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o2" }));
    assert.equal(a.leg.state, S.IN_CALL);
    assert.equal(b.leg.state, S.IN_CALL, "sip leg rung again on reuse");
    assert.equal(media.connects.length, 1, "media bridged on the reused call");
});

test("reject before answer: caller is ended, no media ever bridged", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(b.leg.state, S.RINGING);

    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.REJECT));
    assert.equal(b.leg.state, S.REJECTED);
    // The caller is ended off its ring (webrtc -> ending until its client answers).
    assert.equal(a.leg.state, S.ENDING);
    assert.equal(a.negotiation.named("endCall").length, 1);
    assert.equal(media.connects.length, 0);
});

test("teardown hooks (e.g. minuteCounter.finish) run exactly once on dispose", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const media = new FakeMediaController();
    const reasons = [];
    const poly = new PolySession({
        id: "a<->b",
        legA: a.leg,
        legB: b.leg,
        mediaController: media,
        teardownHooks: [(reason) => reasons.push(reason)],
        logger: silentLogger,
    });
    await poly.dispose("call-ended");
    await poly.dispose("call-ended"); // idempotent
    assert.deepEqual(reasons, ["call-ended"]);
});

test("call activity hooks fire once on call start/end edges", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly } = buildPoly(a, b);
    const activity = [];
    poly.setCallActivityHooks({
        onCallStart: () => activity.push("start"),
        onCallEnd: () => activity.push("end"),
    });

    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));

    assert.deepEqual(activity, ["start", "end"]);
});

test("second call reuse: after end, a fresh offer rings the peer again", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));

    // graceful end: alice's client ends, then both clients answer the reneg ->
    // both legs back to connected, transports kept.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(a.leg.state, S.CONNECTED);
    assert.equal(b.leg.state, S.CONNECTED);

    // new call on the existing (connected) transports
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o2" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.RINGING);
    assert.equal(b.negotiation.named("ring").length, 2);
});

test("caller cancels while callee is still connecting (deferred connect)", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob", { deferConnect: true });
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.CONNECTING);

    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.CANCEL));
    assert.equal(a.leg.state, S.CANCELED);
    assert.equal(b.leg.state, S.CONNECTING, "callee keeps its connect lifecycle");
    assert.equal(media.connects.length, 0);
    assert.equal(b.negotiation.named("ring").length, 0);

    // If the callee transport opens later, it must not be auto-rung from stale state.
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    assert.equal(b.leg.state, S.CONNECTED);
    assert.equal(b.negotiation.named("ring").length, 0);
});

test("caller transport closes during callee connect: no media, no duplicate teardown intents", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob", { deferConnect: true });
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.CONNECTING);

    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
    assert.equal(a.leg.state, S.DISCONNECTED, "failed caller collapses to idle after teardown settles");
    assert.equal(b.leg.state, S.CONNECTING);
    assert.equal(media.connects.length, 0);
    assert.equal(media.disconnects.length, 0);
    assert.equal(b.negotiation.named("endCall").length, 0);
});

test("simultaneous offers (glare) converges to a single connected call graph", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));

    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o-a" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o-b" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.CALLING);

    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans-b" }));
    assert.equal(a.leg.state, S.IN_CALL);
    assert.equal(b.leg.state, S.IN_CALL);
    assert.equal(media.connects.length, 1, "glare must not duplicate media bridge");
    assert.equal(media.disconnects.length, 0);
});

test("repeated settle passes do not duplicate media disconnect", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    assert.equal(media.connects.length, 1);

    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    assert.equal(media.disconnects.length, 1);
    await poly._settle();
    await poly._settle();
    assert.equal(media.disconnects.length, 1, "teardown reconcile remains idempotent");
});

test("shared endpoint across AB and AC: transport close in AB does not impact AC", async () => {
    const abA = makeWebRtcLeg("alice");
    const abB = makeWebRtcLeg("bob");
    const acA = makeWebRtcLeg("alice");
    const acC = makeWebRtcLeg("carol");
    const first = buildPoly(abA, abB);
    const second = buildPoly(acA, acC);

    await first.poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await first.poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await second.poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await second.poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await first.poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "offer-ab" }));
    await first.poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "answer-ab" }));
    await second.poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "offer-ac" }));
    await second.poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "answer-ac" }));

    assert.equal(abA.leg.state, S.IN_CALL);
    assert.equal(abB.leg.state, S.IN_CALL);
    assert.equal(acA.leg.state, S.IN_CALL);
    assert.equal(acC.leg.state, S.IN_CALL);

    await first.poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
    assert.equal(abB.leg.state, S.FAILED);
    assert.equal(abA.leg.state, S.ENDING);
    assert.equal(acA.leg.state, S.IN_CALL, "AB transport close must not affect AC");
    assert.equal(acC.leg.state, S.IN_CALL, "AB transport close must not affect AC");
    assert.equal(first.media.disconnects.length, 1);
    assert.equal(second.media.disconnects.length, 0);
});

class FakeRtpLeg extends MediaLeg {
    constructor({ id, kind, payloadType = 8 } = {}) {
        super({ id, kind, payloadType, logger: silentLogger });
        this._handler = null;
        this.writtenPackets = 0;
    }

    onRtp(handler) {
        this._handler = handler;
        const dispose = () => { this._handler = null; };
        this.addDisposer(dispose);
        return dispose;
    }

    writeRtp() {
        this.writtenPackets += 1;
        this.noteOutbound();
    }

    emitRtp(packet) {
        if (!this._handler) return;
        this.noteInbound();
        this._handler(packet);
    }
}

function fakeRtpPacket(ssrc, seq) {
    return {
        header: {
            ssrc,
            sequenceNumber: seq,
            timestamp: seq * 160,
            payloadType: 8,
        },
    };
}

test("media bridge passes RTP both directions", async () => {
    const a = new FakeRtpLeg({ id: "webrtc:a", kind: "webrtc" });
    const b = new FakeRtpLeg({ id: "sip:b", kind: "sip" });
    const bridge = new MediaBridge({ sessionId: "webrtc<->sip", a, b, logger: silentLogger, statsIntervalMs: 10000 });
    await bridge.start();

    for (let i = 0; i < 5; i += 1) a.emitRtp(fakeRtpPacket(1111, i + 1));
    for (let i = 0; i < 4; i += 1) b.emitRtp(fakeRtpPacket(2222, i + 1));

    const health = bridge.health();
    assert.equal(health.aToB, 5);
    assert.equal(health.bToA, 4);
    assert.equal(a.stats.inboundPackets > 0, true);
    assert.equal(b.stats.inboundPackets > 0, true);
    await bridge.stop();
});

test("media bridge still bidirectional after teardown and reconnect", async () => {
    const a1 = new FakeRtpLeg({ id: "webrtc:reuse-a", kind: "webrtc" });
    const b1 = new FakeRtpLeg({ id: "sip:reuse-b", kind: "sip" });
    const first = new MediaBridge({ sessionId: "reuse-call-1", a: a1, b: b1, logger: silentLogger, statsIntervalMs: 10000 });
    await first.start();
    a1.emitRtp(fakeRtpPacket(3333, 1));
    b1.emitRtp(fakeRtpPacket(4444, 1));
    await first.stop();
    assert.equal(first.health().aToB, 1);
    assert.equal(first.health().bToA, 1);

    const a2 = new FakeRtpLeg({ id: "webrtc:reuse-a", kind: "webrtc" });
    const b2 = new FakeRtpLeg({ id: "sip:reuse-b", kind: "sip" });
    const second = new MediaBridge({ sessionId: "reuse-call-2", a: a2, b: b2, logger: silentLogger, statsIntervalMs: 10000 });
    await second.start();
    for (let i = 0; i < 3; i += 1) a2.emitRtp(fakeRtpPacket(5555, i + 1));
    for (let i = 0; i < 2; i += 1) b2.emitRtp(fakeRtpPacket(6666, i + 1));
    const health = second.health();
    assert.equal(health.aToB, 3);
    assert.equal(health.bToA, 2);
    await second.stop();
});
