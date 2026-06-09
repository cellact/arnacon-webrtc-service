const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PolySessionRegistry, pairKey } = require("../PolySessionRegistry");
const { LegFactory } = require("../LegFactory");
const { FakeNegotiation, FakeMediaController, silentLogger } = require("./fakes");

function buildRegistry() {
    const negotiationFactory = ({ id }) => new FakeNegotiation({ id });
    const legFactory = new LegFactory({
        webRtcNegotiationFactory: negotiationFactory,
        sipNegotiationFactory: negotiationFactory,
        logger: silentLogger,
    });
    return new PolySessionRegistry({ legFactory, mediaController: new FakeMediaController(), logger: silentLogger });
}

test("same identity pair resolves to one PolySession regardless of order or label form", () => {
    const reg = buildRegistry();
    const r1 = reg.resolve({
        a: { endpoint: "972557140015.secnum.global", kind: "webrtc" },
        b: { endpoint: "972557140022", kind: "webrtc" },
        target: "a",
    });
    // reversed order + ENS form for the other party -> same PolySession
    const r2 = reg.resolve({
        a: { endpoint: "972557140022.secnum.global", kind: "webrtc" },
        b: { endpoint: "972557140015", kind: "webrtc" },
        target: "972557140022.secnum.global",
    });
    assert.equal(r1.poly, r2.poly);
    assert.equal(r1.key, r2.key);
});

test("resolve targets the correct leg by endpoint", () => {
    const reg = buildRegistry();
    const { poly } = reg.resolve({
        a: { endpoint: "alice", kind: "webrtc" },
        b: { endpoint: "bob", kind: "sip" },
        target: "a",
    });
    const toBob = reg.resolve({ a: { endpoint: "alice", kind: "webrtc" }, b: { endpoint: "bob", kind: "sip" }, target: "bob" });
    assert.equal(toBob.poly, poly);
    assert.equal(toBob.leg.endpoint, "bob");
    assert.equal(toBob.leg.kind, "sip");
});

test("different pair creates a different PolySession", () => {
    const reg = buildRegistry();
    const r1 = reg.resolve({ a: { endpoint: "alice", kind: "webrtc" }, b: { endpoint: "bob", kind: "webrtc" } });
    const r2 = reg.resolve({ a: { endpoint: "alice", kind: "webrtc" }, b: { endpoint: "carol", kind: "webrtc" } });
    assert.notEqual(r1.poly, r2.poly);
});

test("pairKey is order-independent and label-normalized", () => {
    assert.equal(pairKey("A.x.global", "b"), pairKey("b", "a"));
});

test("destroy removes the PolySession and frees the key", async () => {
    const reg = buildRegistry();
    const { key } = reg.resolve({ a: { endpoint: "alice", kind: "webrtc" }, b: { endpoint: "bob", kind: "webrtc" } });
    await reg.destroy(key);
    assert.equal(reg.get(key), null);
    const again = reg.resolve({ a: { endpoint: "alice", kind: "webrtc" }, b: { endpoint: "bob", kind: "webrtc" } });
    assert.equal(again.key, key);
});

test("routing-driven peer kind: webrtc<->webrtc vs webrtc<->sip produce the right leg kinds", () => {
    const reg = buildRegistry();
    const secnum = reg.resolve({
        a: { endpoint: "alice", kind: "webrtc" },
        b: { endpoint: "bob", kind: "webrtc", role: "callee" },
        target: "a",
    });
    assert.equal(secnum.poly.legs.a.kind, "webrtc");
    assert.equal(secnum.poly.legs.b.kind, "webrtc");

    const sbc = reg.resolve({
        a: { endpoint: "alice", kind: "webrtc" },
        b: { endpoint: "+15551230000", kind: "sip" },
        target: "a",
    });
    assert.equal(sbc.poly.legs.a.kind, "webrtc");
    assert.equal(sbc.poly.legs.b.kind, "sip");
});

test("getByEndpoint finds the PolySession by either party (label-normalized)", () => {
    const reg = buildRegistry();
    const { poly } = reg.resolve({
        a: { endpoint: "972557140015.secnum.global", kind: "webrtc" },
        b: { endpoint: "bob@example.com", kind: "sip" },
        target: "a",
    });
    assert.equal(reg.getByEndpoint("972557140015"), poly);
    assert.equal(reg.getByEndpoint("972557140015.secnum.global"), poly);
    assert.equal(reg.getByEndpoint("BOB@example.com"), poly);
    assert.equal(reg.getByEndpoint("nobody"), null);
});
