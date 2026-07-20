const { test } = require("node:test");
const assert = require("node:assert/strict");

const secnum = require("../secnum");

const LABEL = "972557012401";
const TARGET = `${"b".repeat(64)}.email.global`;
const WALLET = "0x5555555555555555555555555555555555555555";

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
            readLightPbxProvision: async (label) => {
                calls.lightPbx.push(label);
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
        targets: type === "IVR" ? [] : [TARGET],
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
            to: `${LABEL}.cellact.global`,
            toDomain: "cellact.global",
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
    assert.deepEqual(calls.lightPbx, [LABEL]);
    assert.deepEqual(calls.addresses, [TARGET]);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-direct");
});

test("a true LightPBX miss continues through the legacy Secnum lookup", async () => {
    const legacyEns = `${LABEL}.secnumtest.global`;
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: null,
        addresses: { [legacyEns]: WALLET },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            toDomain: "secnumtest.global",
            callId: "call-miss",
        },
        helpers,
    });

    assert.equal(result.route, "webrtc");
    assert.equal(result.ensName, legacyEns);
    assert.deepEqual(calls.addresses, [legacyEns]);
    assert.ok(calls.decisions.some((entry) => entry.route === "lightpbx-miss-legacy-fallback"));
});

test("RPC and validation failures propagate without legacy fallback", async () => {
    const error = Object.assign(new Error("resolver failed"), {
        code: "LIGHTPBX_RECORD_LOOKUP_FAILED",
        statusCode: 503,
    });
    const { helpers, calls } = buildHelpers({ lightPbxError: error });

    await assert.rejects(
        secnum.resolveInboundTarget({
            payload: { to: LABEL, callId: "call-error" },
            helpers,
        }),
        (received) => received === error,
    );
    assert.deepEqual(calls.addresses, []);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-error");
});

test("MULTI_RING and IVR return explicit not-enabled decisions without fallback", async () => {
    for (const routeType of ["MULTI_RING", "IVR"]) {
        const { helpers, calls } = buildHelpers({
            lightPbxRoute: chainRoute(routeType),
        });
        const result = await secnum.resolveInboundTarget({
            payload: { to: LABEL, callId: `call-${routeType}` },
            helpers,
        });

        assert.equal(result.route, "not-enabled");
        assert.equal(result.statusCode, 501);
        assert.equal(result.routeType, routeType);
        assert.deepEqual(calls.addresses, []);
        assert.equal(calls.decisions.at(-1).route, "lightpbx-not-enabled");
    }
});

test("an unresolved DIRECT target is rejected without falling through to legacy routing", async () => {
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: chainRoute("DIRECT"),
    });
    const result = await secnum.resolveInboundTarget({
        payload: { to: LABEL, callId: "call-unavailable" },
        helpers,
    });

    assert.equal(result.route, "reject");
    assert.equal(result.statusCode, 404);
    assert.deepEqual(calls.addresses, [TARGET]);
    assert.deepEqual(calls.owners, [TARGET]);
    assert.equal(calls.decisions.at(-1).route, "lightpbx-direct-target-unavailable");
});
