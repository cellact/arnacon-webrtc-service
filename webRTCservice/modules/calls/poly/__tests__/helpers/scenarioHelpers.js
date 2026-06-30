const assert = require("node:assert/strict");

const { PolySession } = require("../../PolySession");
const { LEG_EVENTS, makeLegEvent } = require("../../ports");
const { LEG_STATES: S, canBeRung } = require("../../states");
const { FakeMediaController, makeWebRtcLeg, silentLogger } = require("../fakes");

function buildWebRtcScenario({
    deferConnectA = false,
    deferConnectB = false,
    aId = "alice",
    bId = "bob",
} = {}) {
    const a = makeWebRtcLeg(aId, { deferConnect: deferConnectA });
    const b = makeWebRtcLeg(bId, { deferConnect: deferConnectB });
    const media = new FakeMediaController();
    const poly = new PolySession({
        id: `${aId}<->${bId}`,
        legA: a.leg,
        legB: b.leg,
        mediaController: media,
        logger: silentLogger,
    });
    return { poly, media, a, b };
}

async function transportOpenA(ctx) {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
}

async function transportOpenB(ctx) {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
}

async function aOffers(ctx, sdp = "offer-a") {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, { sdp }));
}

async function bOffers(ctx, sdp = "offer-b") {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.OFFER, { sdp }));
}

async function aAnswers(ctx, sdp = "answer-a") {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.ANSWER, { sdp }));
}

async function bAnswers(ctx, sdp = "answer-b") {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.ANSWER, { sdp }));
}

async function aRejects(ctx) {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.REJECT));
}

async function bRejects(ctx) {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.REJECT));
}

async function aEnds(ctx) {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.END));
}

async function bEnds(ctx) {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.END));
}

async function aCompletesEnd(ctx, sdp = "end-answer-a") {
    await ctx.poly.onIngress("a", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp }));
}

async function bCompletesEnd(ctx, sdp = "end-answer-b") {
    await ctx.poly.onIngress("b", makeLegEvent(LEG_EVENTS.END_RENEGOTIATION, { type: "answer", sdp }));
}

function expectLegStates(ctx, expectedA, expectedB) {
    assert.equal(ctx.a.leg.state, expectedA);
    assert.equal(ctx.b.leg.state, expectedB);
}

function expectInCall(ctx) {
    expectLegStates(ctx, S.IN_CALL, S.IN_CALL);
}

function expectRinging(ctx) {
    expectLegStates(ctx, S.CALLING, S.RINGING);
}

function expectEnded(ctx) {
    expectLegStates(ctx, S.CONNECTED, S.CONNECTED);
}

function expectReusable(ctx) {
    assert.equal(canBeRung(ctx.a.leg.state), true, `leg a is not reusable: ${ctx.a.leg.state}`);
    assert.equal(canBeRung(ctx.b.leg.state), true, `leg b is not reusable: ${ctx.b.leg.state}`);
}

function expectMediaConnectedOnce(ctx) {
    assert.equal(ctx.media.connects.length, 1);
}

function expectMediaDisconnected(ctx, count = 1) {
    assert.equal(ctx.media.disconnects.length, count);
}

function expectNoMedia(ctx) {
    assert.equal(ctx.media.connects.length, 0);
    assert.equal(ctx.media.disconnects.length, 0);
}

function expectRingAck(ctx, count = 1) {
    assert.equal(ctx.a.negotiation.named("ackRing").length, count);
}

function expectHeldAnswerFlush(ctx, count = 1) {
    assert.equal(ctx.a.negotiation.named("answer").length, count);
}

module.exports = {
    S,
    buildWebRtcScenario,
    transportOpenA,
    transportOpenB,
    aOffers,
    bOffers,
    aAnswers,
    bAnswers,
    aRejects,
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
    expectRingAck,
    expectHeldAnswerFlush,
};
