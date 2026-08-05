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
    const callRuntime = {
        destroyRuntimeSession: async () => {},
        getSessionKind: () => "webrtc",
    };
    const polyStore = new Map();
    const rotateSpy = [];
    const destroySpy = [];
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
        handleHttpCancel: async (sessionId, offer) => ({ ok: true, sessionId, cancel: true, callId: offer.callId }),
        onExistingPairOffer: async () => ({ handled: false }),
        parseAddress: (addr) => ({ type: /^\d+$/.test(addr) ? "email" : "ens", full: addr }),
        addIceCandidates: async () => 0,
        callRuntime,
        createHttpError,
        polyRegistryLookup,
        logger: silentLogger,
        _spies: { rotate: rotateSpy, destroy: destroySpy, polyStore },
        ...overrides,
    };
}

function fakePoly({ activeFromNorm, activeCallId, rotateSpy }) {
    return {
        activeCall: activeFromNorm && activeCallId ? { from: activeFromNorm, callId: activeCallId } : null,
        isSameCall(from, callId) {
            if (!this.activeCall) return false;
            const normFrom = String(from || "").toLowerCase();
            const normCallId = Number.parseInt(String(callId), 10);
            return this.activeCall.from === normFrom && this.activeCall.callId === normCallId;
        },
        rotate: async (reason) => { rotateSpy.push(reason); },
    };
}

test("offer without callId is rejected with 400", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    await assert.rejects(
        () => flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0" }),
        (err) => err.status === 400 && /callId/i.test(err.message),
    );
});

test("offer with valid callId on empty registry falls through to fresh handshake", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0", callId: 1 });
    assert.equal(res.handshake, true);
    assert.equal(deps._spies.destroy.length, 0);
});

test("callId match: no rotation, existing pair routing attempted", async () => {
    const deps = makeDeps();
    const rotateSpy = [];
    deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({
        activeFromNorm: "alice", activeCallId: 42, rotateSpy,
    }));
    // Also simulate an existing session for the pair so onExistingPairOffer is invoked.
    const sessionId = stableKey("alice", "bob");
    deps.sessions.set(sessionId, { callerEns: "alice", toIdentity: "bob" });
    deps.sessionsByUser.set(sessionId, sessionId);

    let existingOfferCalls = 0;
    deps.onExistingPairOffer = async () => { existingOfferCalls += 1; return { handled: true, responseBody: { ok: true, reusedPairContext: true } }; };

    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0", callId: 42 });
    assert.equal(rotateSpy.length, 0, "no rotate on callId match");
    assert.equal(deps._spies.destroy.length, 0, "no destroy on callId match");
    assert.equal(existingOfferCalls, 1);
    assert.equal(res.reusedPairContext, true);
});

test("callId mismatch: rotate + destroy poly + destroy runtime, then fresh handshake", async () => {
    const deps = makeDeps();
    const rotateSpy = [];
    deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({
        activeFromNorm: "alice", activeCallId: 1, rotateSpy,
    }));
    const sessionId = stableKey("alice", "bob");
    deps.sessions.set(sessionId, { callerEns: "alice", toIdentity: "bob" });
    deps.sessionsByUser.set(sessionId, sessionId);
    const runtimeDestroys = [];
    deps.callRuntime.destroyRuntimeSession = async (id, opts) => { runtimeDestroys.push({ id, opts }); deps.sessions.delete(id); };

    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "offer", from: "alice", to: "bob", sdp: "v=0", callId: 2 });

    assert.deepEqual(rotateSpy, ["callid-rotation"], "poly.rotate called once");
    assert.equal(deps._spies.destroy.length, 1, "polyRegistry.destroy called once");
    assert.equal(deps._spies.destroy[0].reason, "callid-rotation");
    assert.equal(runtimeDestroys.length, 1, "runtime session destroyed");
    assert.equal(runtimeDestroys[0].opts.reason, "callid-rotation");
    assert.equal(res.handshake, true, "fresh handshake after rotation");
});

test("cancel with stale callId is ignored (callid-mismatch)", async () => {
    const deps = makeDeps();
    const rotateSpy = [];
    deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({
        activeFromNorm: "alice", activeCallId: 5, rotateSpy,
    }));
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "cancel", from: "alice", to: "bob", callId: 3 });
    assert.equal(res.ignored, true);
    assert.equal(res.reason, "callid-mismatch");
});

test("cancel with matching callId is forwarded to handleHttpCancel", async () => {
    const deps = makeDeps();
    const rotateSpy = [];
    deps._spies.polyStore.set(stableKey("alice", "bob"), fakePoly({
        activeFromNorm: "alice", activeCallId: 5, rotateSpy,
    }));
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "cancel", from: "alice", to: "bob", callId: 5 });
    assert.equal(res.cancel, true);
    assert.equal(res.callId, 5);
});

test("cancel with no callId falls back to handler (backward compat)", async () => {
    const deps = makeDeps();
    const flow = createOfferFlow(deps);
    const res = await flow.onIncomingOffer({ type: "cancel", from: "alice", to: "bob" });
    assert.equal(res.cancel, true);
});
