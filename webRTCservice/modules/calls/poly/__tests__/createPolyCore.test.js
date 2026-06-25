const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPolyCore } = require("../createPolyCore");
const { LEG_EVENTS, LEG_STATES: S } = require("../index");
const { FakePeerConnection, fakePrimitives, silentLogger } = require("./fakes");

// A fake MediaGraphFactory + per-leg transport store, to prove createPolyCore
// assembles a working core end-to-end (resolve -> ingress -> reconcile -> media).
function build() {
    const graphs = [];
    const mediaGraphFactory = {
        async startGraph({ id }) {
            const g = { id, stopped: false, stop: async () => { g.stopped = true; } };
            graphs.push(g);
            return g;
        },
    };
    const sessions = new Map();
    const ensureSession = (id) => {
        if (!sessions.has(id)) {
            sessions.set(id, { sessionId: id, callerEns: id, toIdentity: "peer", peerConnection: null, dataChannel: { readyState: "open", send() {} } });
        }
        return sessions.get(id);
    };
    const sent = [];
    const core = createPolyCore({
        mediaGraphFactory,
        webrtcPrimitives: fakePrimitives(),
        makeSignalingTransport: ({ session }) => ({ send: (m) => sent.push({ session: session.sessionId, m }), isOpen: () => true }),
        sipPort: { openOutbound: async () => {}, close: async () => {} },
        logger: silentLogger,
    });
    // legs created by the registry call the negotiation factory which expects a
    // session; supply per-leg sessions through a custom resolve wrapper.
    return { core, graphs, sent, ensureSession };
}

test("createPolyCore wires registry + ingress that resolve and dispatch", async () => {
    const { core } = build();
    const parties = {
        a: { endpoint: "alice", kind: "webrtc", session: { sessionId: "alice", callerEns: "alice", toIdentity: "bob", peerConnection: null } },
        b: { endpoint: "bob", kind: "webrtc", session: { sessionId: "bob", callerEns: "bob", toIdentity: "alice", peerConnection: null } },
        target: "alice",
    };
    const { poly, ref } = core.registry.resolve(parties);
    assert.ok(poly);
    assert.equal(ref, "a");
    // transports up
    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    assert.equal(poly.legs.a.state, S.CONNECTED);
    assert.equal(poly.legs.b.state, S.CONNECTED);
});

test("createPolyCore validates required deps", () => {
    assert.throws(() => createPolyCore({}), /mediaGraphFactory/);
});

test("createPolyCore callee connect chain: offer -> deferred connect -> transport-open rings callee", async () => {
    const graphs = [];
    const sent = [];
    const outboundInvites = [];
    const mediaGraphFactory = {
        async startGraph({ id }) {
            const g = { id, stopped: false, stop: async () => { g.stopped = true; } };
            graphs.push(g);
            return g;
        },
    };
    const outboundInvite = async ({ callerSessionId, destination }) => {
        outboundInvites.push({ callerSessionId, destination });
        return {
            sessionId: "bob-leg",
            signalingSessionId: "alice|bob",
            callerEns: "alice",
            toIdentity: "bob",
            peerConnection: new FakePeerConnection(),
            dataChannel: { readyState: "open", send() {} },
            iceCandidates: [],
        };
    };
    const core = createPolyCore({
        mediaGraphFactory,
        webrtcPrimitives: fakePrimitives(),
        makeSignalingTransport: ({ session, id }) => ({
            send: (m) => sent.push({ session: session?.sessionId || id, m }),
            isOpen: () => true,
        }),
        sipPort: { openOutbound: async () => {}, close: async () => {} },
        outboundInvite,
        logger: silentLogger,
    });
    const parties = {
        a: {
            endpoint: "alice",
            kind: "webrtc",
            session: {
                sessionId: "alice",
                callerEns: "alice",
                toIdentity: "bob",
                peerConnection: new FakePeerConnection(),
                dataChannel: { readyState: "open", send() {} },
                iceCandidates: [],
            },
        },
        b: {
            endpoint: "bob",
            kind: "webrtc",
            role: "callee",
            destination: { wallet: "0x1234", ensName: "bob.global" },
            callerSessionId: "alice",
            session: { sessionId: "bob-leg" },
        },
        target: "alice",
    };
    const { poly } = core.registry.resolve(parties);

    await poly.onIngress("a", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    await poly.onIngress("a", { type: LEG_EVENTS.OFFER, payload: { sdp: "offer" } });
    assert.equal(poly.legs.a.state, S.CALLING);
    assert.equal(poly.legs.b.state, S.CONNECTING);
    assert.equal(outboundInvites.length, 1, "callee connect triggers outbound invite once");

    await poly.onIngress("b", { type: LEG_EVENTS.TRANSPORT_OPEN, payload: {} });
    assert.equal(poly.legs.b.state, S.RINGING, "transport-open advances connecting callee to ringing");
    assert.ok(
        sent.some((x) => x.session === "bob-leg" && x.m?.msgType === "signaling" && x.m?.payload?.type === "offer"),
        "callee ring offer is emitted on the callee signaling transport",
    );
});

test("poly module index loads every public export", () => {
    const poly = require("../index");
    for (const name of [
        "PolySession", "PolySessionRegistry", "LegFactory", "MediaController",
        "PolyIngress", "WebRtcNegotiation", "SipNegotiation", "createPolyCore",
        "SessionLeg", "WebRtcLeg", "SipLeg", "reconcile", "LEG_STATES", "LEG_INTENTS",
    ]) {
        assert.ok(poly[name], `expected export ${name}`);
    }
});
