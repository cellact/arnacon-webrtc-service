const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PolySession } = require("../PolySession");
const { LEG_STATES: S } = require("../states");
const { LEG_EVENTS, makeLegEvent } = require("../ports");
const { FakeMediaController, makeWebRtcLeg, makeSipLeg, silentLogger } = require("./fakes");

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

test("webrtc<->webrtc happy path: connect, ring, answer, media GO; then end tears down", async () => {
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

    // alice ends -> media stops, bob gets end-call from alice
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    assert.equal(a.leg.state, S.ENDED);
    assert.equal(b.leg.state, S.ENDED);
    assert.equal(media.disconnects.length, 1);
    const bEnds = b.negotiation.named("endCall");
    assert.equal(bEnds.length, 1);
    assert.equal(bEnds[0].from, "alice");
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

test("one side disconnects mid-call: peer is ended, media stops, disconnected side left as-is", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly, media } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));

    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
    assert.equal(b.leg.state, S.DISCONNECTED);
    assert.equal(a.leg.state, S.ENDED);
    assert.equal(media.disconnects.length, 1);
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
    assert.equal(b.leg.state, S.ENDED);
    assert.equal(a.leg.state, S.ENDED);
    assert.equal(a.negotiation.named("endCall")[0].from, "+15551234");
    assert.equal(media.disconnects.length, 1);
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
    assert.equal(a.leg.state, S.ENDED);
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

test("second call reuse: after end, a fresh offer rings the peer again", async () => {
    const a = makeWebRtcLeg("alice");
    const b = makeWebRtcLeg("bob");
    const { poly } = buildPoly(a, b);
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o" }));
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp: "ans" }));
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
    assert.equal(a.leg.state, S.ENDED);
    assert.equal(b.leg.state, S.ENDED);

    // new call on the existing (ended==connected-idle) transports
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp: "o2" }));
    assert.equal(a.leg.state, S.CALLING);
    assert.equal(b.leg.state, S.RINGING);
    assert.equal(b.negotiation.named("ring").length, 2);
});
