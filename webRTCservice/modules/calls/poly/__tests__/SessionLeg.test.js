const { test } = require("node:test");
const assert = require("node:assert/strict");

const { LEG_STATES: S } = require("../states");
const { LEG_INTENTS: I, LEG_EVENTS, makeLegEvent } = require("../ports");
const { makeWebRtcLeg, silentLogger } = require("./fakes");
const { WebRtcLeg } = require("../legs/WebRtcLeg");
const { CallNegotiationPort } = require("../ports");

test("cancel and end map to the same teardown negotiation on the leg", async () => {
    const c = makeWebRtcLeg("c");
    c.leg.setState(S.RINGING, { from: "self" });
    await c.leg.cancel({ from: "peer" });
    assert.equal(c.leg.state, S.CANCELED);

    const e = makeWebRtcLeg("e");
    e.leg.setState(S.IN_CALL, { from: "self" });
    await e.leg.endCall({ from: "peer" });
    assert.equal(e.leg.state, S.ENDED);

    // both went through negotiation.endCall (cancel passes mode=cancel)
    assert.equal(c.negotiation.named("endCall")[0].mode, "cancel");
    assert.equal(e.negotiation.named("endCall").length, 1);
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

test("ingress END settles the leg through its own teardown", async () => {
    const { leg, negotiation } = makeWebRtcLeg("i");
    leg.setState(S.IN_CALL, { from: "self" });
    await leg.handleIngress(makeLegEvent(LEG_EVENTS.END));
    assert.equal(leg.state, S.ENDED);
    assert.equal(negotiation.named("endCall")[0].mode, "remote");
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
