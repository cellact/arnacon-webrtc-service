const { test } = require("node:test");
const assert = require("node:assert/strict");

const secnum = require("../secnum");

const LABEL = "972557012401";
const TARGET = `${"b".repeat(64)}.email.global`;
const SECOND_TARGET = `${"c".repeat(64)}.email.global`;
const WALLET = "0x5555555555555555555555555555555555555555";
const IVR_TARGET = "sip:proj_7yVgTSBvJC4MpWvg257qY6kk@sip.api.openai.com;transport=tls";

function buildHelpers({
    lightPbxRoute = null,
    lightPbxError = null,
    addresses = {},
    owners = {},
} = {}) {
    const calls = {
        lightPbx: [],
        addresses: [],
        owners: [],
        decisions: [],
    };
    return {
        calls,
        helpers: {
            zeroAddress: "0x0000000000000000000000000000000000000000",
            getServiceConstants: () => ({ domains: ["secnumtest.global", "secnum.global"] }),
            selectInboundLookupValue: ({ payload }) => payload.to,
            normalizePhone: (value) => String(value || "").replace(/^\+/, ""),
            readLightPbxProvision: async (label, identity) => {
                calls.lightPbx.push({ label, identity });
                if (lightPbxError) throw lightPbxError;
                return lightPbxRoute;
            },
            lookupEnsAddress: async (ensName) => {
                calls.addresses.push(ensName);
                return addresses[ensName] || null;
            },
            lookupEnsOwner: async (ensName) => {
                calls.owners.push(ensName);
                return owners[ensName] || null;
            },
            logRouteDecision: (decision) => calls.decisions.push(decision),
        },
    };
}

function chainRoute(type = "DIRECT") {
    return {
        source: "chain",
        provisionIdentifier: `lightpbx.${LABEL}`,
        type,
        targets: type === "MULTI_RING"
            ? [TARGET, SECOND_TARGET]
            : type === "IVR"
                ? [IVR_TARGET]
                : [TARGET],
        groupId: type === "MULTI_RING" ? "group-1" : null,
        rejectedTargetCount: 0,
        revision: 4,
    };
}

test("DIRECT resolves the published email identity before legacy Secnum ENS candidates", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("DIRECT"),
        addresses: { [TARGET]: WALLET },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            from: "972501234567",
            to: `${LABEL}.secnumtest.global`,
            toDomain: "secnumtest.global",
            callId: "call-direct",
        },
        helpers,
    });

    assert.deepEqual(result, {
        route: "webrtc",
        wallet: WALLET,
        ensName: TARGET,
        targetValue: LABEL,
        routingSource: "lightpbx",
        routingRevision: 4,
    });
    assert.deepEqual(calls.lightPbx, [{
        label: LABEL,
        identity: `${LABEL}.secnumtest.global`,
    }]);
    assert.deepEqual(calls.addresses, [TARGET]);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-direct");
});

test("a bare SBC DID probes LightPBX before the registered number identity", async () => {
    const numberIdentity = `${LABEL}.secnumtest.global`;
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("DIRECT"),
        addresses: {
            [TARGET]: WALLET,
            [numberIdentity]: "0x9999999999999999999999999999999999999999",
        },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            from: "972501234567",
            to: LABEL,
            callId: "call-bare-direct",
        },
        helpers,
    });

    assert.equal(result.route, "webrtc");
    assert.equal(result.ensName, TARGET);
    assert.equal(result.wallet, WALLET);
    assert.deepEqual(calls.lightPbx, [{
        label: LABEL,
        identity: numberIdentity,
    }]);
    assert.deepEqual(calls.addresses, [TARGET]);
});

test("a bare legacy DID falls back only when no LightPBX provision exists", async () => {
    const numberIdentity = `${LABEL}.secnumtest.global`;
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: null,
        addresses: { [numberIdentity]: WALLET },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            callId: "call-bare-legacy",
        },
        helpers,
    });

    assert.equal(result.route, "webrtc");
    assert.equal(result.ensName, numberIdentity);
    assert.deepEqual(calls.lightPbx, [{
        label: LABEL,
        identity: numberIdentity,
    }]);
});

test("a missing secnumtest LightPBX provision rejects without legacy fallback", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: null,
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnumtest.global",
            callId: "call-miss",
        },
        helpers,
    });

    assert.equal(result.route, "reject");
    assert.equal(result.statusCode, 404);
    assert.deepEqual(calls.addresses, []);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-unconfigured");
});

test("RPC and validation failures propagate without legacy fallback", async () => {
    const error = Object.assign(new Error("resolver failed"), {
        code: "LIGHTPBX_RECORD_LOOKUP_FAILED",
        statusCode: 503,
    });
    const { helpers, calls } = buildHelpers({ lightPbxError: error });

    await assert.rejects(
        secnum.resolveInboundTarget({
            payload: {
                to: LABEL,
                toDomain: "secnumtest.global",
                callId: "call-error",
            },
            helpers,
        }),
        (received) => received === error,
    );
    assert.deepEqual(calls.addresses, []);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-error");
});

test("MULTI_RING resolves available targets, skips misses, and returns fan-out policy", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("MULTI_RING"),
        addresses: {
            [TARGET]: WALLET,
        },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnumtest.global",
            callId: "call-multiring",
        },
        helpers,
    });

    assert.equal(result.route, "webrtc-multiring");
    assert.equal(result.mode, "first-verified-answer-wins");
    assert.equal(result.groupId, "group-1");
    assert.deepEqual(result.targets, [
        { ensName: TARGET, wallet: WALLET },
    ]);
    assert.ok(calls.decisions.some((entry) =>
        entry.route === "lightpbx-multiring-target-skipped"
        && entry.ensName === SECOND_TARGET
    ));
    assert.equal(calls.decisions.at(-1).route, "lightpbx-multiring");
});

test("IVR returns the provisioned external SIP trunk without resolving an ENS wallet", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("IVR"),
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnumtest.global",
            callId: "call-ivr",
        },
        helpers,
    });

    assert.deepEqual(result, {
        route: "external-sip",
        sipUri: IVR_TARGET,
        targetValue: LABEL,
        routingSource: "lightpbx",
        routingRevision: 4,
    });
    assert.deepEqual(calls.addresses, []);
    assert.deepEqual(calls.owners, []);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-ivr");
});

test("a non-LightPBX Secnum domain keeps legacy routing and never reads a provision", async () => {
    const legacyEns = `${LABEL}.secnum.global`;
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("DIRECT"),
        addresses: { [legacyEns]: WALLET },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnum.global",
            callId: "call-legacy",
        },
        helpers,
    });

    assert.equal(result.route, "webrtc");
    assert.equal(result.ensName, legacyEns);
    assert.deepEqual(calls.lightPbx, []);
});

test("an unresolved DIRECT target is rejected without falling through to legacy routing", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("DIRECT"),
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnumtest.global",
            callId: "call-unavailable",
        },
        helpers,
    });

    assert.equal(result.route, "reject");
    assert.equal(result.statusCode, 404);
    assert.deepEqual(calls.addresses, [TARGET]);
    assert.deepEqual(calls.owners, [TARGET]);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-direct-target-unavailable");
});
