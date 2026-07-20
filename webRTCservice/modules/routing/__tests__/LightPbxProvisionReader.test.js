const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
    LightPbxProvisionError,
    createLightPbxProvisionReader,
} = require("../LightPbxProvisionReader");

const CONTRACT_ADDRESSES = {
    ENSRegistry: "0x1111111111111111111111111111111111111111",
    PublicResolver: "0x2222222222222222222222222222222222222222",
    ProvisionRegistry: "0x3333333333333333333333333333333333333333",
};
const LABEL = "972557012401";
const TARGET = `${"a".repeat(64)}.email.global`;

function provision(overrides = {}) {
    const base = {
        schema: "arnacon.lightpbx.endpoint.v1",
        kind: "lightpbx_external_extension",
        identity: `${LABEL}.cellact.global`,
        label: LABEL,
        owner: "0x4444444444444444444444444444444444444444",
        routing: {
            type: "DIRECT",
            revision: 7,
            targets: [TARGET],
        },
    };
    return {
        ...base,
        ...overrides,
        routing: {
            ...base.routing,
            ...(overrides.routing || {}),
        },
    };
}

function build({
    record = "provision-key",
    payload = JSON.stringify(provision()),
    getRecord,
    getProvision,
    now,
} = {}) {
    const calls = { setAddresses: 0, record: 0, provision: 0 };
    const sdk = {
        setContractAddresses(addresses) {
            calls.setAddresses += 1;
            calls.addresses = addresses;
        },
        async getRecord(identifier, tenant) {
            calls.record += 1;
            calls.recordArgs = [identifier, tenant];
            return getRecord ? getRecord() : record;
        },
        async getProvision(tenant, identifier) {
            calls.provision += 1;
            calls.provisionArgs = [tenant, identifier];
            return getProvision ? getProvision() : payload;
        },
    };
    const reader = createLightPbxProvisionReader({
        rpcUrl: "https://polygon.example",
        contractAddresses: CONTRACT_ADDRESSES,
        tenantName: "cellact",
        chainId: 137,
        timeoutMs: 50,
        routeTtlMs: 100,
        missTtlMs: 10,
        sdkFactory: (config) => {
            calls.sdkConfig = config;
            return sdk;
        },
        logger: { log() {} },
        now,
    });
    return { reader, calls };
}

test("initializes the read-only SDK with explicit chain, RPC, and addresses", () => {
    const { calls } = build();
    assert.deepEqual(calls.sdkConfig, {
        chainId: 137,
        rpcUrl: "https://polygon.example",
    });
    assert.equal(calls.setAddresses, 1);
    assert.equal(calls.addresses, CONTRACT_ADDRESSES);
});

test("reads, validates, canonicalizes, and caches a DIRECT provision", async () => {
    const { reader, calls } = build();
    const first = await reader.readLightPbxProvision(LABEL);
    const second = await reader.readLightPbxProvision(LABEL);

    assert.deepEqual(first, {
        source: "chain",
        provisionIdentifier: `lightpbx.${LABEL}`,
        provisionKey: "provision-key",
        identity: `${LABEL}.cellact.global`,
        owner: "0x4444444444444444444444444444444444444444",
        type: "DIRECT",
        targets: [TARGET],
        groupId: null,
        revision: 7,
        configHash: null,
    });
    assert.equal(second, first);
    assert.deepEqual(calls.recordArgs, [`lightpbx.${LABEL}`, "cellact"]);
    assert.deepEqual(calls.provisionArgs, ["cellact", `lightpbx.${LABEL}`]);
    assert.equal(calls.record, 1);
    assert.equal(calls.provision, 1);
});

test("accepts object payloads and preserves supported route boundaries", async () => {
    for (const routeType of ["MULTI_RING", "IVR"]) {
        const { reader } = build({
            payload: provision({
                routing: {
                    type: routeType,
                    targets: routeType === "IVR" ? [] : [TARGET],
                },
            }),
        });
        const route = await reader.readLightPbxProvision(LABEL);
        assert.equal(route.type, routeType);
    }
});

test("treats only an empty resolver record as a cached legacy miss", async () => {
    let now = 100;
    const { reader, calls } = build({ record: "", now: () => now });
    assert.equal(await reader.readLightPbxProvision(LABEL), null);
    assert.equal(await reader.readLightPbxProvision(LABEL), null);
    assert.equal(calls.record, 1);

    now = 111;
    assert.equal(await reader.readLightPbxProvision(LABEL), null);
    assert.equal(calls.record, 2);
    assert.equal(calls.provision, 0);
});

test("does not cache resolver infrastructure failures", async () => {
    const { reader, calls } = build({
        getRecord: () => {
            throw new Error("RPC unavailable");
        },
    });
    await assert.rejects(
        reader.readLightPbxProvision(LABEL),
        (error) => error instanceof LightPbxProvisionError && error.code === "LIGHTPBX_RECORD_LOOKUP_FAILED",
    );
    await assert.rejects(reader.readLightPbxProvision(LABEL), { code: "LIGHTPBX_RECORD_LOOKUP_FAILED" });
    assert.equal(calls.record, 2);
});

test("rejects a resolver key whose provision payload is missing", async () => {
    const { reader } = build({ payload: null });
    await assert.rejects(reader.readLightPbxProvision(LABEL), { code: "LIGHTPBX_PAYLOAD_MISSING" });
});

test("rejects malformed JSON and invalid schema, label, and target data", async () => {
    const cases = [
        ["{", "LIGHTPBX_PAYLOAD_INVALID_JSON"],
        [JSON.stringify(provision({ schema: "wrong" })), "LIGHTPBX_SCHEMA_UNSUPPORTED"],
        [JSON.stringify(provision({ label: "123" })), "LIGHTPBX_LABEL_MISMATCH"],
        [JSON.stringify(provision({ routing: { targets: ["person@example.com"] } })), "LIGHTPBX_TARGET_INVALID"],
    ];
    for (const [payload, code] of cases) {
        const { reader } = build({ payload });
        await assert.rejects(reader.readLightPbxProvision(LABEL), { code });
    }
});

test("rejects incomplete address configuration and times out stalled lookups", async () => {
    assert.throws(
        () => createLightPbxProvisionReader({
            rpcUrl: "https://polygon.example",
            contractAddresses: { ENSRegistry: CONTRACT_ADDRESSES.ENSRegistry },
        }),
        { code: "LIGHTPBX_CONFIG_INVALID" },
    );

    const { reader } = build({
        getRecord: () => new Promise(() => {}),
    });
    await assert.rejects(reader.readLightPbxProvision(LABEL), { code: "LIGHTPBX_LOOKUP_TIMEOUT" });
});
