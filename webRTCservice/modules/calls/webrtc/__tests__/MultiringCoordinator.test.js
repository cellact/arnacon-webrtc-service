const { test } = require("node:test");
const assert = require("node:assert/strict");

const { MultiringCoordinator } = require("../MultiringCoordinator");

function makeHarness({ timeoutMs = 60000, failWallets = new Set() } = {}) {
    const sessions = new Map();
    const sessionsByUser = new Map();
    const notifications = [];
    const destroyed = [];
    const appliedAnswers = [];
    const createdLegs = [];
    const logger = { log() {}, error() {} };

    const createSession = (sessionId, callerEns, toIdentity) => {
        const session = {
            sessionId,
            callerEns,
            toIdentity,
            outboundWebrtcLegs: new Map(),
        };
        sessions.set(sessionId, session);
        return session;
    };
    const outboundLegFactory = {
        async create(hostSessionId, destination) {
            if (failWallets.has(destination.wallet)) throw new Error("invite failed");
            const host = sessions.get(hostSessionId);
            const walletKey = destination.wallet.toLowerCase();
            const sent = [];
            const dc = {
                readyState: "open",
                sent,
                send(value) { sent.push(JSON.parse(value)); },
                close() { this.closed = true; },
            };
            const pc = {
                close() { this.closed = true; },
            };
            const legSession = {
                sessionId: hostSessionId,
                signalingSessionId: [destination.ensName, host.callerEns].sort().join("|"),
                toIdentity: destination.ensName,
                walletAddress: walletKey,
                dataChannel: dc,
                peerConnection: pc,
            };
            host.outboundWebrtcLegs.set(walletKey, legSession);
            createdLegs.push(legSession);
            return {
                legSession,
                calleeEns: destination.ensName,
                callerEns: host.callerEns,
                callPayload: `invite:${destination.ensName}`,
            };
        },
    };
    const coordinator = new MultiringCoordinator({
        sessions,
        sessionsByUser,
        stableKey: (a, b) => [String(a || "").split(".")[0], String(b || "").split(".")[0]].sort().join("|"),
        createSession,
        outboundLegFactory,
        sendNotification: async (...args) => {
            notifications.push(args);
            return { ok: true };
        },
        applySessionAnswer: async (legSession, offer) => {
            appliedAnswers.push({ legSession, offer });
        },
        destroySession: (sessionId) => {
            destroyed.push(sessionId);
            sessions.delete(sessionId);
        },
        notiTypeCall: 0,
        timeoutMs,
        logger,
    });
    return {
        coordinator,
        sessions,
        sessionsByUser,
        notifications,
        destroyed,
        appliedAnswers,
        createdLegs,
    };
}

const targets = [
    { wallet: "0x1111111111111111111111111111111111111111", ensName: "alice.secnum.global" },
    { wallet: "0x2222222222222222222222222222222222222222", ensName: "bob.secnum.global" },
    { wallet: "0x3333333333333333333333333333333333333333", ensName: "carol.secnum.global" },
];

async function start(harness, selectedTargets = targets) {
    return harness.coordinator.startInbound({
        from: "+972501234567",
        to: "972797001018",
        callId: "sip-call-1",
        serviceId: "secnum",
    }, {
        route: "webrtc-multiring",
        mode: "first-verified-answer-wins",
        targets: selectedTargets,
        groupId: "lightpbx-group-7",
        ruleId: "rule-9",
        routingSource: "lightpbx",
        routingRevision: "12",
    });
}

function metaFor(leg) {
    return {
        channelRole: "callee-webrtc",
        walletAddress: leg.walletAddress,
        calleeIdentity: leg.toIdentity,
        signalingSessionId: leg.signalingSessionId,
    };
}

test("HTTP answers establish candidate transports but only the first DC pickup wins", async () => {
    const harness = makeHarness();
    const result = await start(harness);
    assert.equal(result.candidateCount, 3);
    assert.equal(harness.notifications.length, 3);
    assert.equal(harness.sessionsByUser.size, 3, "candidate pairs must resolve to the host for answer authentication");
    for (const [callerIdentity, calleeIdentity] of harness.notifications) {
        assert.equal(callerIdentity, calleeIdentity);
    }

    for (const leg of harness.createdLegs) {
        const http = await harness.coordinator.handleHttpSignal({
            type: "answer",
            from: leg.toIdentity,
            to: "972501234567",
            // The real offer intake strips ENS suffixes while normalizing IDs.
            sessionId: leg.signalingSessionId,
            sdp: "v=0\r\n",
            candidates: [],
        });
        assert.equal(http.handled, true);
    }
    assert.equal(harness.appliedAnswers.length, 3);
    const group = harness.coordinator.byHostSession.get(result.sessionId);
    assert.equal(group.winner, null, "HTTP transport setup must not choose a winner");

    const winnerLeg = harness.createdLegs[1];
    assert.equal(
        harness.coordinator.handleDataChannelOpen(result.sessionId, metaFor(winnerLeg)).handled,
        true,
    );
    assert.equal(group.winner, null, "data-channel open must not choose a winner");

    const claim = harness.coordinator.handleDataChannelMessage(
        result.sessionId,
        { msgType: "call", action: "answer" },
        metaFor(winnerLeg),
    );
    assert.equal(claim.won, true);
    assert.equal(claim.candidate.legSession, winnerLeg);
    assert.equal(winnerLeg.multiRingPreNegotiated, true);

    const losers = harness.createdLegs.filter((leg) => leg !== winnerLeg);
    for (const loser of losers) {
        assert.equal(loser.peerConnection, null);
        assert.equal(loser.dataChannel, null);
    }
    assert.equal(harness.destroyed.length, 0, "losers must not cascade into the SIP host");

    const lateLoser = harness.coordinator.handleDataChannelMessage(
        result.sessionId,
        { msgType: "call", action: "answer" },
        metaFor(losers[0]),
    );
    assert.equal(lateLoser.handled, true);
    assert.equal(lateLoser.won, false);
    assert.equal(group.winner.legSession, winnerLeg);

    harness.coordinator.completeHandoff(group);
    assert.equal(harness.coordinator.byHostSession.has(result.sessionId), false);
    assert.equal(harness.sessionsByUser.size, 1, "only the winner authentication pair remains after handoff");
});

test("a pre-answer candidate transport close is isolated and another target can win", async () => {
    const harness = makeHarness();
    const result = await start(harness, targets.slice(0, 2));
    const [closedLeg, winnerLeg] = harness.createdLegs;

    const closed = harness.coordinator.handleTransportClosed({ pc: closedLeg.peerConnection });
    assert.equal(closed.handled, true);
    assert.equal(harness.destroyed.length, 0);

    const claim = harness.coordinator.handleDataChannelMessage(
        result.sessionId,
        { msgType: "call", action: "answer" },
        metaFor(winnerLeg),
    );
    assert.equal(claim.won, true);
    assert.equal(claim.candidate.legSession, winnerLeg);
    harness.coordinator.completeHandoff(claim.group);
});

test("no started candidates uses no-answer cleanup and rejects the inbound request", async () => {
    const harness = makeHarness({
        failWallets: new Set(targets.map((target) => target.wallet)),
    });
    await assert.rejects(start(harness), {
        message: "No MULTI_RING candidate could be started",
        statusCode: 503,
        route: "webrtc-multiring",
    });
    assert.equal(harness.destroyed.length, 1);
    assert.equal(harness.sessions.size, 0);
});

test("existing inbound timeout closes all candidates and destroys only the host session", async () => {
    const harness = makeHarness({ timeoutMs: 10 });
    const result = await start(harness, targets.slice(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(harness.destroyed, [result.sessionId]);
    assert.equal(harness.coordinator.byHostSession.has(result.sessionId), false);
    for (const leg of harness.createdLegs) {
        assert.equal(leg.peerConnection, null);
        assert.equal(leg.dataChannel, null);
    }
});
