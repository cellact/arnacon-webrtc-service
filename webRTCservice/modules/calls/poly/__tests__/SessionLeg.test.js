const { test } = require("node:test");
const assert = require("node:assert/strict");

const { LEG_STATES: S } = require("../states");
const { LEG_INTENTS: I, LEG_EVENTS, makeLegEvent } = require("../ports");
const { makeWebRtcLeg, silentLogger } = require("./fakes");
const { WebRtcLeg } = require("../legs/WebRtcLeg");
const { CallNegotiationPort } = require("../ports");

test("cancel terminates; a webrtc end defers (ENDING) until the client answers", async () => {
    const c = makeWebRtcLeg("c");
    c.leg.setState(S.RINGING, { from: "self" });
    await c.leg.cancel({ from: "peer" });
    assert.equal(c.leg.state, S.CANCELED);

    // P-initiated webrtc end sends the end-call offer and stays ENDING (deferred):
    // it returns to connected only when the client's end-call answer arrives.
    const e = makeWebRtcLeg("e");
    e.leg.setState(S.IN_CALL, { from: "self" });
    await e.leg.endCall({ from: "peer" });
    assert.equal(e.leg.state, S.ENDING);

    // both went through negotiation.endCall (cancel passes mode=cancel)
    assert.equal(c.negotiation.named("endCall")[0].mode, "cancel");
    assert.equal(e.negotiation.named("endCall").length, 1);
});

test("a sip end disconnects the leg (BYE kills the dialog, no answer comes back)", async () => {
    const { makeSipLeg } = require("./fakes");
    const s = makeSipLeg("+15551234");
    s.leg.setState(S.IN_CALL, { from: "self" });
    await s.leg.endCall({ from: "peer" });
    assert.equal(s.leg.state, S.DISCONNECTED);
});

test("illegal intent throws and does not change state", async () => {
    const { leg } = makeWebRtcLeg("x");
    assert.equal(leg.state, S.DISCONNECTED);
    await assert.rejects(() => leg.answer({}), /Illegal intent "answer"/);
    assert.equal(leg.state, S.DISCONNECTED);
});

test("idempotent ring: ringing again is a no-op", async () => {
    const { leg, negotiation } = makeWebRtcLeg("r");
    leg.setState(S.CONNECTED, { from: "self" });
    await leg.ring({ from: "peer" });
    await leg.ring({ from: "peer" });
    assert.equal(negotiation.named("ring").length, 1);
    assert.equal(leg.state, S.RINGING);
});

test("state change emits to observers with prev/next and cause", async () => {
    const { leg } = makeWebRtcLeg("o");
    const seen = [];
    leg.onStateChange((e) => seen.push([e.prevState, e.state, e.cause.from]));
    await leg.connect({});
    assert.deepEqual(seen, [[S.DISCONNECTED, S.CONNECTING, "self"], [S.CONNECTING, S.CONNECTED, "self"]]);
});

test("ingress END (client offer) parks the leg in END_REQUESTED for P to ack", async () => {
    const { leg, negotiation } = makeWebRtcLeg("i");
    leg.setState(S.IN_CALL, { from: "self" });
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END, { type: "offer", sdp: "end-offer" }));
    // The leg does NOT answer inline -- P drives ackEnd (decides WHEN).
    assert.equal(leg.state, S.END_REQUESTED);
    assert.equal(negotiation.named("endCall").length, 0);
    assert.equal(leg._pendingEndOffer.sdp, "end-offer", "the client's end-call offer is stashed for ackEnd");
});

test("ackEnd answers the stashed end-call offer and returns the leg to CONNECTED", async () => {
    const { leg, negotiation } = makeWebRtcLeg("k");
    leg.setState(S.IN_CALL, { from: "self" });
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END, { type: "offer", sdp: "end-offer" }));
    await leg.ackEnd({ from: "self" });
    assert.equal(leg.state, S.CONNECTED);
    assert.equal(negotiation.named("ackEnd").length, 1);
    assert.equal(leg._pendingEndOffer, null, "stash cleared after ackEnd");
});

test("ingress END answer while ENDING completes a P-initiated end -> CONNECTED", async () => {
    const { leg, negotiation } = makeWebRtcLeg("e2");
    leg.setState(S.ENDING, { from: "self" });
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "end-ans" }));
    assert.equal(leg.state, S.CONNECTED);
    assert.equal(negotiation.named("endCall")[0].mode, "remote", "the client's end-call answer is applied");
});

test("idempotent teardown: trailing end-call renegotiation is absorbed without state churn", async () => {
    const { leg, negotiation } = makeWebRtcLeg("t");
    leg.setState(S.IN_CALL, { from: "self" });
    const seen = [];
    leg.onStateChange((e) => seen.push([e.prevState, e.state]));

    // First end parks us once: inCall -> endRequested.
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END, { type: "offer", sdp: "o" }));
    assert.equal(leg.state, S.END_REQUESTED);

    // Trailing end-call answers arrive (teardown glare) while still END_REQUESTED.
    // They must be absorbed (negotiation answers the client) but must NOT churn
    // state or re-emit -- that was the log cascade.
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "x" }));
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp: "x" }));
    assert.equal(leg.state, S.END_REQUESTED);
    assert.deepEqual(seen, [[S.IN_CALL, S.END_REQUESTED]], "only one settle, no re-cycling");
    assert.equal(negotiation.named("endCall").length, 2, "each trailing end-call SDP is still absorbed");
});

test("remote BYE (sip) disconnects the leg", async () => {
    const { makeSipLeg } = require("./fakes");
    const { leg } = makeSipLeg("+15551234");
    leg.setState(S.IN_CALL, { from: "self" });
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.REMOTE_BYE));
    assert.equal(leg.state, S.DISCONNECTED);
});

test("from is recorded on the leg", async () => {
    const { leg } = makeWebRtcLeg("f");
    leg.setState(S.IN_CALL, { from: "self" });
    await leg.endCall({ from: "peer-endpoint" });
    assert.equal(leg.from, "peer-endpoint");
});

test("per-leg signaling queue serializes overlapping negotiation ops", async () => {
    const order = [];
    let resolveRing;
    class SlowNeg extends CallNegotiationPort {
        async ring() {
            order.push("ring-start");
            await new Promise((r) => { resolveRing = r; });
            order.push("ring-end");
        }
        async endCall() { order.push("end-start"); order.push("end-end"); }
        getMediaEndpoint() { return { id: "ep", kind: "webrtc" }; }
        async dispose() {}
    }
    const leg = new WebRtcLeg({ id: "q", endpoint: "q", negotiation: new SlowNeg(), logger: silentLogger });
    leg.setState(S.CONNECTED, { from: "self" });

    const ringP = leg.ring({ from: "peer" });      // starts, then blocks inside ring
    leg.setState(S.IN_CALL, { from: "self" });
    const endP = leg.endCall({ from: "peer" });     // must wait for ring to finish first

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ["ring-start"], "endCall must not start while ring is in-flight");

    resolveRing();
    await Promise.all([ringP, endP]);
    assert.deepEqual(order, ["ring-start", "ring-end", "end-start", "end-end"]);
});
