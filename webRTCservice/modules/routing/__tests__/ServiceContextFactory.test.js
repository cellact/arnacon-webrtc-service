const test = require("node:test");
const assert = require("node:assert/strict");
const { ServiceContextFactory } = require("../ServiceContextFactory");

function buildFactory(loggerSink = console) {
    return new ServiceContextFactory({
        serviceRegistry: {
            allDomains: () => ["secnum.global"],
            firstDomain: () => "secnum.global",
        },
        zeroAddress: "0x0",
        parseAddress: () => ({}),
        normalizePhone: (v) => String(v || "").replace(/\D/g, ""),
        blockchainApi: {},
        callRouterApi: {},
        sendNotification: async () => ({}),
        findOutboundSessionForInbound: () => null,
        openSipSession: async () => {},
        openInboundSipSession: async () => {},
        notifyAndBridge: async () => {},
        sendAck: () => {},
        sendAnswer: () => {},
        sendAckAndAnswer: () => {},
        sendDataChannelMessage: () => {},
        handleCallEnd: () => {},
        emailToEnsName: () => "",
        logger: loggerSink,
    });
}

test("logRouteDecision emits compact ServiceRoute breadcrumb", () => {
    const captured = [];
    const factory = buildFactory({
        log: (...args) => captured.push(args.join(" ")),
    });
    const runtime = {
        id: "secnum",
        providerId: "secnum",
        primaryDomain: "secnum.global",
        domainAliases: [],
        serviceConstants: {},
    };
    const helpers = factory.helpers(runtime);
    helpers.logRouteDecision({
        targetValue: "972557220060",
        route: "number-to-sbc-fallback",
        notifyIdentity: "972557220060",
        walletSource: "identity-mapping",
    });

    assert.equal(captured.length, 1);
    assert.match(captured[0], /\[ServiceRoute\]/);
    assert.match(captured[0], /route=number-to-sbc-fallback/);
    assert.match(captured[0], /target=972557220060/);
    assert.match(captured[0], /notify=972557220060/);
});
