const { test } = require("node:test");

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
