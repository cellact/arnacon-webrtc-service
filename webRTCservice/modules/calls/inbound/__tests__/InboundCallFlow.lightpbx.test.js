const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createInboundCallFlow } = require("../InboundCallFlow");

const TARGET = `${"c".repeat(64)}.email.global`;
const WALLET = "0x6666666666666666666666666666666666666666";
const IVR_TARGET = "sip:proj_7yVgTSBvJC4MpWvg257qY6kk@sip.api.openai.com;transport=tls";

function buildFlow(resolveInboundTarget, startMultiring = null) {
    const sessions = [];
    const notifications = [];
    const pendingInboundCalls = new Map();
    const dataChannel = {
        onopen: null,
        onclose: null,
        onMessage: { subscribe() {} },
    };
    const peerConnection = {
        createDataChannel() {
            return dataChannel;
        },
        async createOffer() {
            return { type: "offer", sdp: "v=0\r\n" };
        },
        async setLocalDescription() {},
    };
    const flow = createInboundCallFlow({
        createSession: (sessionId, caller, callee) => {
            const session = { sessionId, caller, callee, iceCandidates: [] };
            sessions.push(session);
            return session;
        },
        resolveInboundTarget,
        findOutboundSessionForInbound: () => null,
        linkSessionPair() {},
        createPeerConnection: () => peerConnection,
        onDataChannelOpen() {},
        onDataChannelMessage() {},
        waitForIceGathering: async () => {},
        formatIceCandidates: () => [],
        getRelayCandidates: () => [],
        embedCandidatesInSdp: (sdp) => sdp,
        sendNotification: async (...args) => {
            notifications.push(args);
            return { ok: true };
        },
        pendingInboundCalls,
        destroySession() {},
        notiTypeCall: 0,
        crypto: { randomUUID: () => "nonce-direct" },
        startMultiring,
        logger: { log() {} },
    });
    return { flow, sessions, notifications, pendingInboundCalls };
}

test("a DIRECT email identity enters the existing single-callee inbound flow", async () => {
    const { flow, sessions, notifications, pendingInboundCalls } = buildFlow(async () => ({
        route: "webrtc",
        wallet: WALLET,
        ensName: TARGET,
        targetValue: "972557012401",
        routingSource: "lightpbx",
    }));

    const result = await flow.handleInboundCallRequest({
        from: "+972501234567",
        to: "972557012401",
        callId: "sip-call-id",
        serviceId: "secnum",
    });

    assert.equal(result.ok, true);
    assert.equal(result.wallet, WALLET);
    assert.equal(result.ensName, TARGET);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].callee, TARGET);
    assert.equal(sessions[0].calleeWallet, WALLET.toLowerCase());
    assert.equal(sessions[0].inboundCall.callId, "sip-call-id");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], TARGET);
    assert.equal(notifications[0][1], TARGET);

    clearTimeout(pendingInboundCalls.get(WALLET.toLowerCase()).timer);
});

test("MULTI_RING delegates fan-out without creating the single-callee inbound session", async () => {
    const decision = {
        route: "webrtc-multiring",
        targets: [
            { wallet: WALLET, ensName: TARGET },
        ],
        groupId: "group-1",
    };
    const starts = [];
    const { flow, sessions, notifications } = buildFlow(
        async () => decision,
        async (data, resolved) => {
            starts.push({ data, resolved });
            return { ok: true, route: "webrtc-multiring", sessionId: "mr-host" };
        },
    );
    const data = {
        from: "+972501234567",
        to: "972557012402",
        callId: "sip-multiring",
        serviceId: "secnum",
    };

    const result = await flow.handleInboundCallRequest(data);
    assert.equal(result.sessionId, "mr-host");
    assert.deepEqual(starts, [{ data, resolved: decision }]);
    assert.equal(sessions.length, 0);
    assert.equal(notifications.length, 0);
});

test("IVR returns the external SIP route without creating or notifying a WebRTC session", async () => {
    const { flow, sessions, notifications } = buildFlow(async () => ({
        route: "external-sip",
        sipUri: IVR_TARGET,
        targetValue: "972557012402",
        routingSource: "lightpbx",
        routingRevision: 1,
    }));

    const result = await flow.handleInboundCallRequest({
        from: "+972501234567",
        to: "972557012402",
        callId: "sip-ivr",
        serviceId: "secnum",
    });

    assert.deepEqual(result, {
        ok: true,
        route: "external-sip",
        sipUri: IVR_TARGET,
        targetValue: "972557012402",
        routingSource: "lightpbx",
        routingRevision: 1,
    });
    assert.equal(sessions.length, 0);
    assert.equal(notifications.length, 0);
});

test("not-enabled and unavailable inbound decisions retain distinct HTTP outcomes", async () => {
    for (const decision of [
        { route: "not-enabled", reason: "MULTI_RING disabled" },
        { route: "unavailable", reason: "chain unavailable" },
    ]) {
        const { flow } = buildFlow(async () => decision);
        await assert.rejects(
            flow.handleInboundCallRequest({
                from: "972501234567",
                to: "972557012401",
                callId: `call-${decision.route}`,
            }),
            {
                message: decision.reason,
                statusCode: decision.route === "not-enabled" ? 501 : 503,
                route: decision.route,
            },
        );
    }
});
