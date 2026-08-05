const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createOfferFlow } = require("../WebRtcOfferUseCase");

const silentLogger = { log() {}, warn() {}, error() {} };

function stableKey(a, b) {
    return [String(a || "").toLowerCase(), String(b || "").toLowerCase()].sort().join("|");
}

function createHttpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function makeDeps(overrides = {}) {
    const sessions = overrides.sessions || new Map();
    const sessionsByUser = overrides.sessionsByUser || new Map();
    const polyStore = new Map();
    const destroySpy = [];
    const runtimeDestroys = [];
    const callRuntime = {
        destroyRuntimeSession: async (id, opts) => { runtimeDestroys.push({ id, opts }); sessions.delete(id); },
        getSessionKind: () => "webrtc",
    };
    const polyRegistryLookup = {
        get: (key) => polyStore.get(key) || null,
        destroy: async (key, reason) => {
            destroySpy.push({ key, reason });
            polyStore.delete(key);
        },
        keyForPair: (a, b) => stableKey(a, b),
    };
    return {
        sessions,
        sessionsByUser,
        stableKey,
        createSession: () => ({ callerEns: "", toIdentity: "" }),
        destroySession: () => {},
        handleHandshake: async (sessionId, from, to) => ({ ok: true, sessionId, from, to, handshake: true }),
        handleInboundAnswer: async () => ({ ok: true }),
        handleHttpCancel: async (sessionId, offer) => ({ ok: true, sessionId, cancel: true }),
        onExistingPairOffer: async () => ({ handled: true, responseBody: { ok: true, reusedPairContext: true } }),
        parseAddress: (addr) => ({ type: /^\d+$/.test(addr) ? "email" : "ens", full: addr }),
        addIceCandidates: async () => 0,
        callRuntime,
        createHttpError,
        polyRegistryLookup,
        logger: silentLogger,
        _spies: { destroy: destroySpy, polyStore, runtimeDestroys },
        ...overrides,
    };
}

function fakePoly({ rotateSpy = [] } = {}) {
    return {
        activeCall: null,
        markActiveCall() {},
        isSameCall() { return false; },
        rotate: async (reason) => { rotateSpy.push(reason); },
    };
}

test("HTTP offer with no existing PolySession -> fresh handshake, no rotation", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0" });
    assert.equal(res.handshake, true);
    assert.equal(deps._spies.destroy.length, 0);
    assert.equal(deps._spies.runtimeDestroys.length, 0);
});

test("HTTP offer without callId still accepted (no 400)", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({
        type: "offer",
        from: "alice",
        to: "bob",
        sdp: "v=0",
        callNonce: "ABC-123",
    });
    assert.equal(res.handshake, true);
});

test("HTTP offer rotates existing PolySession + destroys runtime, then fresh handshake", async () => {
    const deps = makeDeps();
    const rotateSpy = [];
    deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({ rotateSpy }));
    const sessionId = stableKey("alice", "bob");
    deps.sessions.set(sessionId, { callerEns: "alice", toIdentity: "bob" });
    deps.sessionsByUser.set(sessionId, sessionId);

    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0" });

    assert.deepEqual(rotateSpy, ["http-offer-rotation"]);
    assert.equal(deps._spies.destroy.length, 1);
    assert.equal(deps._spies.destroy[0].reason, "http-offer-rotation");
    assert.equal(deps._spies.runtimeDestroys.length, 1);
    assert.equal(deps._spies.runtimeDestroys[0].opts.reason, "http-offer-rotation");
    assert.equal(res.handshake, true);
});

test("HTTP offer rotation fires regardless of callId (same, different, or missing)", async () => {
    for (const callId of [undefined, 1, 999]) {
        const deps = makeDeps();
        const rotateSpy = [];
        deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({ rotateSpy }));
        deps.sessions.set(stableKey("alice", "bob"), { callerEns: "alice", toIdentity: "bob" });
        deps.sessionsByUser.set(stableKey("alice", "bob"), stableKey("alice", "bob"));
        const flow = createOfferFlow(deps);
        await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0", callId });
        assert.deepEqual(rotateSpy, ["http-offer-rotation"], `rotation for callId=${callId}`);
    }
});

test("HTTP cancel forwards to handleHttpCancel (no callId gating)", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "cancel", from: "alice", to: "bob" });
    assert.equal(res.cancel, true);
});
