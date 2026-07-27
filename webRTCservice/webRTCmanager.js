// WebRTC-to-SIP Bridge Service
// Translates the Arnacon Android native WebRTC protocol into SIP for Kamailio.
// Two-phase flow:
//   Phase 1: FCM signaling → data-channel-only PeerConnection (PC1)
//   Phase 2: data channel signaling → audio renegotiation → SIP INVITE to Kamailio (PC2)
//
// Architecture:
//   Android Client ↔ [PC1 werift] ↔ RTP piping ↔ [PC2 werift via sip.js] ↔ Kamailio/RTPEngine ↔ PSTN
//                                                    ↕ (SIP signaling via sip.js over WSS)

// ════════════════════════════════════════════════════════════
// LAYER 1 — DECLARE
// Polyfill, requires, and function declarations only (no listening server yet).
// Flow: declare → compose/start → react at runtime (Layers 2–3 below).
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// POLYFILL — Expose werift as the global WebRTC implementation
// so that sip.js (which expects browser APIs) can use it.
// MUST come before requiring sip.js.
// ════════════════════════════════════════════════════════════

const { applyPolyfills } = require("./modules/media/werift/Polyfills");
const {
    fixSdpForWerift,
    waitForIceGathering,
    formatIceCandidates,
    stripCandidatesFromSdp,
    getRelayCandidates,
    embedCandidatesInSdp,
    patchInactiveToSendrecv,
    logSdp: logSdpUtil,
    addIceCandidates: addIceCandidatesUtil,
} = require("./modules/media/negotiation/SdpUtils");
applyPolyfills({ fixSdpForWerift, logger: console });
const werift = require("werift");
function sendJsonError(res, statusCode, message) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
}

function createHttpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
    });
}

function logSdp(sessionId, label, sdp) {
    return logSdpUtil(sessionId, label, sdp, console);
}

async function addIceCandidates(pc, candidates) {
    return addIceCandidatesUtil(pc, candidates, RTCIceCandidate);
}

// Send ACK only — stops the caller's 5-second RING retry timer.
function sendAck(sessionId) {
    return dataChannelApi.sendAck(sessionId);
}

// Send audio SDP answer only — call this when the callee has actually picked up.
function sendAnswer(sessionId, answerSdp) {
    return dataChannelApi.sendAnswer(sessionId, answerSdp);
}

// Convenience: ACK + answer together (used for inbound calls where both happen at SIP pickup).
function sendAckAndAnswer(sessionId, answerSdp) {
    return dataChannelApi.sendAckAndAnswer(sessionId, answerSdp);
}

function normalizePositiveCallId(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function ensureSessionCallId(session) {
    if (!session) return Math.max(1, (Date.now() % 1000000000) + Math.floor(Math.random() * 1000));
    const existing = normalizePositiveCallId(session.activeCallId);
    if (existing) return existing;
    const fromRing = normalizePositiveCallId(session.lastRingOfferPayload?.callId);
    session.activeCallId = fromRing || Math.max(1, (Date.now() % 1000000000) + Math.floor(Math.random() * 1000));
    return session.activeCallId;
}

function sendEndCallSignal(sessionId, reason = "hangup") {
    const session = sessions.get(sessionId);
    const callId = ensureSessionCallId(session);
    sendDataChannelMessage(sessionId, {
        msgType: "signaling",
        action: "end-call",
        callId,
        reason,
    });
}

function ensureLocalAudioTrack(session, pc, sessionId) {
    return callSdpUseCases.ensureLocalAudioTrack(session, pc, sessionId);
}

async function createAnswerSdp(pc, sessionId, label) {
    return callSdpUseCases.createAnswerSdp(pc, sessionId, label);
}

function sendSignalingOffer(sessionId, sdp) {
    return callSdpUseCases.sendSignalingOffer(sessionId, sdp);
}

function attachSbcByeHandler(sipSession, sessionId) {
    return sipRuntimeApi.attachSbcByeHandler(sipSession, sessionId);
}

function setupPc2(session, pc2, sessionId) {
    return sipRuntimeApi.setupPc2(session, pc2, sessionId);
}

// ═════════════════════════════════════════════════════════════
// IMPORTS (sip.js loaded AFTER polyfill)
// ═════════════════════════════════════════════════════════════

const { ethers } = require("ethers");
const path = require("path");
const http2 = require("http2");
const fs = require("fs");
const crypto = require("crypto");
const { createSessionStore } = require("./modules/runtime/SessionStore");
const { createCallRouter } = require("./modules/routing/CallRouterApi");
const { createBlockchainApi } = require("./modules/gateways/blockchain/BlockchainApi");
const { BlockchainGateway } = require("./modules/gateways/blockchain/BlockchainGateway");
const { createNotificationApi } = require("./modules/gateways/notification/NotificationApi");
const { NotificationGateway } = require("./modules/gateways/notification/NotificationGateway");
const { createHandlers } = require("./modules/server/HttpHandlers");
const { createHttpServers } = require("./modules/server/HttpServer");
const { createPeerConnectionFactory } = require("./modules/media/werift/PeerConnectionFactory");
const { createSipClient } = require("./modules/gateways/sip/SipClient");
const { SipGateway } = require("./modules/gateways/sip/SipGateway");
const { createMessagingFlow } = require("./modules/messaging/MessagingFlow");
const { createInboundCallFlow } = require("./modules/calls/inbound/InboundCallFlow");
const { createOfferFlow } = require("./modules/calls/webrtc/WebRtcOfferUseCase");
const { createHandshakeFlow } = require("./modules/calls/webrtc/WebRtcHandshakeUseCase");
const { MultiringCoordinator } = require("./modules/calls/webrtc/MultiringCoordinator");
const { createDataChannelApi } = require("./modules/participants/signaling/DataChannelGateway");
const { createSipRuntime } = require("./modules/gateways/sip/SipRuntime");
const { adaptRtpPayloadType } = require("./modules/media/codecs/rtp");
const { MediaGraphFactory } = require("./modules/media/MediaGraphFactory");
const { CallSdpUseCases } = require("./modules/calls/useCases/CallSdpUseCases");
const { SignalingAuthVerifier, createSignalingPipeline } = require("./modules/participants/signaling/SignalingPipeline");
const { createMinuteCounter } = require("./modules/callFeatures/minuteCounter/MinuteCounter");
const { MinuteCounterPolicy } = require("./modules/callFeatures/minuteCounter/MinuteCounterPolicy");
const { AddressParser } = require("./modules/routing/AddressParser");
const { ServiceRegistry: ServiceRuntimeRegistry } = require("./modules/routing/ServiceRegistry");
const { ServiceContextFactory } = require("./modules/routing/ServiceContextFactory");
const { createLightPbxProvisionReader } = require("./modules/routing/LightPbxProvisionReader");
const { DestinationResolver } = require("./modules/routing/DestinationResolver");
const { CallerIdResolver } = require("./modules/routing/CallerIdResolver");
const { CallRegistry } = require("./modules/calls/CallRegistry");
const { CallFactory } = require("./modules/calls/CallFactory");
const { ParticipantFactory } = require("./modules/participants/ParticipantFactory");
const { createPolyCore } = require("./modules/calls/poly/createPolyCore");
const { WebRtcOutboundLegFactory } = require("./modules/calls/webrtc/WebRtcOutboundLegFactory");
const { LEG_EVENTS, makeLegEvent } = require("./modules/calls/poly/ports");
const { LEG_STATES, canBeRung, isActiveCall } = require("./modules/calls/poly/states");
const { isInactiveOffer } = require("./modules/calls/poly/negotiation/sdp");
const { routeToCodecPolicy } = require("./modules/media/negotiation/CodecPolicy");
const { narrowAudioOfferForCodecPolicy } = require("./modules/media/negotiation/SdpCodecNegotiator");
const {
    identityLabel,
    createCallPairRef,
} = require("./modules/runtime/CallPairRef");
const { CallPairResolver } = require("./modules/runtime/CallPairResolver");
const {
    MediaStreamTrack,
} = werift;
const RTCPeerConnection = globalThis.RTCPeerConnection;
const RTCSessionDescription = globalThis.RTCSessionDescription;
const RTCIceCandidate = globalThis.RTCIceCandidate;
const { UserAgent, Registerer, Inviter, SessionState } = require("sip.js");
const { WebSocket: WsWebSocket } = require("ws");

// ════════════════════════════════════════════════════════════
// LAYER 2 — COMPOSE / START
// Load config, wire modules (DI), attach HTTP handlers, bind ports.
// ════════════════════════════════════════════════════════════

// ─── Load config from config.json + services/*.json ──────────
const PACKAGE_ROOT = path.resolve(__dirname, "..");
function resolveFirstExistingPath(candidates) {
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return "";
}

function normalizeInputPath(inputPath) {
    if (!inputPath) return "";
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

const CONFIG_OVERRIDE = process.env.WEBRTC_CONFIG_PATH || process.env.ARNACON_WEBRTC_CONFIG_PATH || "";
const configOverridePath = normalizeInputPath(CONFIG_OVERRIDE);
const CONFIG_PATH = resolveFirstExistingPath([
    configOverridePath,
    path.resolve(process.cwd(), "config", "config.json"),
    path.resolve(process.cwd(), "config.json"),
    path.join(PACKAGE_ROOT, "config", "config.json"),
    path.join(PACKAGE_ROOT, "config.json"),
]);
if (!CONFIG_PATH) {
    throw new Error(
        `WebRTC config not found. Checked: ${[
            configOverridePath,
            path.resolve(process.cwd(), "config", "config.json"),
            path.resolve(process.cwd(), "config.json"),
            path.join(PACKAGE_ROOT, "config", "config.json"),
            path.join(PACKAGE_ROOT, "config.json"),
        ].filter(Boolean).join(", ")}`
    );
}
const CONFIG_BASE_DIR = path.dirname(CONFIG_PATH);
const fullConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const IVR_DEMO_AUDIO_DIR_RAW = process.env.IVR_DEMO_AUDIO_DIR || "demoAudio";
const IVR_DEMO_AUDIO_DIR = path.isAbsolute(IVR_DEMO_AUDIO_DIR_RAW)
    ? IVR_DEMO_AUDIO_DIR_RAW
    : path.resolve(PACKAGE_ROOT, IVR_DEMO_AUDIO_DIR_RAW);
console.log(`[IVR-AUDIO] Demo audio directory: ${IVR_DEMO_AUDIO_DIR}`);
const _deployEnvEarly = process.env.DEPLOY_ENV || "development";
const _commonEarly = (fullConfig[_deployEnvEarly] || {}).common || {};
const GLOBAL_CONFIG_OVERRIDE = process.env.WEBRTC_GLOBAL_CONFIG_PATH || process.env.ARNACON_WEBRTC_GLOBAL_CONFIG_PATH || "";
const globalOverridePath = normalizeInputPath(GLOBAL_CONFIG_OVERRIDE);
const GLOBAL_CONFIG_PATH = resolveFirstExistingPath([
    globalOverridePath,
    _commonEarly.globalServiceConfigPath
        ? (_commonEarly.globalServiceConfigPath.startsWith("/")
            ? _commonEarly.globalServiceConfigPath
            : path.resolve(CONFIG_BASE_DIR, _commonEarly.globalServiceConfigPath))
        : "",
    path.resolve(process.cwd(), "config", "globalserviceconfig.json"),
    path.resolve(process.cwd(), "globalserviceconfig.json"),
    path.join(PACKAGE_ROOT, "config", "globalserviceconfig.json"),
    path.join(PACKAGE_ROOT, "globalserviceconfig.json"),
]);
let fullGlobalConfig = {};
if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    fullGlobalConfig = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
}

function resolveRuntimePath(entryPath) {
    if (!entryPath) return "";
    if (path.isAbsolute(entryPath)) return entryPath;
    const fromConfigDir = path.resolve(CONFIG_BASE_DIR, entryPath);
    if (fs.existsSync(fromConfigDir)) return fromConfigDir;
    return path.resolve(PACKAGE_ROOT, entryPath);
}
const deployEnv = process.env.DEPLOY_ENV || "development";
const envConfig = fullConfig[deployEnv] || {};
const commonConfig = envConfig.common || {};
const globalEnvConfig = fullGlobalConfig[deployEnv] || {};
const serviceRegistry = globalEnvConfig.services || envConfig.services || {};
const loadedServices = {};

for (const [serviceId, serviceEntry] of Object.entries(serviceRegistry)) {
    const serviceConfigPath = resolveRuntimePath(serviceEntry.configPath);
    const serviceModulePath = resolveRuntimePath(serviceEntry.modulePath);
    const serviceConfigRoot = JSON.parse(fs.readFileSync(serviceConfigPath, "utf8"));
    const serviceConfig = serviceConfigRoot[deployEnv];
    if (!serviceConfig) {
        throw new Error(`Invalid service config for ${serviceId}: missing ${deployEnv} block`);
    }
    if (!serviceConfig.static || typeof serviceConfig.static !== "object") {
        throw new Error(`Invalid service config for ${serviceId}: missing ${deployEnv}.static`);
    }
    const serviceModule = require(serviceModulePath);
    const providerId = serviceEntry.providerId || serviceConfig.providerId || serviceId;
    if (typeof serviceModule.resolveDestination !== "function" || typeof serviceModule.resolveInboundTarget !== "function") {
        throw new Error(`Service module ${serviceId} must export resolveDestination() and resolveInboundTarget()`);
    }
    loadedServices[serviceId] = {
        id: serviceId,
        providerId,
        notifyPort: serviceEntry.notifyPort,
        callbackPort: serviceEntry.callbackPort || serviceEntry.notifyPort,
        configPath: serviceEntry.configPath,
        modulePath: serviceEntry.modulePath,
        serviceConfig,
        serviceConstants: serviceConfig.static || {},
        primaryDomain: serviceModule.primaryDomain || null,
        domainAliases: serviceModule.domainAliases || [],
        resolveDestination: serviceModule.resolveDestination,
        resolveCallerId: serviceModule.resolveCallerId,
        resolveInboundTarget: serviceModule.resolveInboundTarget,
        normalizeIdentity: serviceModule.normalizeIdentity,
        shapeNotifyPayload: serviceModule.shapeNotifyPayload,
        hooks: serviceModule.hooks || {},
    };
}

function pickRuntimeConfig(key, fallback = undefined) {
    if (globalEnvConfig[key] !== undefined) return globalEnvConfig[key];
    if (commonConfig[key] !== undefined) return commonConfig[key];
    return fallback;
}

const config = {
    // Source-of-truth stays in Kamailio config.json (no duplication in globalserviceconfig.json).
    domain: commonConfig.domain,
    kamailioWssHost: commonConfig.kamailioWssHost,
    kamailioWssPort: commonConfig.kamailioWssPort,
    kamailioWssScheme: commonConfig.kamailioWssScheme,
    bindIp: commonConfig.bindIp,
    tlsCertPath: commonConfig.tlsCertPath,
    roflBaseUrl: pickRuntimeConfig("roflBaseUrl"),
    messageProcessorUrl: pickRuntimeConfig("messageProcessorUrl"),
    minuteCounterPath: process.env.MINUTE_COUNTER_PATH || pickRuntimeConfig("minuteCounterPath", "/etc/webrtcservice/minute-counter.json"),
    polygon: pickRuntimeConfig("polygon", {}),
    lightPbx: pickRuntimeConfig("lightPbx", {}),
    sapphire: pickRuntimeConfig("sapphire", {}),
    sapphireTestnet: pickRuntimeConfig("sapphireTestnet", {}),
    roflLogic: pickRuntimeConfig("roflLogic", {}),
};
const serviceRuntimes = loadedServices;
const selectedServiceId = process.env.SERVICE_ID || null;
const allowMultiListenerMode = process.env.ALLOW_MULTI_LISTENER === "true";
if (!selectedServiceId && !allowMultiListenerMode) {
    throw new Error("SERVICE_ID is required. Set ALLOW_MULTI_LISTENER=true only for legacy local mode.");
}
const activeServiceRuntimes = selectedServiceId
    ? Object.values(serviceRuntimes).filter((runtime) => runtime.id === selectedServiceId)
    : Object.values(serviceRuntimes);
if (selectedServiceId && activeServiceRuntimes.length === 0) {
    throw new Error(`SERVICE_ID '${selectedServiceId}' not found in config service registry`);
}
const defaultServiceRuntime = activeServiceRuntimes[0] || Object.values(serviceRuntimes)[0] || null;
const serviceRuntimeRegistry = new ServiceRuntimeRegistry({
    serviceRuntimes,
    activeServiceRuntimes,
    logger: console,
});

function getServiceRuntime(serviceId = null) {
    return serviceRuntimeRegistry.get(serviceId) || defaultServiceRuntime;
}

// Kamailio SIP config
// Transport scheme is configurable: env > config.json > default "wss".
// Use "ws" only for trusted/co-located hops; "wss" for cross-host.
const KAMAILIO_WSS_SCHEME = process.env.KAMAILIO_WSS_SCHEME || config.kamailioWssScheme || "wss";
const KAMAILIO_WSS_HOST = process.env.KAMAILIO_WSS_HOST || config.kamailioWssHost || config.domain;
const KAMAILIO_WSS_PORT = Number(process.env.KAMAILIO_WSS_PORT || config.kamailioWssPort || 8443);
const KAMAILIO_WSS_URL = `${KAMAILIO_WSS_SCHEME}://${KAMAILIO_WSS_HOST}:${KAMAILIO_WSS_PORT}`;
const KAMAILIO_DOMAIN = process.env.KAMAILIO_DOMAIN || KAMAILIO_WSS_HOST || config.domain;
const KAMAILIO_REGISTER_EXPIRES = 300;
console.log(`[Startup] SIP WSS target: ${KAMAILIO_WSS_URL}`);

const INTERNAL_BIND_IP = config.bindIp || "127.0.0.1";
const INTERNAL_CALLBACK_PROTOCOL =
    String(process.env.INTERNAL_CALLBACK_PROTOCOL || process.env.WEBRTC_INTERNAL_CALLBACK_PROTOCOL || "https")
        .toLowerCase() === "http"
        ? "http"
        : "https";
const OPENAI_SIP_CONFIG = {
    kamailioHost: process.env.OPENAI_SIP_KAMAILIO_HOST || config.kamailioWssHost || config.domain,
    kamailioPort: Number(process.env.OPENAI_SIP_KAMAILIO_PORT || 5060),
    kamailioDomain: process.env.OPENAI_SIP_KAMAILIO_DOMAIN || KAMAILIO_DOMAIN,
    bindIp: process.env.OPENAI_SIP_BIND_IP || "0.0.0.0",
    contactHost: process.env.OPENAI_SIP_CONTACT_HOST || INTERNAL_BIND_IP,
    mediaIp: process.env.OPENAI_SIP_MEDIA_IP || INTERNAL_BIND_IP,
    sipUser: process.env.OPENAI_SIP_USER || "openai-bridge",
    targetUser: process.env.OPENAI_SIP_TARGET_USER || "2005",
    payloadType: Number(process.env.OPENAI_SIP_PAYLOAD_TYPE || 0),
    authPort: Number(process.env.OPENAI_SIP_AUTH_PORT || 2005),
    authBindIp: process.env.OPENAI_SIP_AUTH_BIND_IP || "0.0.0.0",
    authPath: process.env.OPENAI_SIP_AUTH_PATH || "/authorize-openai-call",
    transferPath: process.env.OPENAI_SIP_TRANSFER_PATH || "/transfer-openai-call",
    authUseHttps: process.env.OPENAI_SIP_AUTH_HTTPS !== "false",
    authTlsCertPath: process.env.OPENAI_SIP_AUTH_TLS_CERT || `${config.tlsCertPath}/fullchain.pem`,
    authTlsKeyPath: process.env.OPENAI_SIP_AUTH_TLS_KEY || `${config.tlsCertPath}/privkey.pem`,
};
const OPENAI_SALES_TRIGGER_CALLER = process.env.OPENAI_SALES_TRIGGER_CALLER || "972557012423";
const OPENAI_SALES_AGENT_FROM = process.env.OPENAI_SALES_AGENT_FROM || "2005.secnum.global";

// ROFL API config
const ROFL_BASE_URL = config.roflBaseUrl;
const USE_LOCAL_ROFL_LOGIC =
    String(process.env.USE_LOCAL_ROFL_LOGIC || pickRuntimeConfig("useLocalRoflLogic", true)) === "true";
const MESSAGE_PROCESSOR_URL =
    config.messageProcessorUrl ||
    "https://europe-west3-asterisk-tts-test.cloudfunctions.net/client_msg_processor";

// ─── Minimal ABIs ───────────────────────────────────────────
const SIGNALING_PLAN_ABI = [
    "function getSignalingPlan(string _from, string _to, string _message, uint8 _notificationType) view returns (tuple(string url, string method, string contentType, string body, string headers, string fallbackUrl, string responseExtractField, string placeholderKey)[])"
];

// Notification type constants (match INotificationProvider.sol)
const NOTI_TYPE_CALL = 0;
const NOTI_TYPE_REALTIME_SIGNAL = 4;

// ─── Ephemeral Wallet (for CLIENT_ETH_SIGN steps) ───────────
const ephemeralWallet = ethers.Wallet.createRandom();
console.log(`Ephemeral wallet generated: ${ephemeralWallet.address}`);

// ─── Active Sessions (single injected store) ────────────────
const sessionStore = createSessionStore();
const sessions = sessionStore.sessions;
const sessionsByUser = sessionStore.sessionsByUser; // stableKey(from, to) → sessionId
const pendingBridges = sessionStore.pendingBridges; // callee wallet (lowercase) → { callerSessionId, resolve, reject, timer }
const pendingInboundCalls = sessionStore.pendingInboundCalls; // callee wallet (lowercase) → { fromNumber, toNumber, callId, timer }
const callRegistry = new CallRegistry({ logger: console });
const participantFactory = new ParticipantFactory({
    parseAddress: (...args) => parseAddress(...args),
    logger: console,
});
const callFactory = new CallFactory({
    participantFactory,
    logger: console,
});
const mediaGraphFactory = new MediaGraphFactory({
    sessions,
    MediaStreamTrack,
    logger: console,
});
const minuteCounterApi = createMinuteCounter({
    filePath: config.minuteCounterPath,
    logger: console,
});
const minuteCounterPolicy = new MinuteCounterPolicy({
    getServiceRuntime: (...args) => getServiceRuntime(...args),
});
const dataChannelApi = createDataChannelApi({ sessions, logger: console });
const messagingFlowApi = createMessagingFlow({
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    processorUrl: MESSAGE_PROCESSOR_URL,
    fetchImpl: fetch,
    logger: console,
    createHttpError: (...args) => createHttpError(...args),
});

// ─── ICE Servers ────────────────────────────────────────────
// Give werift the SAME TURN the mobile clients use so the server can gather its
// own `relay` candidate. Without this the server only offers host (private) +
// srflx (public IP:port), and a relay-only client can only connect via the
// srflx -- which silently dies whenever that UDP port isn't open inbound on the
// cloud firewall. With a relay candidate the pair becomes client-relay <->
// server-relay (both reachable outbound through TURN), independent of inbound SG.
// Overridable via env for ops; defaults to the cellact coturn (test/test).
const TURN_URL = process.env.WEBRTC_TURN_URL || "turn:t1.cellact.nl:3478";
const TURN_USERNAME = process.env.WEBRTC_TURN_USERNAME || "test";
const TURN_CREDENTIAL = process.env.WEBRTC_TURN_CREDENTIAL || "test";
const STUN_URL = process.env.WEBRTC_STUN_URL || "stun:t1.cellact.nl:3478";
const ICE_SERVERS = [
    { urls: STUN_URL },
    { urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL },
];

// ─── Modular APIs (DI wiring) ───────────────────────────────
const blockchainApi = createBlockchainApi({
    config,
    providerPolicy: null,
    createHttpError,
    logger: console,
});
const blockchainGateway = new BlockchainGateway({ blockchainApi });
const callRouterApi = createCallRouter({
    roflBaseUrl: ROFL_BASE_URL,
    fetchImpl: fetch,
    logger: console,
    useLocalRoflLogic: USE_LOCAL_ROFL_LOGIC,
    lookupBusinessNumberImpl: (...args) => blockchainGateway.roflFindBusinessNumber(...args),
    assignFromNumberImpl: (...args) => blockchainGateway.roflAssignFromNumber(...args),
});
const roflLogicInfo = blockchainApi.getRoflLogicInfo();
console.log(
    `[ROFL] mode=${USE_LOCAL_ROFL_LOGIC ? "local_rofl_logic" : "remote_http"} ` +
        `baseUrl=${ROFL_BASE_URL || "n/a"} rpc=${roflLogicInfo.rpc || "n/a"} ` +
        `chainId=${roflLogicInfo.chainId || "n/a"} ` +
        `businessDb=${roflLogicInfo.businessNumberDbAddress || "n/a"} ` +
        `businessDbRpc=${roflLogicInfo.businessNumberDbRpc || "n/a"} ` +
        `businessDbChainId=${roflLogicInfo.businessNumberDbChainId || "n/a"} ` +
        `callerIdPool=${roflLogicInfo.callerIdPoolAddress || "n/a"} ` +
        `callerIdPoolRpc=${roflLogicInfo.callerIdPoolRpc || "n/a"} ` +
        `callerIdPoolChainId=${roflLogicInfo.callerIdPoolChainId || "n/a"} ` +
        `roflAddress=${roflLogicInfo.roflAddress || "n/a"}`,
);
const notificationApi = createNotificationApi({
    blockchainApi,
    signalingPlanAbi: SIGNALING_PLAN_ABI,
    notiTypeCall: NOTI_TYPE_CALL,
    ephemeralWallet,
    logger: console,
    fetchImpl: fetch,
});
const notificationGateway = new NotificationGateway({ notificationApi, logger: console });
const addressParserApi = new AddressParser({ callRouter: callRouterApi });
const lightPbxConfig = config.lightPbx || {};
const lightPbxProvisionReader = lightPbxConfig.enabled
    ? createLightPbxProvisionReader({
        rpcUrl: process.env.LIGHTPBX_RPC_URL || config.polygon.rpc,
        contractAddresses: lightPbxConfig.contractAddresses,
        tenantName: process.env.LIGHTPBX_TENANT || lightPbxConfig.tenantName,
        chainId: Number(process.env.LIGHTPBX_CHAIN_ID || lightPbxConfig.chainId || 137),
        timeoutMs: Number(process.env.LIGHTPBX_LOOKUP_TIMEOUT_MS || lightPbxConfig.lookupTimeoutMs || 1200),
        routeTtlMs: Number(lightPbxConfig.routeTtlMs || 45000),
        missTtlMs: Math.min(Number(lightPbxConfig.missTtlMs || 10000), 10000),
        logger: console,
    })
    : null;
console.log("[Startup] LightPBX reader", {
    enabled: Boolean(lightPbxProvisionReader),
    chainId: lightPbxConfig.chainId || null,
    tenant: lightPbxConfig.tenantName || null,
});
const serviceContextFactory = new ServiceContextFactory({
    serviceRegistry: serviceRuntimeRegistry,
    zeroAddress: ethers.constants.AddressZero,
    parseAddress: (...args) => parseAddress(...args),
    normalizePhone: (...args) => normalizePhone(...args),
    blockchainApi,
    callRouterApi,
    lightPbxProvisionReader,
    sendNotification: (...args) => sendNotification(...args),
    findOutboundSessionForInbound: (...args) => findOutboundSessionForInbound(...args),
    openSipSession: (...args) => openSipSession(...args),
    openInboundSipSession: (...args) => openInboundSipSession(...args),
    // OpenAI/IVR/multiring service flows are out of scope for the poly cutover.
    notifyAndBridge: () => { throw new Error("notifyAndBridge: service bridging not wired under PolySession"); },
    sendAck: (...args) => sendAck(...args),
    sendAnswer: (...args) => sendAnswer(...args),
    sendAckAndAnswer: (...args) => sendAckAndAnswer(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    handleCallEnd: () => { throw new Error("handleCallEnd: service teardown not wired under PolySession"); },
    emailToEnsName: (...args) => emailToEnsName(...args),
    logger: console,
});
const destinationResolverApi = new DestinationResolver({
    serviceRegistry: serviceRuntimeRegistry,
    serviceContextFactory,
});
const callerIdResolverApi = new CallerIdResolver({
    serviceRegistry: serviceRuntimeRegistry,
    serviceContextFactory,
});
// ─── Legacy coordination core REMOVED (PolySession is the coordinator) ──────
// CallEngine / CallRuntime / route strategies / WebRtcCallOrchestrator / the
// StartCall/Answer/Renegotiate use cases / VerifiedNotifyAnswerHandler /
// SignalingMessageRouter+Handlers, plus OpenAI/IVR/multiring, are gone. The
// retained transport modules (handshake, offer-intake, inbound, SIP, peer
// connection factory, CallSdpUseCases) accept `callRuntime` but only via guarded
// `callRuntime?.x()` calls, so a null placeholder short-circuits them safely.
const callRuntime = null;

const sipRuntimeApi = createSipRuntime({
    sessions,
    patchRouterForDynamicSsrc: (...args) => peerConnectionApi.patchRouterForDynamicSsrc(...args),
    SessionState,
    // Remote SBC BYE -> PolySession teardown via the SIP leg.
    onCallEvent: (sessionId, event) => onSipCallEvent(sessionId, event),
    isInCall: (session) => isSessionInCall(session),
    logger: console,
});
const sipClientApi = createSipClient({
    UserAgent,
    Registerer,
    Inviter,
    SessionState,
    WsWebSocket,
    kamailioWssUrl: KAMAILIO_WSS_URL,
    kamailioDomain: KAMAILIO_DOMAIN,
    registerExpires: KAMAILIO_REGISTER_EXPIRES,
    attachSbcByeHandler: (...args) => attachSbcByeHandler(...args),
    setupPc2: (...args) => setupPc2(...args),
    // Media is now bridged by PolySession's MediaController (MediaGraph),
    // confirmed equivalent to the old MediaRelayController piping.
    startMediaRelay: () => {},
    isTerminalForSipEvents: () => false,
    logger: console,
});
const sipGateway = new SipGateway({
    sipClient: sipClientApi,
    sessionStore,
    logger: console,
});
// Proven outbound WebRTC leg transport (PC + DC + FCM invite payload), reused by
// the poly callee leg via the injected `outboundInvite` seam below.
const outboundLegFactory = new WebRtcOutboundLegFactory({
    sessions,
    createPeerConnection: (...args) => createPeerConnection(...args),
    MediaStreamTrack,
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    getRelayCandidates: (...args) => getRelayCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    onDataChannelOpen: (...args) => onDataChannelOpen(...args),
    onDataChannelMessage: (...args) => onDataChannelMessage(...args),
    logger: console,
});
const peerConnectionApi = createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers: ICE_SERVERS,
    onDataChannelOpen: (sessionId) => onDataChannelOpen(sessionId),
    onPeerConnected: (sessionId) => onPeerConnected(sessionId),
    onDataChannelMessage: (sessionId, raw, meta = {}) => onDataChannelMessage(sessionId, raw, meta),
    onInboundRtp: null, // IVR audio playback dropped
    // Terminal PC state -> PolySession teardown for the pair owning this session.
    onSessionDestroyRequested: (sessionId, event) => onTransportClosed(sessionId, event),
    logger: console,
});
const multiringCoordinator = new MultiringCoordinator({
    sessions,
    sessionsByUser,
    stableKey: (...args) => stableKey(...args),
    createSession: (...args) => createSession(...args),
    outboundLegFactory,
    sendNotification: (...args) => sendNotification(...args),
    applySessionAnswer: async (legSession, offer) => {
        const pc = legSession?.peerConnection;
        if (!pc) throw new Error("MULTI_RING candidate PeerConnection is unavailable");
        await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp, "answer"));
        await addIceCandidates(pc, offer.candidates || []);
    },
    destroySession: (...args) => destroySession(...args),
    notiTypeCall: NOTI_TYPE_CALL,
    logger: console,
});

// Module-backed APIs used by manager orchestration.
function parseAddress(addr, serviceId = null) {
    return addressParserApi.parse(addr, serviceId);
}
const isRawEmail = (...args) => addressParserApi.isRawEmail(...args);
const emailToEnsName = (...args) => addressParserApi.emailToEnsName(...args);
const resolveEnsToAddress = (...args) => blockchainGateway.resolveEnsToAddress(...args);
const signalingAuthVerifier = new SignalingAuthVerifier({
    blockchainGateway,
    sessions,
    sessionsByUser,
    stableKey: (...args) => stableKey(...args),
});
const isEthAddress = (...args) => blockchainGateway.isEthAddress(...args);

const sendNotification = (...args) => notificationGateway.send(...args);

function normalizePhone(value) {
    return minuteCounterPolicy.normalizePhone(value);
}

function getServiceHelpers(serviceRuntime) {
    return serviceContextFactory.helpers(serviceRuntime);
}

async function resolveDestination(parsedTo, parsedFrom = null, serviceId = null) {
    return destinationResolverApi.resolve(parsedTo, parsedFrom, serviceId);
}

async function resolveCallerId(parsedFrom, walletAddress, serviceId = null) {
    return callerIdResolverApi.resolve(parsedFrom, walletAddress, serviceId);
}

async function resolveInboundTarget(payload, serviceId = null) {
    const runtime = getServiceRuntime(serviceId);
    if (!runtime || typeof runtime.resolveInboundTarget !== "function") {
        return { route: "reject", reason: "Missing inbound target resolver" };
    }
    return runtime.resolveInboundTarget({
        serviceId: runtime.id,
        providerId: runtime.providerId,
        payload,
        helpers: getServiceHelpers(runtime),
    });
}

function stableKey(a, b) {
    return sessionStore.stableKey(a, b);
}

function findOutboundSessionForInbound(fromNumber, toNumber, excludeSessionId = null) {
    return sessionStore.findOutboundSessionForInbound(fromNumber, toNumber, parseAddress, excludeSessionId, console);
}

function linkSessionPair(aId, bId) {
    return sessionStore.linkSessionPair(aId, bId, console);
}

const inboundCallFlowApi = createInboundCallFlow({
    createSession: (...args) => createSession(...args),
    resolveInboundTarget: (...args) => resolveInboundTarget(...args),
    findOutboundSessionForInbound: (...args) => findOutboundSessionForInbound(...args),
    linkSessionPair: (...args) => linkSessionPair(...args),
    createPeerConnection: (...args) => createPeerConnection(...args),
    onDataChannelOpen: (...args) => onDataChannelOpen(...args),
    onDataChannelMessage: (...args) => onDataChannelMessage(...args),
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    getRelayCandidates: (...args) => getRelayCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    sendNotification: (...args) => sendNotification(...args),
    pendingInboundCalls,
    destroySession: (...args) => destroySession(...args),
    callRuntime,
    notiTypeCall: NOTI_TYPE_CALL,
    crypto,
    startMultiring: (...args) => multiringCoordinator.startInbound(...args),
    logger: console,
});
function relationIdentityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}
const offerFlowApi = createOfferFlow({
    sessions,
    sessionsByUser,
    stableKey: (...args) => stableKey(...args),
    createSession: (...args) => createSession(...args),
    destroySession: (...args) => destroySession(...args),
    handleHandshake: (...args) => handleHandshake(...args),
    handleInboundAnswer: (...args) => handleInboundAnswer(...args),
    handleHttpReject: (sessionId, offer) => onHttpReject(sessionId, offer),
    handleHttpCancel: (sessionId, offer) => onHttpCancel(sessionId, offer),
    handlePreSessionSignal: (offer) => multiringCoordinator.handleHttpSignal(offer),
    onExistingPairOffer: (...args) => onExistingPairOffer(...args),
    onVerifiedNotifyAnswer: (...args) => onVerifiedNotifyAnswer(...args),
    parseAddress: (...args) => parseAddress(...args),
    normalizeIdentity: (value, serviceId = null) => {
        const runtime = getServiceRuntime(serviceId);
        if (runtime && typeof runtime.normalizeIdentity === "function") {
            return runtime.normalizeIdentity({ value, serviceId: runtime.id, helpers: getServiceHelpers(runtime) });
        }
        return value;
    },
    addIceCandidates: (...args) => addIceCandidates(...args),
    callRuntime,
    createHttpError: (...args) => createHttpError(...args),
    logger: console,
});
const handshakeFlowApi = createHandshakeFlow({
    sessions,
    createPeerConnection: (...args) => createPeerConnection(...args),
    RTCSessionDescription,
    addIceCandidates: (...args) => addIceCandidates(...args),
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    isRawEmail: (...args) => isRawEmail(...args),
    emailToEnsName: (...args) => emailToEnsName(...args),
    isEthAddress: (...args) => isEthAddress(...args),
    resolveEnsToAddress: (...args) => resolveEnsToAddress(...args),
    callRuntime,
    logger: console,
});
// Retained only for its pure SDP helpers (createAnswerSdp / ensureLocalAudioTrack)
// which the poly WebRtc primitives reuse. callRuntime=null disables the legacy
// phase-2 reoffer path (poly does not use it).
const callSdpUseCases = new CallSdpUseCases({
    sessions,
    MediaStreamTrack,
    patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
    logSdp: (...args) => logSdp(...args),
    enqueueSignaling: (sessionId, label, fn) => Promise.resolve().then(fn),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    callRuntime,
    logger: console,
});
const enforceNotifySignatures =
    String(process.env.ENFORCE_NOTIFY_SIGNATURES || "true").toLowerCase() !== "false";
if (!enforceNotifySignatures) {
    console.warn("[SECURITY] /notify signature verification is DISABLED by ENFORCE_NOTIFY_SIGNATURES=false");
}
const signalingPipelineApi = createSignalingPipeline({
    onIncomingOffer: (...args) => onIncomingOffer(...args),
    handleInboundCallRequest: (...args) => handleInboundCallRequest(...args),
    authVerifier: signalingAuthVerifier,
    createHttpError: (...args) => createHttpError(...args),
    enforceNotifySignatures,
});

// ─── PolySession orchestration core — THE coordinator ───────────────────────
// PolySession is now the live coordination core for the three flows
// (secnum<->secnum, secnum->sip, sip->secnum). Legs own transport by delegating
// to the proven primitives below; ingress (HTTP /notify, data channel, SIP BYE)
// funnels through polyIngress. No legacy CallEngine/CallRuntime remains.
function isOpenDc(dc) {
    return !!dc && (dc.readyState === "open" || dc.readyState === "OPEN");
}

function endpointLabel(identity) {
    return pLabel(String(identity || "").toLowerCase());
}

function findOutboundLegSession(callerSession, legSession, endpointHint = null) {
    if (!callerSession) return null;
    const targetWallet = String(legSession?.walletAddress || "").toLowerCase();
    if (targetWallet && callerSession.outboundWebrtcLegs?.get) {
        const mapped = callerSession.outboundWebrtcLegs.get(targetWallet);
        if (mapped) {
            const wanted = endpointLabel(legSession?.toIdentity || legSession?.endpoint || endpointHint);
            const actual = endpointLabel(mapped?.toIdentity || mapped?.endpoint);
            if (!wanted || wanted === actual) return mapped;
            return null;
        }
    }
    const wanted = endpointLabel(legSession?.toIdentity || legSession?.endpoint || endpointHint);
    if (wanted && callerSession.outboundWebrtcLegs?.values) {
        for (const candidate of callerSession.outboundWebrtcLegs.values()) {
            if (endpointLabel(candidate?.toIdentity || candidate?.endpoint) === wanted) return candidate;
        }
    }
    if (callerSession.outboundWebrtc) {
        const single = callerSession.outboundWebrtc;
        if (wanted && endpointLabel(single.toIdentity || single.endpoint) === wanted) return single;
        if (!wanted && !callerSession.outboundWebrtcLegs?.size) {
            console.warn(
                `[${callerSession.sessionId}] callee leg resolution fallback: using outboundWebrtc without endpoint hint`,
                {
                    wanted,
                    endpointHint,
                    legToIdentity: legSession?.toIdentity || null,
                    legEndpoint: legSession?.endpoint || null,
                },
            );
            return single;
        }
    }
    return null;
}
// Resolve the data channel a leg should signal over: the caller leg uses its own
// session DC; a secnum<->secnum callee leg uses the outbound-leg DC attached to
// the caller session (legSession === callerSession.outboundWebrtc).
function resolveLegDataChannel(session, callerSessionId, endpoint) {
    if (session?.dataChannel) return session.dataChannel;
    const caller = callerSessionId ? sessions.get(callerSessionId) : null;
    const outbound = findOutboundLegSession(caller, session, endpoint);
    return outbound?.dataChannel || null;
}
const polyCore = createPolyCore({
    mediaGraphFactory,
    webrtcPrimitives: {
        RTCSessionDescription,
        MediaStreamTrack,
        createAnswerSdp: (...args) => createAnswerSdp(...args),
        waitForIceGathering: (...args) => waitForIceGathering(...args),
        formatIceCandidates: (...args) => formatIceCandidates(...args),
        getRelayCandidates: (...args) => getRelayCandidates(...args),
        addIceCandidates: (...args) => addIceCandidates(...args),
        embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
        patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
        ensureLocalAudioTrack: (...args) => ensureLocalAudioTrack(...args),
        narrowAudioOfferForCodecPolicy: (...args) => narrowAudioOfferForCodecPolicy(...args),
        logSdp: (...args) => logSdp(...args),
    },
    makeSignalingTransport: ({ session, callerSessionId, endpoint, getSession }) => ({
        send: (message) => {
            const liveSession = typeof getSession === "function" ? getSession() : session;
            const dc = resolveLegDataChannel(liveSession, callerSessionId, endpoint);
            if (!isOpenDc(dc)) {
                const kind = message.payload?.type || message.action || "message";
                console.error(`[poly-signaling] no open data channel for ${kind}`);
                const err = new Error(`[poly-signaling] no open data channel for ${kind}`);
                err.code = "NO_OPEN_DC";
                throw err;
            }
            dc.send(JSON.stringify(message));
        },
        isOpen: () => {
            const liveSession = typeof getSession === "function" ? getSession() : session;
            return isOpenDc(resolveLegDataChannel(liveSession, callerSessionId, endpoint));
        },
    }),
    // secnum<->secnum callee invite: reuse the proven outbound leg factory + FCM.
    outboundInvite: (...args) => outboundInvite(...args),
    sipPort: {
        openOutbound: (sessionId, { target, from, sipDirective = null } = {}) => openSipSession(sessionId, from, target, sipDirective),
        openInbound: (sessionId, { phoneNumber } = {}) => openInboundSipSession(sessionId, phoneNumber),
        close: (sessionId) => closeSipSession(sessionId),
        sendDtmf: (sessionId, digit) => { console.log(`[${sessionId}] DTMF ${digit} (no-op; out of scope)`); },
        setHold: (sessionId, held) => { console.log(`[${sessionId}] hold=${held} (no-op; out of scope)`); },
    },
    // Billing: finish the minute counter once per call when the pair tears down.
    makeTeardownHooks: ({ a, b }) => [
        () => {
            const s = a?.session || (a?.callerSessionId ? sessions.get(a.callerSessionId) : null) || (b?.session);
            if (s) minuteCounterApi.finish(s);
        },
    ],
    logger: console,
});
const polyRegistry = polyCore.registry;
const polyIngress = polyCore.ingress;
const callPairResolver = new CallPairResolver({ polyRegistry });
console.log("[poly] PolySession core is the live coordinator");


// Call routing implementation moved to modules/routing/CallRouterApi.js.


// ═════════════════════════════════════════════════════════════
// HTTP SERVER — ENTRY POINT
// ═════════════════════════════════════════════════════════════

// Inbound reuse: if the PSTN callee already has a live, connected webrtc leg that
// is paired with THIS PSTN caller (idle from a prior call between the two), there
// is nothing to FCM-wake. Seed the PSTN INVITE as the SIP caller's OFFER into the
// EXISTING poly and let reconcile ring the connected callee over its open data
// channel -- byte-for-byte the webrtc<->webrtc redial path. Same S, same P; no
// fresh session, no notification. Returns the reuse result, or null to fall back
// to the cold (FCM-wake) flow when the callee isn't reachably connected.
async function tryInboundReuse(payload, destination = null) {
    const resolvedCallee = destination?.ensName || destination?.wallet || payload.to;
    const calleeLabel = pLabel(String(resolvedCallee || "").toLowerCase());
    const callerLabel = pLabel(String(payload.from || "").replace(/^\+/, "").toLowerCase());
    if (!calleeLabel || !callerLabel) return null;

    const reuseResolution = callPairResolver.resolvePairActor(
        payload.from,
        resolvedCallee,
        resolvedCallee,
    );
    if (!reuseResolution?.poly || !reuseResolution?.ref) return null;
    const poly = reuseResolution.poly;
    const webRef = reuseResolution.ref;
    const sipRef = webRef === "a" ? "b" : "a";
    if (!poly.legs[sipRef] || poly.legs[sipRef].kind !== "sip") return null;

    const webLeg = poly.legs[webRef];
    const sipLeg = poly.legs[sipRef];

    // The webrtc leg must be the callee (this `to`) and the sip leg this `from`,
    // else the existing poly belongs to a different conversation.
    if (pLabel(String(webLeg.endpoint || "").toLowerCase()) !== calleeLabel) return null;
    if (pLabel(String(sipLeg.endpoint || "").toLowerCase()) !== callerLabel) return null;

    // Only reuse a callee whose transport is actually rungable, and only if the
    // sip leg is idle (no call already in flight on this poly).
    if (!canBeRung(webLeg.state)) return null;
    if (isActiveCall(sipLeg.state)) return null;

    const hostSession = webLeg.negotiation?.session;
    if (!hostSession || !hostSession.peerConnection) return null;

    // Reuse keeps the WebRTC transport, but SIP leg state must be fresh per call.
    if (hostSession.sipConnection || hostSession.sipPeerConnection) {
        console.log(`[${hostSession.sessionId}] inbound reuse: clearing stale SIP leg resources before openInbound`);
        try {
            await closeSipSession(hostSession.sessionId);
        } catch (err) {
            console.error(`[${hostSession.sessionId}] inbound reuse SIP cleanup failed: ${err.message}`);
            return null;
        }
    }

    // Inject the per-call SIP context onto the reused session: the callee's own
    // number to REGISTER as (openInbound pulls the suspended SBC INVITE) and the
    // inbound metadata. Direction is decided by P firing answer() on the sip leg,
    // never stored on the leg.
    hostSession.inboundCall = { fromNumber: payload.from, toNumber: payload.to, callId: payload.callId };
    if (sipLeg.negotiation) sipLeg.negotiation.phoneNumber = payload.to;

    console.log(`[${hostSession.sessionId}] inbound reuse: ringing connected callee ${calleeLabel} over existing DC (caller ${callerLabel})`);
    try {
        // Seed the PSTN INVITE as the sip caller's OFFER -> CALLING. Reconcile then
        // sees sip CALLING + webrtc CONNECTED -> ring(webrtc) over its DC; on pickup
        // -> answer(sip) (openInbound) + media bridge.
        await poly.onIngress(sipRef, makeLegEvent(LEG_EVENTS.OFFER));
    } catch (err) {
        console.error(`[${hostSession.sessionId}] inbound reuse seed failed: ${err.message}`);
        return null;
    }
    return { ok: true, sessionId: hostSession.sessionId, reused: true };
}

async function seedInboundSipToWebrtcPoly(payload, result, { reason = "inbound-fresh-call", referTransfer = false } = {}) {
    if (!result?.ok || !result.sessionId) return;
    const session = sessions.get(result.sessionId);
    if (!session) return;

    const calleeEns = result.ensName || session.toIdentity;
    const phoneNumber = session.inboundCall?.toNumber || payload.to;
    const callerNumber = session.inboundCall?.fromNumber || session.callerEns;
    try {
        await polyRegistry.destroy(polyRegistry.keyForPair(callerNumber, calleeEns), reason);
        callPairResolver.bindSessionPairRef(session, callerNumber, calleeEns);
        if (referTransfer) {
            session.referTransfer = {
                enabled: true,
                refereeEndpoint: callerNumber,
                referTarget: phoneNumber,
                referCallId: payload.callId || null,
            };
        } else {
            session.referTransfer = null;
        }
        const { poly } = polyRegistry.resolve({
            a: { endpoint: callerNumber, kind: "sip", phoneNumber, session },
            b: {
                endpoint: calleeEns,
                kind: "webrtc",
                role: "callee",
                session,
                adoptSession: true,
                destination: { ensName: calleeEns },
            },
            target: "a",
        });
        await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER));
    } catch (err) {
        console.error(`[${result.sessionId}] inbound poly seed failed: ${err.message}`);
        throw err;
    }
}

async function handleInboundCallRequest(data, serviceContext = null) {
    const payload = serviceContext?.serviceId ? { ...data, serviceId: serviceContext.serviceId } : data;
    const callType = String(payload?.callType || "").toLowerCase();
    const isReferCall = callType === "refer";
    const inboundDecision = await resolveInboundTarget(payload, payload.serviceId || null);
    if (isReferCall) {
        // REFER callbacks use /inbound-call as policy lookup only. For non-external
        // routes we pass-through at SIP layer (blind transfer semantics).
        if (inboundDecision?.route === "external-sip") {
            return inboundDecision;
        }
        if (inboundDecision?.route === "reject") {
            console.log(
                `[Inbound][REFER] policy rejected target=${payload?.to || ""} (${inboundDecision.reason || "unknown"}) -> pass-through`,
            );
        } else {
            console.log(
                `[Inbound][REFER] policy route=${inboundDecision?.route || "none"} target=${payload?.to || ""} -> pass-through`,
            );
        }
        return { ok: true, route: "refer-pass-through", callType: "refer" };
    }
    // A DIRECT route may reuse its one resolved endpoint. MULTI_RING must always
    // fan out from the current LightPBX target set; reusing one historical pair
    // would silently collapse the policy to a single callee.
    if (inboundDecision?.route === "webrtc") {
        const reused = await tryInboundReuse(payload, inboundDecision);
        if (reused) return reused;
    }
    // Cold path: the inbound flow creates the session + PC1 and FCM-invites the secnum callee.
    const result = await inboundCallFlowApi.handleInboundCallRequest(payload, inboundDecision);
    // MULTI_RING owns its host and candidate legs until a verified winner is
    // selected. The host deliberately has no callee identity yet, so the
    // single-callee PolySession path below must not run before winner handoff.
    if (result?.route === "webrtc-multiring") return result;
    if (result?.ok && result.sessionId) {
        await seedInboundSipToWebrtcPoly(payload, result, { reason: "inbound-fresh-call", referTransfer: false });
    }
    return result;
}

async function handoffMultiringWinner(claim, message) {
    const group = claim?.group;
    const candidate = claim?.candidate;
    const hostSession = group?.hostSession;
    const winnerSession = candidate?.legSession;
    if (!group || !candidate || !hostSession || !winnerSession) {
        throw new Error("MULTI_RING winner handoff is incomplete");
    }

    const calleeEns = candidate.ensName;
    const callerNumber = hostSession.inboundCall?.fromNumber || hostSession.callerEns;
    const phoneNumber = hostSession.inboundCall?.toNumber;
    const pairKey = polyRegistry.keyForPair(callerNumber, calleeEns);
    await polyRegistry.destroy(pairKey, "inbound-multiring-fresh-call");

    hostSession.toIdentity = calleeEns;
    hostSession.calleeWallet = candidate.walletKey;
    sessionsByUser.set(stableKey(callerNumber, calleeEns), hostSession.sessionId);
    callPairResolver.bindSessionPairRef(hostSession, callerNumber, calleeEns);
    const { poly } = polyRegistry.resolve({
        a: {
            endpoint: callerNumber,
            kind: "sip",
            phoneNumber,
            session: hostSession,
        },
        b: {
            endpoint: calleeEns,
            kind: "webrtc",
            role: "caller",
            session: winnerSession,
        },
        target: "b",
    });

    // The candidate's authenticated HTTP answer already negotiated its media and
    // its DC is the channel carrying this verified pickup. Adopt that ready
    // transport, seed the suspended PSTN INVITE so normal policy places the
    // pre-negotiated winner in RINGING, then deliver the pickup. Reconcile
    // consequently calls SIP openInbound exactly once and bridges media.
    await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    if (group.finished) throw new Error("MULTI_RING winner transport closed during handoff");
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER));
    if (group.finished) throw new Error("MULTI_RING winner transport closed while ringing");
    const pickupPayload = message.msgType === "signaling" ? (message.payload || {}) : message;
    await poly.onIngress("b", polyIngress.toLegEvent("answer", pickupPayload, {
        channelRole: "callee-webrtc",
        multiring: true,
    }));
    if (group.finished) throw new Error("MULTI_RING winner transport closed during pickup");
    multiringCoordinator.completeHandoff(group);
}

/**
 * Signaling orchestration layer.
 *
 * Route handlers should stay short and readable:
 * 1) build signaling context
 * 2) define signaling plan
 * 3) start signaling plan
 *
 * Heavy logic (ICE/SIP/media/blockchain) remains in existing handlers.
 */
function buildSignalingContextFromNotify(payload) {
    return signalingPipelineApi.buildSignalingContextFromNotify(payload);
}

function buildSignalingContextFromInbound(payload) {
    return signalingPipelineApi.buildSignalingContextFromInbound(payload);
}

async function executeSignalingPipeline(context) {
    return signalingPipelineApi.executeSignalingPipeline(context);
}

const tlsOptions = {
    cert: fs.readFileSync(`${config.tlsCertPath}/fullchain.pem`),
    key: fs.readFileSync(`${config.tlsCertPath}/privkey.pem`),
};
const httpServers = [];
for (const serviceRuntime of activeServiceRuntimes) {
    const configuredDomains = Array.isArray(serviceRuntime.serviceConstants?.domains)
        ? serviceRuntime.serviceConstants.domains.join(",")
        : "";
    console.log(
        `[Startup] service=${serviceRuntime.id} provider=${serviceRuntime.providerId} deployEnv=${deployEnv} ` +
        `domain=${config.domain || ""} notifyPort=${serviceRuntime.notifyPort} ` +
        `callbackPort=${serviceRuntime.callbackPort} domains=${configuredDomains}`,
    );
    const handlers = createHandlers({
        buildSignalingContextFromNotify,
        buildSignalingContextFromInbound,
        executeSignalingPipeline,
        serviceRuntime,
        readBody,
        sendJsonError,
        logger: console,
    });
    const serviceServers = createHttpServers({
        tlsOptions,
        httpPort: serviceRuntime.notifyPort,
        internalHttpPort: serviceRuntime.callbackPort,
        internalBindIp: INTERNAL_BIND_IP,
        internalProtocol: INTERNAL_CALLBACK_PROTOCOL,
        handlers,
        sendJsonError,
        logger: console,
    });
    serviceServers.startPublicServer();
    serviceServers.startInternalServer();
    httpServers.push({ serviceId: serviceRuntime.id, servers: serviceServers });
}

// ════════════════════════════════════════════════════════════
// LAYER 3 — REACT AT RUNTIME
// Entry points invoked after Layer 2: HTTP (/notify, /inbound-call), SIP state,
// WebRTC callbacks, and data-channel messages. (Still `function` declarations here;
// they run only when those events fire.)
// ════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════
// INCOMING OFFER
// ═════════════════════════════════════════════════════════════

/**
 * Called when an initial WebRTC offer arrives from the Android client.
 * This is the entry point — the offer arrives as an HTTP POST to /notify.
 *
 * @param {object} offer - The full offer payload from the Android client:
 *   { type: "offer", from: "alice.arnacon.global", to: "numberpool.global",
 *     sessionId: "...", sdp: "<DC-only>", candidates: [...], isCall: true, callNonce: "..." }
 */
async function onIncomingOffer(offer, serviceContext = null) {
    const payload = serviceContext?.serviceId ? { ...offer, serviceId: serviceContext.serviceId } : offer;
    return offerFlowApi.onIncomingOffer(payload);
}


// ═════════════════════════════════════════════════════════════
// PHASE 1 — DATA CHANNEL HANDSHAKE (via FCM)
// ═════════════════════════════════════════════════════════════

/**
 * Establishes a data-channel-only WebRTC PeerConnection with the Android client.
 * Creates PC1, sets the remote offer SDP, generates an answer SDP,
 * and sends it back to the client via FCM.
 */
async function handleHandshake(sessionId, fromEns, toIdentity, offerSdp, candidates, callNonce) {
    // HTTP initial offer: bring up PC1 (DC-only) + answer over FCM. PolySession is
    // created later, at the data-channel RING, once routing is known.
    return handshakeFlowApi.handleHandshake(sessionId, fromEns, toIdentity, offerSdp, candidates, callNonce);
}

/**
 * Handles the callee's SDP answer for an inbound SBC call where the gateway is the offerer.
 */
async function handleInboundAnswer(sessionId, answerSdp, candidates) {
    return handshakeFlowApi.handleInboundAnswer(sessionId, answerSdp, candidates);
}

/**
 * Creates PC1 — the client-facing WebRTC PeerConnection.
 */
function createPeerConnection(...args) {
    return peerConnectionApi.createPeerConnection(...args);
}

// ─── PolySession ingress helpers (manager seam) ─────────────────────────────

function pLabel(identity) {
    return identityLabel(identity);
}

function polyForSession(session) {
    return callPairResolver.polyForSession(session);
}

function pairResolutionForOffer(offer) {
    if (!offer?.from || !offer?.to) return null;
    return callPairResolver.resolvePairActor(offer.from, offer.to, offer.from);
}

async function onExistingPairOffer({ sessionId, offer, session, pairKey } = {}) {
    const resolved = pairResolutionForOffer(offer);
    if (!resolved?.poly || !resolved?.ref) {
        console.warn(
            `[${sessionId || "no-session"}] existing-pair offer unresolved for ${pairKey || "unknown-pair"}`,
            { from: offer?.from || null, to: offer?.to || null },
        );
        return { handled: false };
    }
    try {
        await resolved.poly.onIngress(
            resolved.ref,
            polyIngress.toLegEvent(
                "offer",
                {
                    sdp: offer?.sdp,
                    candidates: offer?.candidates || [],
                    iceRestart: offer?.iceRestart === true,
                    offerUfrag: offer?.offerUfrag || null,
                },
                { forceOffer: true },
            ),
        );
    } catch (err) {
        console.error(
            `[${sessionId || "no-session"}] existing-pair offer ingress failed for ${pairKey || "unknown-pair"}: ${err.message}`,
        );
        return { handled: false };
    }
    return {
        handled: true,
        responseBody: {
            ok: true,
            sessionId: sessionId || session?.sessionId || null,
            type: "offer",
            reusedPairContext: true,
        },
    };
}

function resolveCalleeLegSession(session, meta = {}) {
    if (!session) return null;
    const walletKey = String(meta.walletAddress || "").toLowerCase();
    if (walletKey && session.outboundWebrtcLegs?.get) {
        const mapped = session.outboundWebrtcLegs.get(walletKey);
        if (mapped) return mapped;
        console.warn(
            `[${session.sessionId}] callee leg wallet miss`,
            {
                walletKey,
                calleeIdentity: meta.calleeIdentity || null,
                signalingSessionId: meta.signalingSessionId || null,
                outboundLegCount: session.outboundWebrtcLegs.size,
            },
        );
    }
    const wanted = endpointLabel(meta.calleeIdentity);
    if (wanted && session.outboundWebrtcLegs?.values) {
        for (const candidate of session.outboundWebrtcLegs.values()) {
            if (endpointLabel(candidate?.toIdentity || candidate?.endpoint) === wanted) {
                return candidate;
            }
        }
        console.warn(
            `[${session.sessionId}] callee leg endpoint miss`,
            {
                wanted,
                walletKey: walletKey || null,
                signalingSessionId: meta.signalingSessionId || null,
                outboundLegCount: session.outboundWebrtcLegs.size,
            },
        );
    }
    if (session.outboundWebrtc) {
        console.warn(
            `[${session.sessionId}] callee leg fallback: using outboundWebrtc`,
            {
                wanted: wanted || null,
                walletKey: walletKey || null,
                fallbackToIdentity: session.outboundWebrtc.toIdentity || null,
                fallbackSignalingSessionId: session.outboundWebrtc.signalingSessionId || null,
                signalingSessionId: meta.signalingSessionId || null,
            },
        );
    }
    return session.outboundWebrtc || null;
}

function resolveSessionByPeerConnection(session, pc) {
    if (!session || !pc) return null;
    if (session.peerConnection === pc) {
        return { channelRole: "caller-webrtc", sessionRef: session, meta: {} };
    }
    if (session.outboundWebrtc?.peerConnection === pc) {
        return {
            channelRole: "callee-webrtc",
            sessionRef: session.outboundWebrtc,
            meta: {
                walletAddress: session.outboundWebrtc.walletAddress,
                calleeIdentity: session.outboundWebrtc.toIdentity,
                signalingSessionId: session.outboundWebrtc.signalingSessionId,
            },
        };
    }
    if (session.outboundWebrtcLegs?.values) {
        for (const legSession of session.outboundWebrtcLegs.values()) {
            if (legSession?.peerConnection === pc) {
                return {
                    channelRole: "callee-webrtc",
                    sessionRef: legSession,
                    meta: {
                        walletAddress: legSession.walletAddress,
                        calleeIdentity: legSession.toIdentity,
                        signalingSessionId: legSession.signalingSessionId,
                    },
                };
            }
        }
    }
    return null;
}

// Which leg ref a webrtc message on `session` targets. callee-webrtc role => the
// outbound callee leg (its negotiation.session === session.outboundWebrtc);
// otherwise the primary PC1 leg (negotiation.session === session).
function polyWebrtcRef(poly, session, channelRole, meta = {}) {
    const isCallee = channelRole === "callee-webrtc";
    const calleeLegSession = isCallee ? resolveCalleeLegSession(session, meta) : null;
    for (const ref of ["a", "b"]) {
        const leg = poly.legs[ref];
        if (!leg || leg.kind !== "webrtc") continue;
        const ns = leg.negotiation?.session;
        if (isCallee) {
            if (ns && calleeLegSession && ns === calleeLegSession) return ref;
        } else if (ns && ns === session) {
            return ref;
        }
    }
    return null;
}

// Strict: does this poly actually own `session` (live transport), no fallback?
// Used to tell a brand-new ring on a fresh transport from an in-call message on
// the poly's own transport, and to stop a stale transport's close from tearing
// down a freshly rebuilt poly.
function polyOwnsSession(poly, session, channelRole, meta = {}) {
    if (!poly || !session) return false;
    const isCallee = channelRole === "callee-webrtc";
    const calleeLegSession = isCallee ? resolveCalleeLegSession(session, meta) : null;
    for (const ref of ["a", "b"]) {
        const leg = poly.legs[ref];
        if (!leg || leg.kind !== "webrtc") continue;
        const ns = leg.negotiation?.session;
        if (isCallee ? ns === calleeLegSession : ns === session) return true;
    }
    return false;
}

function polySipRef(poly) {
    if (poly.legs.a.kind === "sip") return "a";
    if (poly.legs.b.kind === "sip") return "b";
    return null;
}

function polyRefByEndpoint(poly, endpoint) {
    const want = pLabel(String(endpoint || "").toLowerCase());
    for (const ref of ["a", "b"]) {
        if (pLabel(String(poly.legs[ref].endpoint || "").toLowerCase()) === want) return ref;
    }
    return null;
}

// Temporary concurrency policy:
// - SIP legs are multi-call.
// - Non-SIP legs are single-call.
function endpointAllowsMultiCall(leg) {
    return leg?.kind === "sip";
}

// Experimental gate for switch behavior:
//  - false => trust client ordering fully (no server-side forced switch)
//  - true  => enforce single-call switch (non-SIP) before pickup answer
const ENABLE_SINGLE_CALL_SWITCH_GUARD = String(process.env.POLY_SINGLE_CALL_SWITCH_GUARD || "").toLowerCase() === "1";

function isPickupAnswerState(state) {
    return (
        state === LEG_STATES.CONNECTED
        || state === LEG_STATES.CALLING
        || state === LEG_STATES.RINGING
        || state === LEG_STATES.ANSWERING
    );
}

function isPolyIdleForSwitch(poly) {
    if (!poly?.legs) return true;
    for (const ref of ["a", "b"]) {
        const state = poly.legs[ref]?.state;
        if (!state) continue;
        if (state === LEG_STATES.END_REQUESTED) return false;
        if (isActiveCall(state)) return false;
    }
    return true;
}

async function waitForPolyIdle(poly, timeoutMs = 7000, intervalMs = 50) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (isPolyIdleForSwitch(poly)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return isPolyIdleForSwitch(poly);
}

async function enforceSingleCallBeforeAnswer(poly, ref) {
    if (!ENABLE_SINGLE_CALL_SWITCH_GUARD) return;
    if (!poly || !ref) return;
    const leg = poly.legs?.[ref];
    if (!leg) return;
    if (endpointAllowsMultiCall(leg)) return;
    // Important: do NOT evict on session-establishment answers (CONNECTING).
    // Only evict when this answer is a pickup path that leads to in-call.
    if (!isPickupAnswerState(leg.state)) return;

    const endpoint = leg.endpoint;
    if (!endpoint || typeof polyRegistry.listByEndpoint !== "function") return;
    const siblings = polyRegistry.listByEndpoint(endpoint);
    for (const candidate of siblings) {
        if (!candidate || candidate === poly) continue;
        const candidateRef = polyRefByEndpoint(candidate, endpoint);
        if (!candidateRef) continue;
        const candidateLeg = candidate.legs?.[candidateRef];
        if (!candidateLeg) continue;
        if (isActiveCall(candidateLeg.state)) {
            console.warn(
                `[${poly.id}] single-call guard: ending overlapping call ${candidate.id} for endpoint ${endpoint}`,
                {
                    activeState: candidateLeg.state,
                    endpoint,
                    activePoly: candidate.id,
                    incomingPoly: poly.id,
                },
            );
            try {
                await candidate.onIngress(candidateRef, makeLegEvent(LEG_EVENTS.END, { reason: "single-call-policy" }));
                const idle = await waitForPolyIdle(candidate);
                if (!idle) {
                    console.warn(
                        `[${poly.id}] single-call guard timeout waiting for ${candidate.id} to go idle`,
                        { endpoint, activePoly: candidate.id, incomingPoly: poly.id },
                    );
                }
            } catch (err) {
                console.error(
                    `[${poly.id}] single-call guard failed to end ${candidate.id} for ${endpoint}: ${err.message}`,
                );
            }
        }
    }
}

// Resolve routing at the audio RING and create the PolySession for the pair.
// Prepaid minute gate for an SBC/SIP outbound. Resolves the per-service budget
// and asserts the caller may still start a call. Returns { allowed, settings,
// identity }: allowed=false means the monthly cap is exhausted (the caller has
// already been told to end). No active policy => allowed with settings=null.
function checkSbcMinuteBudget({ session, callerSessionId, parsedFrom, serviceId }) {
    const settings = minuteCounterPolicy.getSettings(serviceId);
    const identity = minuteCounterPolicy.getIdentity(parsedFrom, session);
    if (!minuteCounterApi || !settings?.limitSeconds) return { allowed: true, settings: null, identity };
    try {
        minuteCounterApi.assertCanStart({
            serviceId: settings.serviceId,
            identity,
            limitSeconds: settings.limitSeconds,
        });
    } catch (err) {
        console.log(`[${callerSessionId}] minute limit reached for ${identity}: ${err.message}`);
        sendEndCallSignal(callerSessionId, "minute-limit");
        return { allowed: false, settings, identity };
    }
    return { allowed: true, settings, identity };
}

// Service-side prepaid per-call cutoff. The minute counter owns the budget, so
// we enforce the low-balance cap here instead of stamping a "Limit" SIP header
// for the SIP proxy to enforce (SIPhon no longer carries that header). At answer
// we arm a timer that BYEs both legs when the caller's remaining balance for THIS
// call runs out, and we bill via the start/finish hooks. No-op without policy.
function applySbcMinuteCap({ session, callerSessionId, poly, settings, identity }) {
    if (!minuteCounterApi || !settings?.limitSeconds) return;

    const clearCutoff = () => {
        if (session._minuteCutoffTimer) {
            clearTimeout(session._minuteCutoffTimer);
            session._minuteCutoffTimer = null;
        }
    };

    // Bill only the answered conversation: PolySession fires onCallStart when both
    // legs reach IN_CALL and onCallEnd when they leave it -- so the counter starts
    // at answer and stops on ANY end (hangup either side, failure, transport drop),
    // independent of poly disposal/reuse. finish() is idempotent.
    poly.setCallActivityHooks({
        onCallStart: () => {
            minuteCounterApi.start(session, {
                serviceId: settings.serviceId,
                identity,
                limitSeconds: settings.limitSeconds,
            });
            // Remaining balance is measured at answer. Only a low-balance caller
            // is capped per-call (mirrors the previous <300s Limit-header gate);
            // higher balances are bounded across calls by assertCanStart().
            const usedSeconds = minuteCounterApi.getUsedSeconds({
                serviceId: settings.serviceId,
                identity,
            });
            const remainingSeconds = settings.limitSeconds - usedSeconds;
            clearCutoff();
            if (remainingSeconds > 0 && remainingSeconds < 300) {
                console.log(`[${callerSessionId}] low balance: capping call at ${remainingSeconds}s for ${identity}`);
                session._minuteCutoffTimer = setTimeout(() => {
                    session._minuteCutoffTimer = null;
                    // Prepaid is the SIP/SBC leg's concern: the service decides this
                    // leg is out of balance and ends the SIP (S) leg of the poly.
                    // The S leg sets itself to ENDING (BYEs the SBC) and the poly
                    // propagates the teardown to the caller leg.
                    const sipRef = polySipRef(poly);
                    if (!sipRef) {
                        console.warn(`[${callerSessionId}] minute cap reached but poly has no SIP leg -- skipping`);
                        return;
                    }
                    console.log(`[${callerSessionId}] minute cap reached (${remainingSeconds}s) -- ending SIP leg for ${identity}`);
                    poly.onIngress(sipRef, makeLegEvent(LEG_EVENTS.END)).catch((err) => {
                        console.error(`[${callerSessionId}] minute-cap hangup failed: ${err.message}`);
                    });
                }, remainingSeconds * 1000);
            }
        },
        onCallEnd: () => {
            clearCutoff();
            minuteCounterApi.finish(session);
        },
    });
}

async function onDcRing(callerSessionId, payload) {
    const session = sessions.get(callerSessionId);
    if (!session || !session.peerConnection) return;
    session.lastRingOfferPayload = payload;
    session.activeCallId = normalizePositiveCallId(payload?.callId) || session.activeCallId;
    const serviceId = session.serviceId || null;
    const to = payload.to || session.toIdentity;
    const parsedTo = parseAddress(to, serviceId);
    const parsedFrom = parseAddress(session.callerEns, serviceId);
    const destination = await resolveDestination(parsedTo, parsedFrom, serviceId);

    if (!destination || destination.route === "reject") {
        sendEndCallSignal(callerSessionId, "reject-route");
        return;
    }

    session.mediaCodecPolicy = routeToCodecPolicy(destination, { isInbound: false }) || null;

    const a = { endpoint: session.callerEns, kind: "webrtc", session };
    let b;
    // Minute metering is SBC/PSTN-outbound only; resolved in the sip branch below.
    let minuteCounterSettings = null;
    let minuteCounterIdentity = null;
    if (destination.route === "webrtc") {
        b = {
            endpoint: destination.ensName || destination.wallet,
            kind: "webrtc",
            role: "callee",
            destination,
            callerSessionId,
        };
    } else {
        // sip / sbc: the SIP leg shares the caller's session (sipPeerConnection
        // is attached on openOutbound). Resolve the SBC caller-id + directive
        // (P-Asserted-Identity / privacy / headers) exactly like the legacy
        // routeCall path so Kamailio accepts the INVITE.
        let callerIdResult = null;
        try {
            callerIdResult = await resolveCallerId(parsedFrom, session.walletAddress, serviceId);
        } catch (err) {
            console.warn(`[${callerSessionId}] callerId resolve failed: ${err.message}`);
        }
        const sipTo = destination.number || destination.target || destination.to || session.toIdentity;
        session.sipFrom = callerIdResult?.callerId || parsedFrom?.full || session.callerEns;
        session.sipDirective = destination.sipDirective || {
            target: destination.target || null,
            identity: callerIdResult?.identity || null,
            privacy: callerIdResult?.privacy || null,
            callerId: callerIdResult?.callerId || null,
            privateId: callerIdResult?.privateId || null,
            headers: {
                ...(callerIdResult?.headers || {}),
                "X-Arnacon-Service-Id": serviceId,
            },
        };
        b = {
            endpoint: sipTo,
            kind: "sip",
            session,
        };

        // Minute metering for SBC/PSTN outbound. The poly cutover orphaned the
        // legacy SbcRouteStrategy where start()/assertCanStart() lived, so gate on
        // the per-service monthly cap here at SIP-leg origination. The cap header +
        // billing hooks are applied below once the poly exists.
        const budget = checkSbcMinuteBudget({ session, callerSessionId, parsedFrom, serviceId });
        if (!budget.allowed) return;
        minuteCounterSettings = budget.settings;
        minuteCounterIdentity = budget.identity;
    }

    callPairResolver.bindSessionPairRef(session, a.endpoint, b.endpoint);
    const { poly } = polyRegistry.resolve({ a, b, target: "a" });
    if (b.kind === "sip") {
        applySbcMinuteCap({ session, callerSessionId, poly, settings: minuteCounterSettings, identity: minuteCounterIdentity });
    }
    // Caller transport is already up (HTTP handshake). The SIP leg has no transport
    // to negotiate (openOutbound happens on ring), so mark it usable too. A webrtc
    // callee, by contrast, starts disconnected: reconcile will connect() it (FCM
    // session offer) and only ring() it once its data channel opens.
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    if (b.kind === "sip") {
        await poly.onIngress("b", makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN));
    }
    // Deliver the caller's audio offer -> caller leg goes CALLING and reconcile
    // drives the peer (connect -> ring -> answer).
    await poly.onIngress("a", makeLegEvent(LEG_EVENTS.OFFER, payload));
}

/**
 * Called when a data channel opens. Marks the matching webrtc leg's transport
 * open if a PolySession already exists for the pair (otherwise the RING that
 * follows will create it).
 */
function onDataChannelOpen(sessionId, meta = {}) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (multiringCoordinator.handleDataChannelOpen(sessionId, meta).handled) return;
    const poly = polyForSession(session);
    if (!poly) return;
    // The callee's outbound DC reuses the caller's sessionId, so the channelRole
    // (set by WebRtcOutboundLegFactory) is what tells us which leg just opened.
    const channelRole = meta.channelRole || "caller-webrtc";
    // Only mark transport-open if this poly owns the channel. A new transport whose
    // DC opens before its RING resolves to a stale poly by identity; the ring will
    // rebuild that poly fresh, so touching its frozen legs here would be wrong.
    if (!polyOwnsSession(poly, session, channelRole, meta)) return;
    const ref = polyWebrtcRef(poly, session, channelRole, meta);
    if (!ref) {
        console.error(`[${sessionId}] poly transport-open (${channelRole}) skipped: no owned webrtc leg`);
        return;
    }
    poly.onIngress(ref, makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN)).catch((err) => {
        console.error(`[${sessionId}] poly transport-open (${channelRole}) failed: ${err.message}`);
    });
}

function onPeerConnected(sessionId) {
    // No pending-bridge bookkeeping anymore — pairing is handled by the registry.
}

function isRecoverableOfferIngressError(err) {
    const msg = String(err?.message || "");
    return (
        /Transceiver with mid=\d+ not found/i.test(msg) ||
        /m[-\s]?line not found/i.test(msg) ||
        /iceParams/i.test(msg) ||
        /media section/i.test(msg) ||
        /reading 'kind'/i.test(msg)
    );
}

/**
 * Data channel ingress -> normalized leg events for the owning PolySession.
 * Replaces SignalingMessageRouter phase-gating (leg states gate instead).
 */
function onDataChannelMessage(sessionId, rawMessage, meta = {}) {
    let msg;
    try {
        msg = JSON.parse(rawMessage);
    } catch (err) {
        console.error(`[${sessionId}] Failed to parse DC message: ${err.message}`);
        return;
    }
    const session = sessions.get(sessionId);
    if (!session) return;
    const channelRole = meta.channelRole || "caller-webrtc";

    const multiring = multiringCoordinator.handleDataChannelMessage(sessionId, msg, meta);
    if (multiring.handled) {
        if (multiring.won && !multiring.duplicate) {
            handoffMultiringWinner(multiring, msg).catch(async (err) => {
                console.error("[multiring] winner handoff failed", {
                    call: multiring.group?.id || null,
                    target: multiring.candidate?.ensName || null,
                    error: err.message,
                    routingGroupId: multiring.group?.metadataGroupId || null,
                });
                const key = multiring.group?.hostSession && multiring.candidate
                    ? polyRegistry.keyForPair(
                        multiring.group.hostSession.inboundCall?.fromNumber,
                        multiring.candidate.ensName,
                    )
                    : null;
                if (key) {
                    try { await polyRegistry.destroy(key, "multiring-handoff-failed"); } catch (_) {}
                }
                multiringCoordinator.failHandoff(multiring.group);
            });
        }
        return;
    }

    if (msg.msgType === "data") {
        messagingFlowApi.handleDataMessage(sessionId, msg, session.phase).catch((err) => {
            console.error(`[${sessionId}] DC-DATA forward failed: ${err.message}`);
        });
        return;
    }

    // An active (non-inactive) signaling offer is a RING. It is a brand-new call
    // when no poly owns this transport: either there is no poly for the pair, or a
    // stale poly lingers from a prior call (left CONNECTED, bound to a dead
    // transport). In the stale case we destroy it so the pair is rebuilt from
    // scratch -- fresh SessionLegs at DISCONNECTED with correct roles -- instead of
    // reusing frozen roles + dead data-channel refs. We never reset legs in place.
    const isActiveOffer =
        msg.msgType === "signaling" &&
        msg.payload?.type === "offer" &&
        !isInactiveOffer(msg.payload.sdp);
    if (isActiveOffer) {
        const existing = polyForSession(session);
        // A reused poly is fine here: the caller keeps its live transport and the
        // callee leg, if its own transport died, is already DISCONNECTED (marked the
        // moment consent failed). Reconcile then re-CONNECTs that leg (notification/
        // VoIP wake) before ringing -- we do NOT rebuild the whole poly. We only
        // rebuild when no poly owns this transport (brand-new call or stale poly).
        if (!existing || !polyOwnsSession(existing, session, channelRole)) {
            (async () => {
                if (existing) {
                    const existingKey = callPairResolver.keyFromPoly(existing);
                    await polyRegistry.destroy(
                        existingKey,
                        "new-ring-reset",
                    );
                }
                await onDcRing(sessionId, msg.payload);
            })().catch((err) => {
                console.error(`[${sessionId}] ring routing failed: ${err.message}`);
                sendEndCallSignal(sessionId, "ring-failed");
            });
            return;
        }
        // Reused poly: the caller is redialing over its live transport, so onDcRing
        // (and its minute gate) is bypassed. Re-run the prepaid gate here for SBC/SIP
        // redials so an out-of-balance caller is blocked and the per-call cutoff
        // timer is re-armed every call -- not just the first. Otherwise a stale cap
        // (or none) from a prior call would carry over on the reused poly.
        const sipRef = polySipRef(existing);
        if (sipRef) {
            const serviceId = session.serviceId || null;
            const parsedFrom = parseAddress(session.callerEns, serviceId);
            const budget = checkSbcMinuteBudget({ session, callerSessionId: sessionId, parsedFrom, serviceId });
            if (!budget.allowed) return;
            applySbcMinuteCap({
                session,
                callerSessionId: sessionId,
                poly: existing,
                settings: budget.settings,
                identity: budget.identity,
            });
        }
    }

    const poly = polyForSession(session);
    if (!poly) {
        console.log(`[${sessionId}] DC message with no PolySession (msgType=${msg.msgType} action=${msg.action || msg.payload?.type})`);
        return;
    }

    let action;
    let payload;
    if (msg.msgType === "signaling") {
        action = msg.action === "end-call" ? "end-call" : msg.payload?.type;
        payload = { ...(msg.payload || {}) };
        if (payload.callId === undefined && msg.callId !== undefined) payload.callId = msg.callId;
        if (!payload.sessionId && msg.sessionId) payload.sessionId = msg.sessionId;
        if (!payload.from && msg.from) payload.from = msg.from;
        if (!payload.to && msg.to) payload.to = msg.to;
    } else if (msg.msgType === "call") {
        if (msg.action === "hold") { action = "hold"; payload = { enabled: true }; }
        else if (msg.action === "unhold") { action = "hold"; payload = { enabled: false }; }
        else { action = msg.action; payload = msg; }
    }
    if (!action) return;

    const event = polyIngress.toLegEvent(action, payload, { channelRole });
    if (!event) return;
    const ref = polyWebrtcRef(poly, session, channelRole, meta);
    if (!ref) {
        console.error(`[${sessionId}] poly ingress (${action}) skipped: no owned webrtc leg`);
        return;
    }
    const runIngress = async () => {
        if (action === "answer") {
            await enforceSingleCallBeforeAnswer(poly, ref);
        }
        await poly.onIngress(ref, event);
    };
    runIngress().catch((err) => {
        if (action === "offer" && isRecoverableOfferIngressError(err) && !payload.__polyIngressRetriedOnce) {
            payload.__polyIngressRetriedOnce = true;
            // Keep the current poly/session/PC alive and retry ingress in place.
            // This mirrors client-side reuse semantics after decline/end flows.
            const latestSession = sessions.get(sessionId);
            const latestPoly = latestSession ? polyForSession(latestSession) : null;
            if (!latestSession || !latestPoly) {
                console.error(`[${sessionId}] poly ingress (${action}) retry skipped: no active session/poly`);
                return;
            }
            const retryRef = polyWebrtcRef(latestPoly, latestSession, channelRole, meta);
            if (!retryRef) {
                console.error(`[${sessionId}] poly ingress (${action}) retry skipped: no owned retry leg`);
                return;
            }
            const retryEvent = polyIngress.toLegEvent(action, payload, { channelRole });
            if (!retryEvent) {
                console.error(`[${sessionId}] poly ingress (${action}) retry skipped: no retry event`);
                return;
            }
            latestPoly.onIngress(retryRef, retryEvent).catch((retryErr) => {
                console.error(`[${sessionId}] poly ingress (${action}) retry failed: ${retryErr.message}`);
            });
            return;
        }
        console.error(`[${sessionId}] poly ingress (${action}) failed: ${err.message}`);
    });
}

// HTTP /notify "answer" (callee picked up: secnum<->secnum leg or inbound callee).
async function onVerifiedNotifyAnswer(sessionId, offer, session) {
    const resolved = pairResolutionForOffer(offer);
    if (!resolved?.poly || !resolved?.ref) return { handled: false };
    await enforceSingleCallBeforeAnswer(resolved.poly, resolved.ref);
    try {
        await resolved.poly.onIngress(
            resolved.ref,
            polyIngress.toLegEvent("answer", { sdp: offer.sdp, candidates: offer.candidates || [] }, {}),
        );
    } catch (err) {
        console.error(`[${sessionId}] poly http-answer failed: ${err.message}`);
        return { handled: false };
    }
    return { handled: true };
}

// HTTP /notify "reject".
async function onHttpReject(sessionId, offer) {
    const resolved = pairResolutionForOffer(offer);
    if (!resolved?.poly || !resolved?.ref) {
        const err = "unresolved-pair-for-http-reject";
        console.error(`[${sessionId || "no-session"}] ${err}`);
        return { ok: false, error: err, type: "reject", sessionId };
    }
    try {
        await resolved.poly.onIngress(resolved.ref, polyIngress.toLegEvent("reject", {}, {}));
    } catch (err) {
        console.error(`[${sessionId}] poly http-reject failed: ${err.message}`);
        return { ok: false, error: "poly-http-reject-failed", type: "reject", sessionId };
    }
    return { ok: true, type: "reject", sessionId };
}

// HTTP /notify "cancel".
async function onHttpCancel(sessionId, offer) {
    const resolved = pairResolutionForOffer(offer);
    if (!resolved?.poly || !resolved?.ref) {
        const err = "unresolved-pair-for-http-cancel";
        console.error(`[${sessionId || "no-session"}] ${err}`);
        return { ok: false, error: err, type: "cancel", sessionId };
    }
    try {
        await resolved.poly.onIngress(resolved.ref, polyIngress.toLegEvent("cancel", {}, {}));
    } catch (err) {
        console.error(`[${sessionId}] poly http-cancel failed: ${err.message}`);
        return { ok: false, error: "poly-http-cancel-failed", type: "cancel", sessionId };
    }
    return { ok: true, type: "cancel", sessionId };
}

// secnum<->secnum callee invite: reuse the proven outbound leg factory + FCM.
// dcOnly: the FCM session offer carries only the data channel (audio is added
// later by the poly ring), mirroring the caller's DC-only HTTP handshake.
async function outboundInvite({ callerSessionId, destination }) {
    const { legSession, calleeEns, callerEns, callPayload } =
        await outboundLegFactory.create(callerSessionId, destination, { kind: "webrtc", dcOnly: true });
    legSession.lastNotificationResult = await sendNotification(callerEns, calleeEns, callPayload, NOTI_TYPE_CALL);
    return legSession;
}

// SIP runtime remote BYE -> teardown via the SIP leg.
function onSipCallEvent(sessionId, event) {
    const session = sessions.get(sessionId);
    const poly = polyForSession(session);
    if (!poly) return;
    const ref = polySipRef(poly);
    if (!ref) return;
    return poly.onIngress(ref, polyIngress.toLegEvent("bye", {}, {})).catch((err) => {
        console.error(`[${sessionId}] poly remote-bye failed: ${err.message}`);
    });
}

function isSessionInCall(session) {
    const poly = polyForSession(session);
    if (!poly) return false;
    return poly.legs.a.state === LEG_STATES.IN_CALL || poly.legs.b.state === LEG_STATES.IN_CALL;
}

// Terminal PC state -> tear the pair down and clean up.
async function onTransportClosed(sessionId, event = {}) {
    if (multiringCoordinator.handleTransportClosed(event).handled) return;
    const session = sessions.get(sessionId);
    const transportBinding = resolveSessionByPeerConnection(session, event.pc);
    // A 2nd call reuses the same sessionId on a fresh transport. The old call's PC
    // can fire `closed` after the new session is already bound under this id. If the
    // closing transport is no longer the session's current caller/callee PC, it is
    // superseded -> ignore it entirely so we don't tear down the fresh session.
    if (session && event.pc && !transportBinding) {
        return;
    }
    // A callee leg's PC (created destroyOnTerminalState:false) that drops while the
    // session lives must NOT destroy the session -- it only means that endpoint's
    // transport is gone. Mark the callee leg's transport closed so it settles to
    // DISCONNECTED; reconcile then re-invites (notifies/VoIP) it on the next call
    // instead of ringing a dead data channel. Mid-call, the callee leg -> FAILED
    // also ends the caller via reconcile, so the drop still reaches the peer.
    if (event.destroyOnTerminalState === false) {
        const calleePoly = polyForSession(session);
        if (calleePoly && polyOwnsSession(calleePoly, session, "callee-webrtc", transportBinding?.meta)) {
            const ref = polyWebrtcRef(calleePoly, session, "callee-webrtc", transportBinding?.meta);
            if (!ref) return;
            try {
                await calleePoly.onIngress(ref, makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
            } catch (err) {
                console.error(`[${sessionId}] poly callee transport-close failed: ${err.message}`);
            }
        }
        return;
    }
    const poly = polyForSession(session);
    // Only tear the poly down if it actually owns this closing transport. A stale
    // PC closing after a new-ring rebuild resolves (by identity) to the freshly
    // built poly for the same pair -- which we must NOT kill. Just clean its
    // SessionStore entry in that case.
    const channelRole = transportBinding?.channelRole || "caller-webrtc";
    if (poly && polyOwnsSession(poly, session, channelRole, transportBinding?.meta)) {
        const ref = polyWebrtcRef(poly, session, channelRole, transportBinding?.meta);
        if (!ref) {
            destroySession(sessionId, event.notify === true);
            return;
        }
        try {
            await poly.onIngress(ref, makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
        } catch (err) {
            console.error(`[${sessionId}] poly transport-close failed: ${err.message}`);
        }
        try {
            const key = callPairResolver.keyFromPoly(poly);
            await polyRegistry.destroy(key, event.reason || "transport-closed");
        } catch (_) {}
    }
    destroySession(sessionId, event.notify === true);
}

async function openSipSession(sessionId, callerEns, calleeIdentity, sipDirective = null) {
    return sipGateway.openOutbound(sessionId, { callerEns, calleeIdentity, sipDirective });
}

async function openInboundSipSession(sessionId, phoneNumber) {
    return sipGateway.openInbound(sessionId, { phoneNumber });
}

/**
 * Closes the SIP session — sends BYE via sip.js, tears down UserAgent.
 */
async function closeSipSession(sessionId) {
    return sipGateway.close(sessionId);
}


// ═════════════════════════════════════════════════════════════
// DATA CHANNEL HELPERS
// ═════════════════════════════════════════════════════════════

/**
 * Sends a JSON message over the data channel to the Android client.
 */
function sendDataChannelMessage(sessionId, message) {
    return dataChannelApi.sendDataChannelMessage(sessionId, message);
}


// Blockchain and notification-plan implementations live under modules/gateways.


// ═════════════════════════════════════════════════════════════
// LEGACY NOTIFICATION FLOW (fallback)
// ═════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════
// SESSION STATE
// ═════════════════════════════════════════════════════════════

function createSession(sessionId, callerEns, toIdentity) {
    const session = sessionStore.createSession(sessionId, callerEns, toIdentity, console);
    session.callPairRef = createCallPairRef(callerEns, toIdentity);
    const call = callFactory.fromSession(session);
    session.call = call;
    session.callId = call.id;
    callRegistry.add(call);
    return session;
}

function destroySession(sessionId, notify = false) {
    const session = sessions.get(sessionId);
    const result = sessionStore.destroySession(sessionId, {
        notify,
        sendDataChannelMessage,
        logger: console,
    });
    if (session?.callId) callRegistry.remove(session.callId);
    return result;
}

// ═════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═════════════════════════════════════════════════════════════

module.exports = {
    onIncomingOffer,
    sessions,
    sessionsByUser,
    pendingInboundCalls,
    destroySession,
    parseAddress,
    resolveDestination,
    resolveCallerId,
    polyCore,
    polyRegistry,
    polyIngress,
};
