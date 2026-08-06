const { test } = require("node:test");
const assert = require("node:assert/strict");

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

test("logRouteDecision is muted (no ServiceRoute log spam)", () => {
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

    assert.equal(captured.length, 0);
});

test("logRouteDecision remains muted when log privacy disabled", () => {
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

    assert.equal(captured.length, 0);
});
