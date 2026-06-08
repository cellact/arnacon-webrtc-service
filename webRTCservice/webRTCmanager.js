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
const { DestinationResolver } = require("./modules/routing/DestinationResolver");
const { CallerIdResolver } = require("./modules/routing/CallerIdResolver");
const { CallRegistry } = require("./modules/calls/CallRegistry");
const { CallFactory } = require("./modules/calls/CallFactory");
const { ParticipantFactory } = require("./modules/participants/ParticipantFactory");
const { createPolyCore } = require("./modules/calls/poly/createPolyCore");
const { WebRtcOutboundLegFactory } = require("./modules/calls/webrtc/WebRtcOutboundLegFactory");
const { LEG_EVENTS, makeLegEvent } = require("./modules/calls/poly/ports");
const { LEG_STATES } = require("./modules/calls/poly/states");
const { isInactiveOffer } = require("./modules/calls/poly/negotiation/sdp");
const { routeToCodecPolicy } = require("./modules/media/negotiation/CodecPolicy");
const { narrowAudioOfferForCodecPolicy } = require("./modules/media/negotiation/SdpCodecNegotiator");
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
const CONFIG_OVERRIDE = process.env.WEBRTC_CONFIG_PATH || process.env.ARNACON_WEBRTC_CONFIG_PATH || "";
const CONFIG_PATH = CONFIG_OVERRIDE
    ? (path.isAbsolute(CONFIG_OVERRIDE) ? CONFIG_OVERRIDE : path.resolve(process.cwd(), CONFIG_OVERRIDE))
    : path.join(PACKAGE_ROOT, "config.json");
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
const GLOBAL_CONFIG_PATH = GLOBAL_CONFIG_OVERRIDE
    ? (path.isAbsolute(GLOBAL_CONFIG_OVERRIDE) ? GLOBAL_CONFIG_OVERRIDE : path.resolve(process.cwd(), GLOBAL_CONFIG_OVERRIDE))
    : (_commonEarly.globalServiceConfigPath || path.join(PACKAGE_ROOT, "globalserviceconfig.json"));
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
    bindIp: commonConfig.bindIp,
    tlsCertPath: commonConfig.tlsCertPath,
    roflBaseUrl: pickRuntimeConfig("roflBaseUrl"),
    messageProcessorUrl: pickRuntimeConfig("messageProcessorUrl"),
    minuteCounterPath: process.env.MINUTE_COUNTER_PATH || pickRuntimeConfig("minuteCounterPath", "/etc/webrtcservice/minute-counter.json"),
    polygon: pickRuntimeConfig("polygon", {}),
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
const KAMAILIO_WSS_URL = `ws://${config.kamailioWssHost || config.domain}:${config.kamailioWssPort}`;
const KAMAILIO_DOMAIN = config.domain;
const KAMAILIO_REGISTER_EXPIRES = 300;

const INTERNAL_BIND_IP = config.bindIp || "127.0.0.1";
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

// ─── ICE Servers (disabled) ─────────────────────────────────
const ICE_SERVERS = [];

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
const serviceContextFactory = new ServiceContextFactory({
    serviceRegistry: serviceRuntimeRegistry,
    zeroAddress: ethers.constants.AddressZero,
    parseAddress: (...args) => parseAddress(...args),
    normalizePhone: (...args) => normalizePhone(...args),
    blockchainApi,
    callRouterApi,
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

// Module-backed APIs used by manager orchestration.
function parseAddress(addr, serviceId = null) {
    return addressParserApi.parse(addr, serviceId);
}
const isRawEmail = (...args) => addressParserApi.isRawEmail(...args);
const emailToEnsName = (...args) => addressParserApi.emailToEnsName(...args);
const resolveEnsToAddress = (...args) => blockchainGateway.resolveEnsToAddress(...args);
const signalingAuthVerifier = new SignalingAuthVerifier({ blockchainGateway, sessions });
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
// Resolve the data channel a leg should signal over: the caller leg uses its own
// session DC; a secnum<->secnum callee leg uses the outbound-leg DC attached to
// the caller session (legSession === callerSession.outboundWebrtc).
function resolveLegDataChannel(session, callerSessionId) {
    if (session?.dataChannel) return session.dataChannel;
    const caller = callerSessionId ? sessions.get(callerSessionId) : null;
    return caller?.outboundWebrtc?.dataChannel || null;
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
        embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
        patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
        ensureLocalAudioTrack: (...args) => ensureLocalAudioTrack(...args),
        narrowAudioOfferForCodecPolicy: (...args) => narrowAudioOfferForCodecPolicy(...args),
        logSdp: (...args) => logSdp(...args),
    },
    makeSignalingTransport: ({ session, callerSessionId }) => ({
        send: (message) => {
            const dc = resolveLegDataChannel(session, callerSessionId);
            if (!isOpenDc(dc)) {
                console.error(`[poly-signaling] no open data channel for ${message.payload?.type || message.action || "message"}`);
                return;
            }
            dc.send(JSON.stringify(message));
        },
        isOpen: () => isOpenDc(resolveLegDataChannel(session, callerSessionId)),
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
console.log("[poly] PolySession core is the live coordinator");


// Call routing implementation moved to modules/routing/CallRouterApi.js.


// ═════════════════════════════════════════════════════════════
// HTTP SERVER — ENTRY POINT
// ═════════════════════════════════════════════════════════════

async function handleInboundCallRequest(data, serviceContext = null) {
    const payload = serviceContext?.serviceId ? { ...data, serviceId: serviceContext.serviceId } : data;
    // The inbound flow creates the session + PC1 and FCM-invites the secnum callee.
    const result = await inboundCallFlowApi.handleInboundCallRequest(payload);
    if (result?.ok && result.sessionId) {
        const session = sessions.get(result.sessionId);
        if (session) {
            // sip->secnum: legA = SIP gateway (PSTN dialing in), legB = secnum
            // webrtc callee. The FCM invite is already out, so seed states directly:
            // sip CALLING (caller side), webrtc RINGING (waiting for pickup). When the
            // callee answers (HTTP), legB -> IN_CALL and reconcile answers the sip leg
            // (openInbound) + bridges media.
            const calleeEns = result.ensName || session.toIdentity;
            const phoneNumber = session.inboundCall?.toNumber || payload.to;
            try {
                const { poly } = polyRegistry.resolve({
                    a: { endpoint: phoneNumber, kind: "sip", role: "inbound", phoneNumber, session },
                    b: { endpoint: calleeEns, kind: "webrtc", session },
                    target: "a",
                });
                poly.legs.a.setState(LEG_STATES.CALLING, { reason: "pstn-inbound", from: "self" });
                poly.legs.b.setState(LEG_STATES.RINGING, { reason: "fcm-invite-sent", from: "a" });
            } catch (err) {
                console.error(`[${result.sessionId}] inbound poly seed failed: ${err.message}`);
            }
        }
    }
    return result;
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
    if (!identity || typeof identity !== "string") return identity;
    const t = identity.trim();
    const at = t.indexOf("@");
    if (at > 0) return t.slice(0, at);
    const dot = t.indexOf(".");
    if (dot > 0) return t.slice(0, dot);
    return t;
}

function polyForSession(session) {
    if (!session) return null;
    return polyRegistry.getByEndpoint(session.callerEns)
        || polyRegistry.getByEndpoint(session.toIdentity)
        || null;
}

// Which leg ref a webrtc message on `session` targets. callee-webrtc role => the
// outbound callee leg (its negotiation.session === session.outboundWebrtc);
// otherwise the primary PC1 leg (negotiation.session === session).
function polyWebrtcRef(poly, session, channelRole) {
    const isCallee = channelRole === "callee-webrtc";
    for (const ref of ["a", "b"]) {
        const leg = poly.legs[ref];
        if (!leg || leg.kind !== "webrtc") continue;
        const ns = leg.negotiation?.session;
        if (isCallee) {
            if (ns && ns === session.outboundWebrtc) return ref;
        } else if (ns && ns === session) {
            return ref;
        }
    }
    if (poly.legs.a.kind === "webrtc") return "a";
    if (poly.legs.b.kind === "webrtc") return "b";
    return "a";
}

// Strict: does this poly actually own `session` (live transport), no fallback?
// Used to tell a brand-new ring on a fresh transport from an in-call message on
// the poly's own transport, and to stop a stale transport's close from tearing
// down a freshly rebuilt poly.
function polyOwnsSession(poly, session, channelRole) {
    if (!poly || !session) return false;
    const isCallee = channelRole === "callee-webrtc";
    for (const ref of ["a", "b"]) {
        const leg = poly.legs[ref];
        if (!leg || leg.kind !== "webrtc") continue;
        const ns = leg.negotiation?.session;
        if (isCallee ? ns === session.outboundWebrtc : ns === session) return true;
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

// Resolve routing at the audio RING and create the PolySession for the pair.
async function onDcRing(callerSessionId, payload) {
    const session = sessions.get(callerSessionId);
    if (!session || !session.peerConnection) return;
    session.lastRingOfferPayload = payload;
    const serviceId = session.serviceId || null;
    const to = payload.to || session.toIdentity;
    const parsedTo = parseAddress(to, serviceId);
    const parsedFrom = parseAddress(session.callerEns, serviceId);
    const destination = await resolveDestination(parsedTo, parsedFrom, serviceId);

    if (!destination || destination.route === "reject") {
        sendDataChannelMessage(callerSessionId, { msgType: "call", action: "end", reason: "reject-route" });
        return;
    }

    session.mediaCodecPolicy = routeToCodecPolicy(destination, { isInbound: false }) || null;

    const a = { endpoint: session.callerEns, kind: "webrtc", session };
    let b;
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
            role: "outbound",
            session,
        };
    }

    const { poly } = polyRegistry.resolve({ a, b, target: "a" });
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
    const poly = polyForSession(session);
    if (!poly) return;
    // The callee's outbound DC reuses the caller's sessionId, so the channelRole
    // (set by WebRtcOutboundLegFactory) is what tells us which leg just opened.
    const channelRole = meta.channelRole || "caller-webrtc";
    // Only mark transport-open if this poly owns the channel. A new transport whose
    // DC opens before its RING resolves to a stale poly by identity; the ring will
    // rebuild that poly fresh, so touching its frozen legs here would be wrong.
    if (!polyOwnsSession(poly, session, channelRole)) return;
    const ref = polyWebrtcRef(poly, session, channelRole);
    poly.onIngress(ref, makeLegEvent(LEG_EVENTS.TRANSPORT_OPEN)).catch((err) => {
        console.error(`[${sessionId}] poly transport-open (${channelRole}) failed: ${err.message}`);
    });
}

function onPeerConnected(sessionId) {
    // No pending-bridge bookkeeping anymore — pairing is handled by the registry.
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
        if (!existing || !polyOwnsSession(existing, session, channelRole)) {
            (async () => {
                if (existing) {
                    await polyRegistry.destroy(
                        polyRegistry.keyForPair(existing.legs.a.endpoint, existing.legs.b.endpoint),
                        "new-ring-reset",
                    );
                }
                await onDcRing(sessionId, msg.payload);
            })().catch((err) => {
                console.error(`[${sessionId}] ring routing failed: ${err.message}`);
                sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason: "ring-failed" });
            });
            return;
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
        payload = msg.payload || {};
    } else if (msg.msgType === "call") {
        if (msg.action === "hold") { action = "hold"; payload = { enabled: true }; }
        else if (msg.action === "unhold") { action = "hold"; payload = { enabled: false }; }
        else { action = msg.action; payload = msg; }
    }
    if (!action) return;

    const event = polyIngress.toLegEvent(action, payload, { channelRole });
    if (!event) return;
    const ref = polyWebrtcRef(poly, session, channelRole);
    poly.onIngress(ref, event).catch((err) => {
        console.error(`[${sessionId}] poly ingress (${action}) failed: ${err.message}`);
    });
}

// HTTP /notify "answer" (callee picked up: secnum<->secnum leg or inbound callee).
async function onVerifiedNotifyAnswer(sessionId, offer, session) {
    const poly = polyForSession(session) || polyRegistry.getByEndpoint(offer.from);
    if (!poly) return { handled: false };
    const ref = polyRefByEndpoint(poly, offer.from)
        || (poly.legs.b.kind === "webrtc" ? "b" : "a");
    try {
        await poly.onIngress(ref, polyIngress.toLegEvent("answer", { sdp: offer.sdp, candidates: offer.candidates || [] }, {}));
    } catch (err) {
        console.error(`[${sessionId}] poly http-answer failed: ${err.message}`);
        return { handled: false };
    }
    return { handled: true };
}

// HTTP /notify "reject".
async function onHttpReject(sessionId, offer) {
    const session = sessions.get(sessionId);
    const poly = polyForSession(session);
    if (!poly) return { ok: true, ignored: true, type: "reject", sessionId };
    const ref = polyRefByEndpoint(poly, offer.from) || "b";
    try {
        await poly.onIngress(ref, polyIngress.toLegEvent("reject", {}, {}));
    } catch (err) {
        console.error(`[${sessionId}] poly http-reject failed: ${err.message}`);
    }
    return { ok: true, type: "reject", sessionId };
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
    const session = sessions.get(sessionId);
    // A 2nd call reuses the same sessionId on a fresh transport. The old call's PC
    // can fire `closed` after the new session is already bound under this id. If the
    // closing transport is no longer the session's current caller/callee PC, it is
    // superseded -> ignore it entirely so we don't tear down the fresh session.
    if (session && event.pc &&
        event.pc !== session.peerConnection &&
        event.pc !== session.outboundWebrtc?.peerConnection) {
        return;
    }
    const poly = polyForSession(session);
    // Only tear the poly down if it actually owns this closing transport. A stale
    // PC closing after a new-ring rebuild resolves (by identity) to the freshly
    // built poly for the same pair -- which we must NOT kill. Just clean its
    // SessionStore entry in that case.
    if (poly && polyOwnsSession(poly, session, "caller-webrtc")) {
        const ref = polyWebrtcRef(poly, session, "caller-webrtc");
        try {
            await poly.onIngress(ref, makeLegEvent(LEG_EVENTS.TRANSPORT_CLOSE));
        } catch (err) {
            console.error(`[${sessionId}] poly transport-close failed: ${err.message}`);
        }
        try { await polyRegistry.destroy(polyRegistry.keyForPair(poly.legs.a.endpoint, poly.legs.b.endpoint), event.reason || "transport-closed"); } catch (_) {}
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
