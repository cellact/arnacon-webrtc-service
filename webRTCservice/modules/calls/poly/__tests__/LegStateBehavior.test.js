const { test } = require("node:test");
const assert = require("node:assert/strict");

const { assertIntentLegal, isIntentLegal } = require("../LegStateBehavior");
const { LEG_STATES: S } = require("../states");
const { LEG_INTENTS: I } = require("../ports");

test("answer is illegal from disconnected and throws (no silent no-op)", () => {
    assert.equal(isIntentLegal(S.DISCONNECTED, I.ANSWER), false);
    assert.throws(() => assertIntentLegal(S.DISCONNECTED, I.ANSWER), /Illegal intent "answer"/);
});

test("endCall is legal from inCall", () => {
    assert.equal(isIntentLegal(S.IN_CALL, I.END), true);
    assert.doesNotThrow(() => assertIntentLegal(S.IN_CALL, I.END));
});

test("ring is legal from connected and from ended/canceled/rejected (reuse)", () => {
    for (const s of [S.CONNECTED, S.ENDED, S.CANCELED, S.REJECTED]) {
        assert.equal(isIntentLegal(s, I.RING), true, `ring should be legal from ${s}`);
    }
});

test("ring is illegal while inCall", () => {
    assert.equal(isIntentLegal(S.IN_CALL, I.RING), false);
});

test("connect is legal from failed (recovery) but answer is not", () => {
    assert.equal(isIntentLegal(S.FAILED, I.CONNECT), true);
    assert.equal(isIntentLegal(S.FAILED, I.ANSWER), false);
});

test("unknown state throws", () => {
    assert.throws(() => assertIntentLegal("bogus", I.RING), /unknown state/);
});
