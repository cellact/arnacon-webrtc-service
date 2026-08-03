const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { ServiceContextFactory } = require("../ServiceContextFactory");

function buildFactory(loggerSink) {
    return new ServiceContextFactory({
        serviceRegistry: {
            allDomains: () => [],
            firstDomain: () => null,
        },
        zeroAddress: "0x0000000000000000000000000000000000000000",
        parseAddress: () => ({}),
        normalizePhone: (value) => value,
        blockchainApi: {},
        callRouterApi: {},
        sendNotification: async () => ({}),
        findOutboundSessionForInbound: () => null,
        openSipSession: async () => ({}),
        openInboundSipSession: async () => ({}),
        notifyAndBridge: async () => ({}),
        sendAck: () => {},
        sendAnswer: () => {},
        sendAckAndAnswer: () => {},
        sendDataChannelMessage: () => {},
        handleCallEnd: () => {},
        emailToEnsName: () => "",
        logger: loggerSink,
    });
}

function digest(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

test("logRouteDecision hashes from/to-like fields when log privacy enabled", () => {
    const captured = [];
    const factory = buildFactory({
        log: (...args) => captured.push(args),
    });
    const runtime = {
        id: "secnum",
        providerId: "secnum",
        primaryDomain: "secnum.global",
        domainAliases: [],
        serviceConstants: {
            logPrivacy: {
                enabled: true,
            },
        },
    };
    const helpers = factory.helpers(runtime);
    helpers.logRouteDecision({
        from: "972557140001.secnum.global",
        to: "972557220060",
        route: "webrtc",
        other: "keep-this",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0][0], "[ServiceRoute]");
    assert.deepEqual(captured[0][1], {
        from: digest("972557140001.secnum.global"),
        to: digest("972557220060"),
        route: "webrtc",
        other: "keep-this",
    });
});

test("logRouteDecision keeps original fields when log privacy disabled", () => {
    const captured = [];
    const factory = buildFactory({
        log: (...args) => captured.push(args),
    });
    const runtime = {
        id: "secnum",
        providerId: "secnum",
        primaryDomain: "secnum.global",
        domainAliases: [],
        serviceConstants: {
            logPrivacy: {
                enabled: false,
            },
        },
    };
    const helpers = factory.helpers(runtime);
    helpers.logRouteDecision({
        from: "972557140001.secnum.global",
        to: "972557220060",
        route: "webrtc",
    });

    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0][1], {
        from: "972557140001.secnum.global",
        to: "972557220060",
        route: "webrtc",
    });
});
