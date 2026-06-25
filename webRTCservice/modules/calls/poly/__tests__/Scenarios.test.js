const { test } = require("node:test");

const {
    S,
    buildWebRtcScenario,
    transportOpenA,
    transportOpenB,
    aOffers,
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
