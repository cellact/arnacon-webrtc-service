const { test } = require("node:test");
const assert = require("node:assert/strict");

const { reconcile } = require("../ReconcileRules");
const { LEG_STATES: S } = require("../states");
const { LEG_INTENTS: I } = require("../ports");

function snap(aState, bState, mediaConnected = false) {
    return { a: { state: aState, kind: "webrtc" }, b: { state: bState, kind: "webrtc" }, mediaConnected };
}

// A reconcile pass triggered by a leg entering CALLING (a fresh client ring).
const ringEvent = { state: S.CALLING, cause: { reason: "client-offer" } };

function intents(actions) {
    return actions.filter((x) => x.kind === "intent");
}
function mediaOps(actions) {
    return actions.filter((x) => x.kind === "media").map((x) => x.op);
}

test("teardown beats progress: inCall vs failed (dropped) ends the inCall side, stops media", () => {
    const actions = reconcile(snap(S.IN_CALL, S.FAILED, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    const ends = intents(actions);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0], { kind: "intent", leg: "a", intent: I.END, from: "b" });
});

test("calling vs failed (e.g. sip ring rejected) ends the calling caller", () => {
    const actions = reconcile(snap(S.CALLING, S.FAILED, false));
    assert.deepEqual(mediaOps(actions), []);
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.END, from: "b" }]);
});

test("inCall vs disconnected (peer gone, e.g. sip BYE) ends the inCall side, stops media", () => {
    // You cannot be in a call by yourself: a disconnected peer ends the inCall leg.
    const actions = reconcile(snap(S.IN_CALL, S.DISCONNECTED, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.END, from: "b" }]);
});

test("inCall vs connected (idle peer) ends the inCall side", () => {
    const actions = reconcile(snap(S.CONNECTED, S.IN_CALL, false));
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "b", intent: I.END, from: "a" }]);
});

test("inCall vs ringing is allowed (pickup in flight): the inCall side is NOT ended", () => {
    // s1 ringing + s2 inCall is a legitimate setup transient -- never end s2.
    const actions = reconcile(snap(S.RINGING, S.IN_CALL, false));
    assert.equal(intents(actions).some((x) => x.intent === I.END), false, "no end while ringing");
});

test("end-requested: P acks the ender and ends the in-call peer, media down", () => {
    const actions = reconcile(snap(S.END_REQUESTED, S.IN_CALL, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    assert.deepEqual(intents(actions), [
        { kind: "intent", leg: "a", intent: I.ACK_END, from: "self" },
        { kind: "intent", leg: "b", intent: I.END, from: "a" },
    ]);
});

test("settled after end: connected + ending does nothing more (no loop)", () => {
    const actions = reconcile(snap(S.CONNECTED, S.ENDING, false));
    assert.deepEqual(intents(actions), []);
    assert.deepEqual(mediaOps(actions), []);
});

test("teardown: ending side does not get re-ended; peer (ringing) gets ended", () => {
    const actions = reconcile(snap(S.RINGING, S.ENDING, false));
    const ends = intents(actions);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0], { kind: "intent", leg: "a", intent: I.END, from: "b" });
});

test("no double disconnect / no throw when both sides tear down", () => {
    const actions = reconcile(snap(S.ENDING, S.FAILED, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    // Neither side is an active call worth ending (both already tearing down).
    assert.equal(intents(actions).length, 0);
});

test("fresh ring: ackConnected the caller once, then rings the connected side", () => {
    const actions = reconcile(snap(S.CALLING, S.CONNECTED, false), ringEvent);
    assert.deepEqual(intents(actions), [
        { kind: "intent", leg: "a", intent: I.ACK_CONNECTED, from: "self" },
        { kind: "intent", leg: "b", intent: I.RING, from: "a" },
    ]);
    assert.deepEqual(mediaOps(actions), []);
});

test("fresh ring with a disconnected peer: ackConnected, then connect the peer first", () => {
    const actions = reconcile(snap(S.CALLING, S.DISCONNECTED, false), ringEvent);
    assert.deepEqual(intents(actions), [
        { kind: "intent", leg: "a", intent: I.ACK_CONNECTED, from: "self" },
        { kind: "intent", leg: "b", intent: I.CONNECT, from: "a" },
    ]);
});

test("peer just rang: ackRing the caller (gated on the RINGING event)", () => {
    const actions = reconcile(snap(S.CALLING, S.RINGING, false), { state: S.RINGING });
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.ACK_RING, from: "b" }]);
});

test("no fresh-ring event: do not ack (a later pass must not re-ack the same ring)", () => {
    const actions = reconcile(snap(S.CALLING, S.CONNECTED, false), { state: S.CONNECTED });
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "b", intent: I.RING, from: "a" }]);
});

test("ackConnected fires even when the peer is not yet reachable", () => {
    const actions = reconcile(snap(S.CALLING, S.CONNECTING, false), ringEvent);
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.ACK_CONNECTED, from: "self" }]);
});

test("progress: ringing vs ended (reusable) rings the reusable side", () => {
    const actions = reconcile(snap(S.ENDED, S.RINGING, false));
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.RING, from: "b" }]);
});

test("picked up: inCall vs ringing finalizes peer and connects media", () => {
    const actions = reconcile(snap(S.IN_CALL, S.RINGING, false));
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "b", intent: I.ANSWER, from: "a" }]);
    assert.deepEqual(mediaOps(actions), ["connect"]);
});

test("steady: both inCall connects media exactly once (idempotent)", () => {
    assert.deepEqual(mediaOps(reconcile(snap(S.IN_CALL, S.IN_CALL, false))), ["connect"]);
    assert.deepEqual(mediaOps(reconcile(snap(S.IN_CALL, S.IN_CALL, true))), []);
});

test("idle: both connected does nothing", () => {
    assert.deepEqual(reconcile(snap(S.CONNECTED, S.CONNECTED, false)), []);
});

test("teardown priority holds even if the other side is mid-progress", () => {
    const actions = reconcile(snap(S.ANSWERING, S.CANCELING, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "a", intent: I.END, from: "b" }]);
});
