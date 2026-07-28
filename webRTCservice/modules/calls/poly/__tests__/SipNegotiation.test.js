const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SipNegotiation } = require("../negotiation/SipNegotiation");
const { SipLeg } = require("../legs/SipLeg");
const { LEG_STATES } = require("../states");
const { LEG_EVENTS } = require("../ports");
const { silentLogger } = require("./fakes");

function fakeSipPort() {
    const calls = [];
    return {
        calls,
        openOutbound: async (sessionId, opts) => { calls.push({ name: "openOutbound", sessionId, opts }); },
        openInbound: async (sessionId, opts) => { calls.push({ name: "openInbound", sessionId, opts }); },
        close: async (sessionId, opts) => { calls.push({ name: "close", sessionId, opts }); },
        sendDtmf: async (sessionId, digit) => { calls.push({ name: "dtmf", sessionId, digit }); },
        setHold: async (sessionId, held) => { calls.push({ name: "hold", sessionId, held }); },
    };
}

function makeLeg({ phoneNumber = null } = {}) {
    const sip = fakeSipPort();
    const session = { sessionId: "972500|bob", callerEns: "972500", toIdentity: "bob.secnum.global" };
    const negotiation = new SipNegotiation({ id: "972500", endpoint: "972500", session, phoneNumber, sip, logger: silentLogger });
    const leg = new SipLeg({ id: "972500", endpoint: "972500", negotiation, logger: silentLogger });
    return { leg, sip, negotiation, session };
}

// The SIP leg has no stored direction: ring => originate (openOutbound), answer =>
// accept (openInbound). P picks the intent from topology, so the same leg object
// serves either direction across calls (e.g. SIP->W then W->SIP) with no role flip.

test("ring opens the outbound INVITE and auto-advances to in-call (blocking handshake)", async () => {
    const { leg, sip } = makeLeg();
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({ from: "alice.secnum.global" });
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 1);
    assert.equal(leg.state, LEG_STATES.IN_CALL, "SIP leg should be in-call once openOutbound resolves");
});

test("ring is idempotent when a sip connection already exists", async () => {
    const { leg, sip, session } = makeLeg();
    session.sipConnection = { fake: true };
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({});
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 0);
});

test("answer registers + accepts the inbound (resumed SBC) INVITE", async () => {
    const { leg, sip } = makeLeg({ phoneNumber: "972500" });
    // SIP-as-caller is seeded CALLING (the PSTN dialed in); P answers once our side picks up.
    leg.setState(LEG_STATES.CALLING, { from: "self" });
    await leg.answer({});
    const inbound = sip.calls.find((c) => c.name === "openInbound");
    assert.ok(inbound, "answer should open the inbound SIP session");
    assert.equal(inbound.opts.phoneNumber, "972500");
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 0, "answer must not place an outbound INVITE");
});

test("answer in REFER transfer mode originates outbound to referee (no openInbound wait)", async () => {
    const { leg, sip, session } = makeLeg({ phoneNumber: "972500" });
    session.referTransfer = {
        enabled: true,
        refereeEndpoint: "972557220060",
        referTarget: "972797001126",
        referCallId: "refer-1",
    };
    leg.setState(LEG_STATES.CALLING, { from: "self" });
    await leg.answer({});
    const outbound = sip.calls.find((c) => c.name === "openOutbound");
    assert.ok(outbound, "REFER mode answer should place outbound INVITE to referee");
    assert.equal(outbound.opts.target, "972557220060");
    assert.equal(outbound.opts.from, "bob.secnum.global");
    assert.equal(sip.calls.filter((c) => c.name === "openInbound").length, 0, "REFER mode answer must not call openInbound");
});

test("answer in REFER transfer mode falls back target to leg endpoint when referee is missing", async () => {
    const { leg, sip, session } = makeLeg({ phoneNumber: "972500" });
    session.referTransfer = {
        enabled: true,
        referTarget: "972797001126",
        referCallId: "refer-2",
    };
    leg.setState(LEG_STATES.CALLING, { from: "self" });
    await leg.answer({});
    const outbound = sip.calls.find((c) => c.name === "openOutbound");
    assert.ok(outbound, "REFER mode answer should place outbound INVITE");
    assert.equal(outbound.opts.target, "972500");
    assert.equal(sip.calls.filter((c) => c.name === "openInbound").length, 0);
});

test("same leg serves both directions across calls (no frozen role)", async () => {
    // Call 1: this side is the callee -> ring -> outbound INVITE.
    const { leg, sip, session } = makeLeg({ phoneNumber: "972500" });
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({});
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 1);
    // Hang up: SIP has no idle state -> DISCONNECTED, sip connection released.
    session.sipConnection = null;
    leg.setState(LEG_STATES.DISCONNECTED, { from: "self" });
    // Call 2 (flipped): this side is the caller -> answer -> inbound accept.
    leg.setState(LEG_STATES.CALLING, { from: "self" });
    await leg.answer({});
    assert.equal(sip.calls.filter((c) => c.name === "openInbound").length, 1, "flip direction works without rebuilding the leg");
});

test("DTMF / HOLD ingress route to the sip aux handler without changing call state", async () => {
    const { leg, sip } = makeLeg();
    leg.setState(LEG_STATES.IN_CALL, { from: "self" });
    await leg.handleIngress({ type: LEG_EVENTS.DTMF, payload: { digit: "5" } });
    await leg.handleIngress({ type: LEG_EVENTS.HOLD, payload: { enabled: true } });
    assert.equal(leg.state, LEG_STATES.IN_CALL);
    assert.ok(sip.calls.find((c) => c.name === "dtmf" && c.digit === "5"));
    assert.ok(sip.calls.find((c) => c.name === "hold" && c.held === true));
});
