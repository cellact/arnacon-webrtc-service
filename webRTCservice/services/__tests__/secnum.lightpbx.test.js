const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const secnum = require("../secnum");
const { createBlockchainApi } = require("../../modules/gateways/blockchain/BlockchainApi");

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
    gcpWallets = {},
} = {}) {
    const calls = {
        lightPbx: [],
        addresses: [],
        owners: [],
        gcp: [],
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
            lookupWalletByWeb2Identity: async (web2identity) => {
                calls.gcp.push(web2identity);
                return gcpWallets[web2identity] || null;
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

test("inbound lookup uses GCP wallet first for numeric identity", async () => {
    const numberIdentity = `${LABEL}.secnumtest.global`;
    const gcpWallet = "0x1111111111111111111111111111111111111111";
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: null,
        gcpWallets: {
            [LABEL]: gcpWallet,
        },
        addresses: {
            [numberIdentity]: WALLET,
        },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            callId: "call-gcp-hit",
        },
        helpers,
    });
    assert.equal(result.route, "webrtc");
    assert.equal(result.wallet, gcpWallet);
    assert.deepEqual(calls.gcp, [LABEL]);
    assert.deepEqual(calls.addresses, []);
    assert.deepEqual(calls.owners, []);
});

test("inbound lookup falls back to ENS when GCP wallet missing", async () => {
    const numberIdentity = `${LABEL}.secnumtest.global`;
    const { helpers, calls } = buildHelpers({
        lightPbxRoute: null,
        gcpWallets: {},
        addresses: {
            [numberIdentity]: WALLET,
        },
    });
    const result = await secnum.resolveInboundTarget({
        payload: {
            to: LABEL,
            callId: "call-gcp-fallback",
        },
        helpers,
    });
    assert.equal(result.route, "webrtc");
    assert.equal(result.wallet, WALLET);
    assert.deepEqual(calls.gcp, [LABEL]);
    assert.deepEqual(calls.addresses, [numberIdentity]);
});

function minimalBlockchainConfig() {
    return {
        polygon: {
            rpc: "http://127.0.0.1:8545",
            ENSRegistry: "0x0000000000000000000000000000000000000001",
            NameWrapper: "0x0000000000000000000000000000000000000002",
            ServiceProviderRegistry: "0x0000000000000000000000000000000000000003",
        },
        sapphire: { rpc: "http://127.0.0.1:8546" },
        sapphireTestnet: {
            rpc: "http://127.0.0.1:8547",
            NFTCallerIdPool: "0x0000000000000000000000000000000000000004",
        },
        roflLogic: {},
    };
}

test("notification provider uses hardcoded default for secnum domains", async () => {
    delete process.env.NOTIFICATION_PROVIDER_ADDRESS;
    delete process.env.SECNUM_NOTIFICATION_PROVIDER_ADDRESS;
    const api = createBlockchainApi({
        config: minimalBlockchainConfig(),
        createHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
        logger: { log() {}, warn() {}, error() {} },
    });
    const cfg = await api.resolveCallerServiceProviderContract("972557012402.secnumtest.global");
    assert.equal(cfg.notificationRegistryAddress, "0xf648a26677aa51e62fFEaE40B2c7C8E26e0f464d");
    assert.equal(cfg.isDefault, true);
});

test("notification provider address override is honored", async () => {
    process.env.NOTIFICATION_PROVIDER_ADDRESS = "0x2222222222222222222222222222222222222222";
    const api = createBlockchainApi({
        config: minimalBlockchainConfig(),
        createHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
        logger: { log() {}, warn() {}, error() {} },
    });
    const cfg = await api.resolveCallerServiceProviderContract("972557012402.secnum.global");
    assert.equal(cfg.notificationRegistryAddress, "0x2222222222222222222222222222222222222222");
    delete process.env.NOTIFICATION_PROVIDER_ADDRESS;
});

test("web2 wallet resolution ignores GCP wallet and uses sdk owner lookup", async () => {
    const originalFetch = global.fetch;
    const originalTokenFile = process.env.GCP_MAPPING_TOKEN_FILE;
    const originalServiceAccount = process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secnum-wallet-test-"));
    const tokenPath = path.join(tempDir, "token.txt");
    fs.writeFileSync(tokenPath, "test-token", "utf8");

    const fetchCalls = [];
    const sdkCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(String(url));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                web2identity: "972557012421",
                web3identity: "9b44bd2662a14a958feeb8c1f7f3967a",
                wallet: "0x1111111111111111111111111111111111111111",
            }),
            text: async () => "",
        };
    };

    process.env.GCP_MAPPING_TOKEN_FILE = tokenPath;
    delete process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;

    try {
        const api = createBlockchainApi({
            config: minimalBlockchainConfig(),
            createHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
            logger: { log() {}, warn() {}, error() {} },
            arnaconSdkFactory: (sdkConfig) => ({
                getOwner: async (name) => {
                    sdkCalls.push({ sdkConfig, name });
                    return "0x2222222222222222222222222222222222222222";
                },
            }),
        });
        const wallet = await api.resolveWalletByWeb2Identity("972557012421");

        assert.equal(wallet, "0x2222222222222222222222222222222222222222");
        assert.equal(fetchCalls.length, 1);
        assert.equal(sdkCalls.length, 1);
        assert.equal(sdkCalls[0].name, "9b44bd2662a14a958feeb8c1f7f3967a.arnacon.global");
    } finally {
        global.fetch = originalFetch;
        if (originalTokenFile === undefined) delete process.env.GCP_MAPPING_TOKEN_FILE;
        else process.env.GCP_MAPPING_TOKEN_FILE = originalTokenFile;
        if (originalServiceAccount === undefined) delete process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;
        else process.env.GCP_SERVICE_ACCOUNT_JSON_FILE = originalServiceAccount;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("web2 wallet resolution keeps .arnacon.global suffix and returns null when sdk owner is zero", async () => {
    const originalFetch = global.fetch;
    const originalTokenFile = process.env.GCP_MAPPING_TOKEN_FILE;
    const originalServiceAccount = process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secnum-wallet-test-"));
    const tokenPath = path.join(tempDir, "token.txt");
    fs.writeFileSync(tokenPath, "test-token", "utf8");

    const sdkCalls = [];
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            web2identity: "972557012421",
            web3identity: "9b44bd2662a14a958feeb8c1f7f3967a.arnacon.global",
            wallet: "0x1111111111111111111111111111111111111111",
        }),
        text: async () => "",
    });

    process.env.GCP_MAPPING_TOKEN_FILE = tokenPath;
    delete process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;

    try {
        const api = createBlockchainApi({
            config: minimalBlockchainConfig(),
            createHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
            logger: { log() {}, warn() {}, error() {} },
            arnaconSdkFactory: () => ({
                getOwner: async (name) => {
                    sdkCalls.push(name);
                    return "0x0000000000000000000000000000000000000000";
                },
            }),
        });
        const wallet = await api.resolveWalletByWeb2Identity("972557012421");

        assert.equal(wallet, null);
        assert.deepEqual(sdkCalls, ["9b44bd2662a14a958feeb8c1f7f3967a.arnacon.global"]);
    } finally {
        global.fetch = originalFetch;
        if (originalTokenFile === undefined) delete process.env.GCP_MAPPING_TOKEN_FILE;
        else process.env.GCP_MAPPING_TOKEN_FILE = originalTokenFile;
        if (originalServiceAccount === undefined) delete process.env.GCP_SERVICE_ACCOUNT_JSON_FILE;
        else process.env.GCP_SERVICE_ACCOUNT_JSON_FILE = originalServiceAccount;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
