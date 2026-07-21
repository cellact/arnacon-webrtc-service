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
const IDENTITY = `${LABEL}.secnumtest.global`;
const TARGET = `${"a".repeat(64)}.email.global`;
const SECOND_TARGET = `${"b".repeat(64)}.email.global`;

function provision(overrides = {}) {
    const base = {
        schema: "arnacon.lightpbx.endpoint.v1",
        kind: "lightpbx_external_extension",
        identity: IDENTITY,
        label: LABEL,
        owner: "0x4444444444444444444444444444444444444444",
        provider: "cellact",
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
        tenantName: "secnumtest",
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
        identity: IDENTITY,
        owner: "0x4444444444444444444444444444444444444444",
        type: "DIRECT",
        targets: [TARGET],
        rejectedTargetCount: 0,
        groupId: null,
        revision: 7,
        configHash: null,
    });
    assert.equal(second, first);
    assert.deepEqual(calls.recordArgs, [`lightpbx.${LABEL}`, "secnumtest"]);
    assert.deepEqual(calls.provisionArgs, ["secnumtest", `lightpbx.${LABEL}`]);
    assert.equal(calls.record, 2);
    assert.equal(calls.provision, 1);
});

test("accepts object MULTI_RING payloads and filters malformed or duplicate targets", async () => {
    const { reader } = build({
        payload: provision({
            routing: {
                type: "MULTI_RING",
                targets: [TARGET, "person@example.com", TARGET, SECOND_TARGET],
            },
        }),
    });
    const route = await reader.readLightPbxProvision(LABEL);
    assert.equal(route.type, "MULTI_RING");
    assert.deepEqual(route.targets, [TARGET, SECOND_TARGET]);
    assert.equal(route.rejectedTargetCount, 2);
});

test("caches a confirmed empty resolver record for at most the configured miss TTL", async () => {
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
        [JSON.stringify(provision({ identity: `${LABEL}.secnum.global` })), "LIGHTPBX_IDENTITY_MISMATCH"],
        [JSON.stringify(provision({ provider: "other" })), "LIGHTPBX_PROVIDER_INVALID"],
        [JSON.stringify(provision({ routing: { type: "IVR" } })), "LIGHTPBX_ROUTE_UNSUPPORTED"],
        [JSON.stringify(provision({ routing: { targets: ["person@example.com"] } })), "LIGHTPBX_TARGET_INVALID"],
        [JSON.stringify(provision({ routing: { type: "MULTI_RING", targets: Array(6).fill(TARGET) } })), "LIGHTPBX_MULTIRING_TARGET_COUNT"],
    ];
    for (const [payload, code] of cases) {
        const { reader } = build({ payload });
        await assert.rejects(reader.readLightPbxProvision(LABEL), { code });
    }
});

test("refreshes on resolver pointer change and rejects revision rollback", async () => {
    let key = "provision-key-v7";
    let currentPayload = provision();
    const { reader, calls } = build({
        getRecord: () => key,
        getProvision: () => currentPayload,
    });
    assert.equal((await reader.readLightPbxProvision(LABEL)).revision, 7);

    key = "provision-key-v8";
    currentPayload = provision({ routing: { revision: 8 } });
    assert.equal((await reader.readLightPbxProvision(LABEL)).revision, 8);
    assert.equal(calls.provision, 2);

    key = "provision-key-v7";
    await assert.rejects(
        reader.readLightPbxProvision(LABEL),
        { code: "LIGHTPBX_REVISION_ROLLBACK" },
    );
    assert.equal(calls.provision, 2, "rollback is detected from the key-addressed cache");
});

test("rejects a called identity outside the configured exact number domain", async () => {
    const { reader, calls } = build();
    await assert.rejects(
        reader.readLightPbxProvision(LABEL, `${LABEL}.secnum.global`),
        { code: "LIGHTPBX_CALLED_IDENTITY_INVALID" },
    );
    assert.equal(calls.record, 0);
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
