const { test } = require("node:test");
const assert = require("node:assert/strict");

const { reconcile } = require("../ReconcileRules");
const { LEG_STATES: S } = require("../states");
const { LEG_INTENTS: I } = require("../ports");

function snap(aState, bState, mediaConnected = false) {
    return { a: { state: aState, kind: "webrtc" }, b: { state: bState, kind: "webrtc" }, mediaConnected };
}

function intents(actions) {
    return actions.filter((x) => x.kind === "intent");
}
function mediaOps(actions) {
    return actions.filter((x) => x.kind === "media").map((x) => x.op);
}

test("teardown beats progress: inCall vs disconnected ends the inCall side, stops media", () => {
    const actions = reconcile(snap(S.IN_CALL, S.DISCONNECTED, true));
    assert.deepEqual(mediaOps(actions), ["disconnect"]);
    const ends = intents(actions);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0], { kind: "intent", leg: "a", intent: I.END, from: "b" });
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

test("progress: calling vs connected rings the connected side, from the caller", () => {
    const actions = reconcile(snap(S.CALLING, S.CONNECTED, false));
    assert.deepEqual(intents(actions), [{ kind: "intent", leg: "b", intent: I.RING, from: "a" }]);
    assert.deepEqual(mediaOps(actions), []);
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
