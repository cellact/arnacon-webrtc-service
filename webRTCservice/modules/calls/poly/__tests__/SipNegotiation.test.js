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

function makeLeg({ role = "outbound", phoneNumber = null } = {}) {
    const sip = fakeSipPort();
    const session = { sessionId: "972500|bob", callerEns: "972500", toIdentity: "bob.secnum.global" };
    const negotiation = new SipNegotiation({ id: "972500", endpoint: "972500", session, role, phoneNumber, sip, logger: silentLogger });
    const leg = new SipLeg({ id: "972500", endpoint: "972500", negotiation, logger: silentLogger });
    return { leg, sip, negotiation, session };
}

test("outbound SIP ring opens the INVITE and auto-advances to in-call (blocking handshake)", async () => {
    const { leg, sip } = makeLeg({ role: "outbound" });
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({ from: "alice.secnum.global" });
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 1);
    assert.equal(leg.state, LEG_STATES.IN_CALL, "SIP leg should be in-call once openOutbound resolves");
});

test("outbound SIP ring is idempotent when a sip connection already exists", async () => {
    const { leg, sip, session } = makeLeg({ role: "outbound" });
    session.sipConnection = { fake: true };
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({});
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 0);
});

test("inbound SIP gateway does not INVITE on ring; answer registers + accepts", async () => {
    const { leg, sip } = makeLeg({ role: "inbound", phoneNumber: "972500" });
    leg.setState(LEG_STATES.CONNECTED, { from: "self" });
    await leg.ring({});
    assert.equal(sip.calls.filter((c) => c.name === "openOutbound").length, 0, "inbound must not place an outbound INVITE");
    await leg.answer({});
    const inbound = sip.calls.find((c) => c.name === "openInbound");
    assert.ok(inbound, "inbound answer should open the inbound SIP session");
    assert.equal(inbound.opts.phoneNumber, "972500");
});

test("DTMF / HOLD ingress route to the sip aux handler without changing call state", async () => {
    const { leg, sip } = makeLeg({ role: "outbound" });
    leg.setState(LEG_STATES.IN_CALL, { from: "self" });
    await leg.handleIngress({ type: LEG_EVENTS.DTMF, payload: { digit: "5" } });
    await leg.handleIngress({ type: LEG_EVENTS.HOLD, payload: { enabled: true } });
    assert.equal(leg.state, LEG_STATES.IN_CALL);
    assert.ok(sip.calls.find((c) => c.name === "dtmf" && c.digit === "5"));
    assert.ok(sip.calls.find((c) => c.name === "hold" && c.held === true));
});
