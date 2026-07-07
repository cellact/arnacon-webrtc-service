const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PolyIngress } = require("../PolyIngress");
const { PolySessionRegistry } = require("../PolySessionRegistry");
const { LegFactory } = require("../LegFactory");
const { LEG_EVENTS, LEG_STATES: S } = require("../index");
const { FakeNegotiation, FakeMediaController, silentLogger } = require("./fakes");

function build() {
    const negotiationFactory = ({ id }) => new FakeNegotiation({ id });
    const legFactory = new LegFactory({
        webRtcNegotiationFactory: negotiationFactory,
        sipNegotiationFactory: negotiationFactory,
        logger: silentLogger,
    });
    const registry = new PolySessionRegistry({ legFactory, mediaController: new FakeMediaController(), logger: silentLogger });
    const ingress = new PolyIngress({ registry, logger: silentLogger });
    return { registry, ingress };
}

const parties = {
    a: { endpoint: "alice", kind: "webrtc" },
    b: { endpoint: "bob", kind: "webrtc" },
    target: "alice",
};

test("offer with active audio maps to OFFER (fresh ring)", () => {
    const { ingress } = build();
    const ev = ingress.toLegEvent("offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=sendrecv\r\n" });
    assert.equal(ev.type, LEG_EVENTS.OFFER);
});

test("late inactive offer maps to END_RENEGOTIATION (teardown, not ring)", () => {
    const { ingress } = build();
    const ev = ingress.toLegEvent("offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=inactive\r\n" });
    assert.equal(ev.type, LEG_EVENTS.END_RENEGOTIATION);
});

test("forced offer meta keeps datachannel-only offer as OFFER", () => {
    const { ingress } = build();
    const ev = ingress.toLegEvent("offer", { sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" }, { forceOffer: true });
    assert.equal(ev.type, LEG_EVENTS.OFFER);
});

test("call actions map to their leg events", () => {
    const { ingress } = build();
    assert.equal(ingress.toLegEvent("answer", {}).type, LEG_EVENTS.ANSWER);
    assert.equal(ingress.toLegEvent("end", {}).type, LEG_EVENTS.END);
    assert.equal(ingress.toLegEvent("reject", {}).type, LEG_EVENTS.REJECT);
    assert.equal(ingress.toLegEvent("end-call", {}).type, LEG_EVENTS.END_RENEGOTIATION);
    assert.equal(ingress.toLegEvent("bogus", {}), null);
});

test("deliver routes a ring offer through the registry and reconciles the peer", async () => {
    const { ingress, registry } = build();
    // bring both up
    await ingress.deliver(parties, "answer", {}); // no-op-ish; just ensures resolve works
    // proper flow: open transports first by delivering transport events directly
    const { poly } = registry.resolve(parties);
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });

    await ingress.deliver(parties, "offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=sendrecv\r\n" });
    assert.equal(poly.legs.a.state, S.CALLING);
    assert.equal(poly.legs.b.state, S.RINGING);
});

test("unsupported action is ignored without throwing", async () => {
    const { ingress } = build();
    const result = await ingress.deliver(parties, "totally-unknown", {});
    assert.equal(result, null);
});

test("cancel action routes through registry to caller leg state", async () => {
    const { ingress, registry } = build();
    const { poly } = registry.resolve(parties);
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await ingress.deliver(parties, "offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=sendrecv\r\n" });
    assert.equal(poly.legs.a.state, S.CALLING);
    assert.equal(poly.legs.b.state, S.RINGING);

    await ingress.deliver(parties, "cancel", {});
    assert.equal(poly.legs.a.state, S.CANCELED);
});

test("reject action delivered to callee transitions to rejected and ends caller", async () => {
    const { ingress, registry } = build();
    const { poly } = registry.resolve(parties);
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await ingress.deliver(parties, "offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=sendrecv\r\n" });

    await ingress.deliver({ ...parties, target: "bob" }, "reject", {});
    assert.equal(poly.legs.b.state, S.REJECTED);
    assert.equal(poly.legs.a.state, S.ENDING);
});

test("end-call answer is routed as END_RENEGOTIATION completion", async () => {
    const { ingress, registry } = build();
    const { poly } = registry.resolve(parties);
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await ingress.deliver(parties, "offer", { sdp: "v=0\r\nm=audio 9 UDP\r\na=sendrecv\r\n" });
    await ingress.deliver({ ...parties, target: "bob" }, "answer", { sdp: "ans" });
    assert.equal(poly.legs.a.state, S.IN_CALL);
    assert.equal(poly.legs.b.state, S.IN_CALL);

    await ingress.deliver(parties, "end", {});
    assert.equal(poly.legs.a.state, S.CONNECTED);
    assert.equal(poly.legs.b.state, S.ENDING);

    await ingress.deliver({ ...parties, target: "bob" }, "end-call", { type: "answer", sdp: "end-ans" });
    assert.equal(poly.legs.b.state, S.CONNECTED);
});

test("ice and ice-batch actions reach aux handler without state churn", async () => {
    const { ingress, registry } = build();
    const { poly } = registry.resolve(parties);
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });

    await ingress.deliver(parties, "ice", { candidates: [{ candidate: "cand-1" }] });
    await ingress.deliver(parties, "ice-batch", { candidates: [{ candidate: "cand-2" }] });

    assert.equal(poly.legs.a.state, S.CONNECTED);
    assert.equal(poly.legs.a.negotiation.named("aux").length, 2);
});
