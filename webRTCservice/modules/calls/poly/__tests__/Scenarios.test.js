const { test } = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");

const {
    S,
    buildWebRtcScenario,
    transportOpenA,
    transportOpenB,
    aOffers,
    bOffers,
    aAnswers,
    bAnswers,
    bRejects,
    aEnds,
    bEnds,
    aCompletesEnd,
    bCompletesEnd,
    expectLegStates,
    expectInCall,
    expectRinging,
    expectEnded,
    expectReusable,
    expectMediaConnectedOnce,
    expectMediaDisconnected,
    expectNoMedia,
} = require("./helpers/scenarioHelpers");

test("A calls B -> B ringing, A calling", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);

    await aOffers(ctx, "offer-1");

    expectRinging(ctx);
    expectNoMedia(ctx);
});

test("A calls B -> B answers -> both inCall", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);

    await aOffers(ctx, "offer-1");
    await bAnswers(ctx, "answer-1");

    expectInCall(ctx);
    expectMediaConnectedOnce(ctx);
});

test("A calls B -> B declines -> A calls again -> B answers -> both inCall", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);

    await aOffers(ctx, "offer-1");
    await bRejects(ctx);
    expectLegStates(ctx, S.ENDING, S.REJECTED);
    await aCompletesEnd(ctx, "end-answer-1");
    expectReusable(ctx);
    expectNoMedia(ctx);

    await aOffers(ctx, "offer-2");
    await bAnswers(ctx, "answer-2");
    expectInCall(ctx);
    expectMediaConnectedOnce(ctx);
});

test("A ends -> clean teardown -> both reusable", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);
    await aOffers(ctx, "offer-1");
    await bAnswers(ctx, "answer-1");
    expectInCall(ctx);

    await aEnds(ctx);
    expectLegStates(ctx, S.CONNECTED, S.ENDING);
    expectMediaDisconnected(ctx, 1);
    await bCompletesEnd(ctx, "end-answer-b");
    expectEnded(ctx);
});

test("B ends -> clean teardown -> both reusable", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);
    await aOffers(ctx, "offer-1");
    await bAnswers(ctx, "answer-1");
    expectInCall(ctx);

    await bEnds(ctx);
    expectLegStates(ctx, S.ENDING, S.CONNECTED);
    expectMediaDisconnected(ctx, 1);
    await aCompletesEnd(ctx, "end-answer-a");
    expectEnded(ctx);
});

test("long reuse soak: repeated decline/end cycles stay reusable and reconnect cleanly", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);

    const rounds = 8;
    for (let i = 1; i <= rounds; i += 1) {
        await aOffers(ctx, `offer-${i}`);
        if (i % 2 === 0) {
            await bRejects(ctx);
            expectLegStates(ctx, S.ENDING, S.REJECTED);
            await aCompletesEnd(ctx, `end-answer-${i}`);
        } else {
            await bAnswers(ctx, `answer-${i}`);
            expectInCall(ctx);
            await aEnds(ctx);
            expectLegStates(ctx, S.CONNECTED, S.ENDING);
            await bCompletesEnd(ctx, `end-answer-${i}`);
        }
        expectReusable(ctx);
    }

    await aOffers(ctx, "final-offer");
    await bAnswers(ctx, "final-answer");
    expectInCall(ctx);
    // Odd rounds establish media before ending (4 times for rounds=8), then one
    // final successful call at the end => 5 total connect operations.
    const expectedConnects = Math.ceil(rounds / 2) + 1;
    expectMediaDisconnected(ctx, Math.ceil(rounds / 2));
    if (ctx.media.connects.length !== expectedConnects) {
        throw new Error(`expected ${expectedConnects} media connects, got ${ctx.media.connects.length}`);
    }
});

test("glare after reuse converges and still tears down cleanly", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);

    await aOffers(ctx, "offer-1");
    await bRejects(ctx);
    await aCompletesEnd(ctx, "end-answer-1");
    expectReusable(ctx);

    await Promise.all([
        aOffers(ctx, "offer-glare-a"),
        bOffers(ctx, "offer-glare-b"),
    ]);
    await aAnswers(ctx, "answer-glare-a");
    await bAnswers(ctx, "answer-glare-b");
    expectInCall(ctx);

    await bEnds(ctx);
    await aCompletesEnd(ctx, "end-answer-glare");
    expectEnded(ctx);
});

test("double-end race then immediate redial does not leak teardown state", async () => {
    const ctx = buildWebRtcScenario();
    await transportOpenA(ctx);
    await transportOpenB(ctx);
    await aOffers(ctx, "offer-1");
    await bAnswers(ctx, "answer-1");
    expectInCall(ctx);

    await Promise.all([aEnds(ctx), bEnds(ctx)]);
    await Promise.all([
        aCompletesEnd(ctx, "end-answer-a"),
        bCompletesEnd(ctx, "end-answer-b"),
    ]);
    expectReusable(ctx);
    expectMediaDisconnected(ctx, 1);

    await aOffers(ctx, "offer-2");
    await bAnswers(ctx, "answer-2");
    expectInCall(ctx);
});

test("parallel calls that share a callee label stay isolated", async () => {
    const first = buildWebRtcScenario();
    const second = buildWebRtcScenario();

    await transportOpenA(first);
    await transportOpenB(first);
    await transportOpenA(second);
    await transportOpenB(second);

    await aOffers(first, "offer-a");
    await bAnswers(first, "answer-a");
    await aOffers(second, "offer-c");
    await bAnswers(second, "answer-c");

    expectInCall(first);
    expectInCall(second);

    await aEnds(second);
    await bCompletesEnd(second, "end-second");

    // Ending one pair must not disturb the other active pair.
    expectInCall(first);
    expectEnded(second);
});

test("alice in call with julie while bob calls alice: bob can be rejected without affecting julie call", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-alice-julie");
    await bAnswers(julieCall, "answer-julie");
    expectInCall(julieCall);
    expectMediaConnectedOnce(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-alice");
    expectRinging(bobCall);
    expectNoMedia(bobCall);

    // Alice rejects Bob while staying in the active Alice<->Julie call.
    await bRejects(bobCall);
    expectLegStates(bobCall, S.ENDING, S.REJECTED);
    await aCompletesEnd(bobCall, "end-bob");
    expectEnded(bobCall);

    // Julie call stays fully active and bridged throughout Bob rejection.
    expectInCall(julieCall);
    expectMediaConnectedOnce(julieCall);
});

test("alice rejects bob while in julie call, then julie redials and alice answers", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-alice-julie");
    await bAnswers(julieCall, "answer-julie");
    expectInCall(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-alice");
    expectRinging(bobCall);

    // Alice hangs up/rejects Bob and Bob gets fully torn down (reneg completed).
    await bRejects(bobCall);
    expectLegStates(bobCall, S.ENDING, S.REJECTED);
    await aCompletesEnd(bobCall, "end-bob");
    expectEnded(bobCall);

    // Alice remains in Julie call until Julie ends it.
    expectInCall(julieCall);
    await bEnds(julieCall);
    await aCompletesEnd(julieCall, "end-julie");
    expectEnded(julieCall);

    // Julie calls again; Alice answers successfully.
    const julieRedial = buildWebRtcScenario({ aId: "julie", bId: "alice" });
    await transportOpenA(julieRedial);
    await transportOpenB(julieRedial);
    await aOffers(julieRedial, "offer-julie-redial");
    await bAnswers(julieRedial, "answer-alice-redial");
    expectInCall(julieRedial);
    expectMediaConnectedOnce(julieRedial);
});

test("alice accepts bob while in julie call: julie call is ended and bob becomes active", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-alice-julie");
    await bAnswers(julieCall, "answer-julie");
    expectInCall(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-alice");
    expectRinging(bobCall);

    // Switch policy: answering Bob implies tearing down Julie first.
    await bEnds(julieCall);
    await aCompletesEnd(julieCall, "end-julie-switch");
    expectEnded(julieCall);
    expectMediaDisconnected(julieCall, 1);

    await bAnswers(bobCall, "answer-alice-bob");
    expectInCall(bobCall);
    expectMediaConnectedOnce(bobCall);
});

test("alice in julie call, bob calls then bob is rejected and redials, second attempt can be answered", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-alice-julie");
    await bAnswers(julieCall, "answer-julie");
    expectInCall(julieCall);

    const bobFirst = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobFirst);
    await transportOpenB(bobFirst);
    await aOffers(bobFirst, "offer-bob-1");
    await bRejects(bobFirst);
    await aCompletesEnd(bobFirst, "end-bob-1");
    expectEnded(bobFirst);
    expectInCall(julieCall);

    // End Julie, then accept Bob's redial.
    await bEnds(julieCall);
    await aCompletesEnd(julieCall, "end-julie-before-bob-2");
    expectEnded(julieCall);

    const bobSecond = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobSecond);
    await transportOpenB(bobSecond);
    await aOffers(bobSecond, "offer-bob-2");
    await bAnswers(bobSecond, "answer-bob-2");
    expectInCall(bobSecond);
});

test("alice in julie call, two incoming (bob and charlie) can be declined without touching active media", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-julie-active");
    await bAnswers(julieCall, "answer-julie-active");
    expectInCall(julieCall);
    expectMediaConnectedOnce(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob");
    await bRejects(bobCall);
    await aCompletesEnd(bobCall, "end-bob");
    expectEnded(bobCall);

    const charlieCall = buildWebRtcScenario({ aId: "charlie", bId: "alice" });
    await transportOpenA(charlieCall);
    await transportOpenB(charlieCall);
    await aOffers(charlieCall, "offer-charlie");
    await bRejects(charlieCall);
    await aCompletesEnd(charlieCall, "end-charlie");
    expectEnded(charlieCall);

    expectInCall(julieCall);
    expectMediaConnectedOnce(julieCall);
});

test("switch from julie to bob then back to julie redial keeps teardown and media boundaries clean", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-julie-1");
    await bAnswers(julieCall, "answer-julie-1");
    expectInCall(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-switch");

    // Switch to Bob.
    await bEnds(julieCall);
    await aCompletesEnd(julieCall, "end-julie-switch");
    await bAnswers(bobCall, "answer-bob-switch");
    expectEnded(julieCall);
    expectInCall(bobCall);

    // Bob ends; Alice becomes available.
    await bEnds(bobCall);
    await aCompletesEnd(bobCall, "end-bob-after-switch");
    expectEnded(bobCall);

    const julieRedial = buildWebRtcScenario({ aId: "julie", bId: "alice" });
    await transportOpenA(julieRedial);
    await transportOpenB(julieRedial);
    await aOffers(julieRedial, "offer-julie-2");
    await bAnswers(julieRedial, "answer-julie-2");
    expectInCall(julieRedial);
    expectMediaConnectedOnce(julieRedial);
});

test("timing jitter: bob and julie call alice in parallel, answer one reject one", async () => {
    const variants = [
        { accepted: "bob", acceptDelayMs: 1, rejectDelayMs: 6 },
        { accepted: "julie", acceptDelayMs: 2, rejectDelayMs: 8 },
        { accepted: "bob", acceptDelayMs: 7, rejectDelayMs: 1 },
        { accepted: "julie", acceptDelayMs: 9, rejectDelayMs: 2 },
    ];

    for (const variant of variants) {
        const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
        const julieCall = buildWebRtcScenario({ aId: "julie", bId: "alice" });

        await Promise.all([
            transportOpenA(bobCall),
            transportOpenB(bobCall),
            transportOpenA(julieCall),
            transportOpenB(julieCall),
        ]);
        await Promise.all([
            aOffers(bobCall, `offer-bob-${variant.accepted}-${variant.acceptDelayMs}`),
            aOffers(julieCall, `offer-julie-${variant.accepted}-${variant.rejectDelayMs}`),
        ]);

        expectRinging(bobCall);
        expectRinging(julieCall);

        if (variant.accepted === "bob") {
            await sleep(variant.acceptDelayMs);
            await bAnswers(bobCall, "answer-bob");
            await sleep(variant.rejectDelayMs);
            await bRejects(julieCall);
            await aCompletesEnd(julieCall, "end-julie-rejected");
            expectInCall(bobCall);
            expectEnded(julieCall);
            expectMediaConnectedOnce(bobCall);
            expectNoMedia(julieCall);
        } else {
            await sleep(variant.acceptDelayMs);
            await bAnswers(julieCall, "answer-julie");
            await sleep(variant.rejectDelayMs);
            await bRejects(bobCall);
            await aCompletesEnd(bobCall, "end-bob-rejected");
            expectInCall(julieCall);
            expectEnded(bobCall);
            expectMediaConnectedOnce(julieCall);
            expectNoMedia(bobCall);
        }
    }
});

test("timing jitter: alice ends julie while bob is ringing then accepts bob", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-alice-julie");
    await bAnswers(julieCall, "answer-julie");
    expectInCall(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-ringing");
    expectRinging(bobCall);

    // Race: tear down Julie while Bob is waiting.
    await Promise.all([
        (async () => {
            await sleep(3);
            await bEnds(julieCall);
            await aCompletesEnd(julieCall, "end-julie-before-bob-answer");
        })(),
        (async () => {
            await sleep(6);
            await bAnswers(bobCall, "answer-bob-after-julie-end");
        })(),
    ]);

    expectEnded(julieCall);
    expectInCall(bobCall);
    expectMediaDisconnected(julieCall, 1);
    expectMediaConnectedOnce(bobCall);
});

test("timing jitter: switch to bob, bob ends quickly, julie redials quickly and reconnects", async () => {
    const julieCall = buildWebRtcScenario({ aId: "alice", bId: "julie" });
    await transportOpenA(julieCall);
    await transportOpenB(julieCall);
    await aOffers(julieCall, "offer-julie-initial");
    await bAnswers(julieCall, "answer-julie-initial");
    expectInCall(julieCall);

    const bobCall = buildWebRtcScenario({ aId: "bob", bId: "alice" });
    await transportOpenA(bobCall);
    await transportOpenB(bobCall);
    await aOffers(bobCall, "offer-bob-switch");

    await Promise.all([
        (async () => {
            await sleep(2);
            await bEnds(julieCall);
            await aCompletesEnd(julieCall, "end-julie-for-switch");
        })(),
        (async () => {
            await sleep(5);
            await bAnswers(bobCall, "answer-bob-switch");
            await sleep(2);
            await bEnds(bobCall);
            await aCompletesEnd(bobCall, "end-bob-quick");
        })(),
    ]);

    expectEnded(julieCall);
    expectEnded(bobCall);

    const julieRedial = buildWebRtcScenario({ aId: "julie", bId: "alice" });
    await transportOpenA(julieRedial);
    await transportOpenB(julieRedial);
    await aOffers(julieRedial, "offer-julie-redial-fast");
    await bAnswers(julieRedial, "answer-julie-redial-fast");

    expectInCall(julieRedial);
    expectMediaConnectedOnce(julieRedial);
});
