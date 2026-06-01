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

function failCall(sessionId, err, context) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.CallFailed,
        source: CallEventSources.System,
        reason: context || "call-failed",
        error: err,
        notifyClient: true,
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

function schedulePhase2Reoffer(sessionId, pendingReoffer) {
    return callSdpUseCases.schedulePhase2Reoffer(sessionId, pendingReoffer);
}

async function routeCall(sessionId, session, destination, parsedFrom) {
    callRuntime.attachRoute(sessionId, destination);
    return callEngine.dispatch(sessionId, {
        type: CallEvents.RouteStartRequested,
        source: CallEventSources.Route,
        destination,
        route: destination?.route,
        parsedFrom,
    });
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
const { createSignalingHandlers } = require("./modules/participants/signaling/SignalingHandlers");
const { createMessagingFlow } = require("./modules/messaging/MessagingFlow");
const { WebRtcCallOrchestrator } = require("./modules/calls/webrtc/WebRtcCallOrchestrator");
const { VerifiedNotifyAnswerHandler } = require("./modules/calls/webrtc/VerifiedNotifyAnswerHandler");
const { StartCallUseCase } = require("./modules/calls/useCases/StartCallUseCase");
const { AnswerCallUseCase } = require("./modules/calls/useCases/AnswerCallUseCase");
const { RenegotiateCallUseCase } = require("./modules/calls/useCases/RenegotiateCallUseCase");
const { createInboundCallFlow } = require("./modules/calls/inbound/InboundCallFlow");
const { createOfferFlow } = require("./modules/calls/webrtc/WebRtcOfferUseCase");
const { createHandshakeFlow } = require("./modules/calls/webrtc/WebRtcHandshakeUseCase");
const { createDataChannelApi } = require("./modules/participants/signaling/DataChannelGateway");
const { createSipRuntime } = require("./modules/gateways/sip/SipRuntime");
const { createOpenAiSipGateway } = require("./modules/gateways/openai/OpenAiGateway");
const { OpenAiTransferFlow } = require("./modules/gateways/openai/OpenAiTransferFlow");
const { adaptRtpPayloadType } = require("./modules/media/codecs/rtp");
const { MediaGraphFactory } = require("./modules/media/MediaGraphFactory");
const { MediaRelayController } = require("./modules/media/MediaRelayController");
const { CallSdpUseCases } = require("./modules/calls/useCases/CallSdpUseCases");
const { SignalingAuthVerifier, createSignalingPipeline } = require("./modules/participants/signaling/SignalingPipeline");
const { createIvrRuntime } = require("./modules/callFeatures/ivr/IvrRuntime");
const { createIvrAudioPlayback } = require("./modules/callFeatures/ivr/IvrAudioPlayback");
const { IvrFeature } = require("./modules/callFeatures/ivr/IvrFeature");
const { createMinuteCounter } = require("./modules/callFeatures/minuteCounter/MinuteCounter");
const { OpenAiSalesAgentFeature } = require("./modules/callFeatures/openaiSales/OpenAiSalesAgentFeature");
const { IvrRedirectController } = require("./modules/callFeatures/ivr/IvrRedirectController");
const { MinuteCounterPolicy } = require("./modules/callFeatures/minuteCounter/MinuteCounterPolicy");
const { AddressParser } = require("./modules/routing/AddressParser");
const { ServiceRegistry: ServiceRuntimeRegistry } = require("./modules/routing/ServiceRegistry");
const { ServiceContextFactory } = require("./modules/routing/ServiceContextFactory");
const { DestinationResolver } = require("./modules/routing/DestinationResolver");
const { CallerIdResolver } = require("./modules/routing/CallerIdResolver");
const { CallRegistry } = require("./modules/calls/CallRegistry");
const { CallFactory } = require("./modules/calls/CallFactory");
const { CallEvents, CallEventSources } = require("./modules/calls/CallEvents");
const { CallRuntime } = require("./modules/calls/runtime/CallRuntime");
const { CallEngine } = require("./modules/calls/engine/CallEngine");
const { createCallEngineHandlers, createRouteStrategies } = require("./modules/calls/runtime/CallServiceContainer");
const { ParticipantFactory } = require("./modules/participants/ParticipantFactory");
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
const mediaRelayController = new MediaRelayController({
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
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    sendAck: (...args) => sendAck(...args),
    sendAnswer: (...args) => sendAnswer(...args),
    sendAckAndAnswer: (...args) => sendAckAndAnswer(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    handleCallEnd: (...args) => handleCallEnd(...args),
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
let callRuntime;
const ivrAudioPlaybackApi = createIvrAudioPlayback({
    sessions,
    isInCall: (session) => Boolean(callRuntime?.isInCall(session)),
    logger: console,
    demoAudioDir: IVR_DEMO_AUDIO_DIR,
});
const ivrRuntimeApi = createIvrRuntime({
    sessions,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    playAudioForSession: (...args) => ivrAudioPlaybackApi.playText(...args),
    playAudioFileForSession: (...args) => ivrAudioPlaybackApi.playFile(...args),
    stopAudioForSession: (...args) => ivrAudioPlaybackApi.stopSessionPlayback(...args),
    startMediaForSession: (...args) => startIvrMediaSession(...args),
    stopMediaForSession: (...args) => stopIvrMediaSession(...args),
    redirectCallForSession: (...args) => ivrRedirectController.redirectToWebrtc(...args),
    logger: console,
});
const ivrRedirectController = new IvrRedirectController({
    sessions,
    parseAddress: (...args) => parseAddress(...args),
    resolveDestination: (...args) => resolveDestination(...args),
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    playWaitingAudio: (...args) => ivrAudioPlaybackApi.playFile(...args),
    stopIvr: (...args) => ivrRuntimeApi.stopIvr(...args),
    stopAudioForSession: (...args) => ivrAudioPlaybackApi.stopSessionPlayback(...args),
    logger: console,
});
const ivrFeatureApi = new IvrFeature({
    ivrRuntime: ivrRuntimeApi,
    ivrAudioPlayback: ivrAudioPlaybackApi,
    logger: console,
});
callRuntime = new CallRuntime({
    sessions,
    callRegistry,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    enqueueSignaling: (...args) => enqueueSignaling(...args),
    destroySession: (...args) => destroySession(...args),
    teardownHandlers: [
        ({ session }) => minuteCounterApi.finish(session),
        ({ sessionId }, event) => ivrFeatureApi.stop(sessionId, event.reason || "runtime-teardown"),
    ],
    logger: console,
});
const { routeStrategyRegistry } = createRouteStrategies({
    openSipSession: (...args) => openSipSession(...args),
    closeSipSession: (...args) => closeSipSession(...args),
    resolveCallerId: (...args) => resolveCallerId(...args),
    minuteCounter: minuteCounterApi,
    minuteCounterPolicy,
    startMediaRelay: (...args) => startMediaRelay(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    openOpenAiSipSession: (...args) => openOpenAiSipSession(...args),
    closeOpenAiSipSession: (...args) => openAiSipGatewayApi.closeOpenAiSipSession(...args),
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    notifyAndBridgeMulti: (...args) => notifyAndBridgeMulti(...args),
    startPendingMultiBridge: (...args) => bridgeApi.startPendingMultiBridge(...args),
    cancelPendingBridge: (...args) => bridgeApi.cancelPendingBridgeForSession(...args),
    destroyRuntimeSession: (...args) => callRuntime.destroyRuntimeSession(...args),
    startIvrSession: (...args) => ivrFeatureApi.start(...args),
    stopIvrSession: (...args) => ivrFeatureApi.stop(...args),
    logger: console,
});
const callEngine = new CallEngine({
    runtime: callRuntime,
    routeStrategies: routeStrategyRegistry,
    handlers: createCallEngineHandlers({
        handshakeFlowApi: () => handshakeFlowApi,
        startCallUseCase: () => startCallUseCase,
        answerCallUseCase: () => answerCallUseCase,
        renegotiateCallUseCase: () => renegotiateCallUseCase,
        bridgeApi: () => bridgeApi,
        callRuntime,
        logger: console,
    }),
    logger: console,
});
callRuntime.setCallEventDispatcher((sessionId, event) => callEngine.dispatch(sessionId, event));
const sipRuntimeApi = createSipRuntime({
    sessions,
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    patchRouterForDynamicSsrc: (...args) => peerConnectionApi.patchRouterForDynamicSsrc(...args),
    SessionState,
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    onCallEvent: (sessionId, event) => callEngine.dispatch(sessionId, event),
    isInCall: (session) => callRuntime.isInCall(session),
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
    startMediaRelay: (sessionId) => startMediaRelay(sessionId),
    isTerminalForSipEvents: (session) => callRuntime.isTerminalForSipEvents(session),
    logger: console,
});
const sipGateway = new SipGateway({
    sipClient: sipClientApi,
    sessionStore,
    logger: console,
});
const openAiTransferFlow = new OpenAiTransferFlow({
    sessions,
    parseAddress: (...args) => parseAddress(...args),
    resolveDestination: (...args) => resolveDestination(...args),
    closeOpenAiSipSession: (...args) => openAiSipGatewayApi.closeOpenAiSipSession(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    routeCall: (...args) => routeCall(...args),
    closeSipSession: (...args) => closeSipSession(...args),
    startPendingMultiBridge: (...args) => bridgeApi.startPendingMultiBridge(...args),
    startMediaRelay: (...args) => startMediaRelay(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    callRuntime,
    connectRoute: (sessionId, { destination, routeResult, source } = {}) => callEngine.dispatch(sessionId, {
        type: CallEvents.RouteConnected,
        source: source || CallEventSources.Route,
        destination,
        route: destination?.route || routeResult,
        routeResult,
    }),
    logger: console,
});
const openAiSipGatewayApi = createOpenAiSipGateway({
    sessions,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    onTransferOpenAiCall: (...args) => openAiTransferFlow.request(...args),
    onCallEvent: (sessionId, event) => callEngine.dispatch(sessionId, event),
    isInCall: (session) => callRuntime.isInCall(session),
    config: OPENAI_SIP_CONFIG,
    logger: console,
});
const bridgeApi = new WebRtcCallOrchestrator({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    createSession: (...args) => createSession(...args),
    createPeerConnection: (...args) => createPeerConnection(...args),
    sendNotification: (...args) => sendNotification(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    startWebRtcBridge: (...args) => startWebRtcBridge(...args),
    destroySession: (...args) => destroySession(...args),
    onCallEvent: (sessionId, event) => callEngine.dispatch(sessionId, event),
    notiTypeCall: NOTI_TYPE_CALL,
    MediaStreamTrack,
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    getRelayCandidates: (...args) => getRelayCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    RTCSessionDescription,
    onDataChannelOpen: (...args) => onDataChannelOpen(...args),
    onDataChannelMessage: (...args) => onDataChannelMessage(...args),
    logger: console,
});
const openAiSalesFeature = new OpenAiSalesAgentFeature({
    sessions,
    triggerCaller: OPENAI_SALES_TRIGGER_CALLER,
    salesAgentFrom: OPENAI_SALES_AGENT_FROM,
    createSession: (...args) => createSession(...args),
    parseAddress: (...args) => parseAddress(...args),
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    notifyAndBridgeMulti: (...args) => notifyAndBridgeMulti(...args),
    startPendingMultiBridge: (...args) => bridgeApi.startPendingMultiBridge(...args),
    routeCall: (...args) => routeCall(...args),
    openOpenAiSipSession: (...args) => openOpenAiSipSession(...args),
    closeSipSession: (...args) => closeSipSession(...args),
    closeNativeSipSession: (sessionId) => sipGateway.close(sessionId),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    destroySession: (...args) => destroySession(...args),
    mediaGraphFactory,
    adaptRtpPayloadType,
    crypto,
    SessionState,
    callRuntime,
    logger: console,
});
const answerCallUseCase = new AnswerCallUseCase({
    sessions,
    openInboundSipSession: (...args) => openInboundSipSession(...args),
    startMediaRelay: (...args) => startMediaRelay(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    sendAnswer: (...args) => sendAnswer(...args),
    sendAckAndAnswer: (...args) => sendAckAndAnswer(...args),
    failCall: (...args) => failCall(...args),
    schedulePhase2Reoffer: (...args) => schedulePhase2Reoffer(...args),
    RTCSessionDescription,
    startPendingMultiBridge: (...args) => bridgeApi.startPendingMultiBridge(...args),
    shouldStartIvrForSession: (...args) => ivrFeatureApi.shouldStart(...args),
    callRuntime,
    connectRoute: (sessionId, { destination, routeResult, source } = {}) => callEngine.dispatch(sessionId, {
        type: CallEvents.RouteConnected,
        source: source || CallEventSources.Route,
        destination,
        route: destination?.route || routeResult,
        routeResult,
    }),
    logger: console,
});
const startCallUseCase = new StartCallUseCase({
    sessions,
    pendingInboundCalls,
    parseAddress: (...args) => parseAddress(...args),
    resolveDestination: (...args) => resolveDestination(...args),
    routeCall: (...args) => routeCall(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    sendAck: (...args) => sendAck(...args),
    sendAnswer: (...args) => sendAnswer(...args),
    ensureLocalAudioTrack: (...args) => ensureLocalAudioTrack(...args),
    createAnswerSdp: (...args) => createAnswerSdp(...args),
    logSdp: (...args) => logSdp(...args),
    patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    getRelayCandidates: (...args) => getRelayCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    MediaStreamTrack,
    RTCSessionDescription,
    answerCallUseCase,
    shouldStartOpenAiSalesAgent: (...args) => openAiSalesFeature.shouldStart(...args),
    startOpenAiSalesAgentFlow: (...args) => openAiSalesFeature.start(...args),
    cancelCall: (sessionId, { destination, reason } = {}) => callEngine.dispatch(sessionId, {
        type: CallEvents.CallCancelRequested,
        source: CallEventSources.Route,
        destination,
        route: "reject",
        reason: reason || "reject-route",
        notifyClient: true,
    }),
    callRuntime,
    logger: console,
});
const verifiedNotifyAnswerHandler = new VerifiedNotifyAnswerHandler({
    bridgeApi,
    startCallUseCase,
    destroySession: (...args) => destroySession(...args),
    getSessionKind: (session) => callRuntime.getSessionKind(session),
    callRuntime,
    RTCSessionDescription,
    addIceCandidates: (...args) => addIceCandidates(...args),
    logger: console,
});
const renegotiateCallUseCase = new RenegotiateCallUseCase({
    sessions,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    closeSipSession: (...args) => closeSipSession(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    logSdp: (...args) => logSdp(...args),
    RTCSessionDescription,
    callRuntime,
});
const signalingHandlersApi = createSignalingHandlers({
    sessions,
    handleEndCallRenegotiation: (...args) => handleEndCallRenegotiation(...args),
    handleReofferAnswer: (...args) => handleReofferAnswer(...args),
    handleInboundCalleeAnswer: (...args) => handleInboundCalleeAnswer(...args),
    handleOutboundWebrtcLegAnswer: (...args) => handleOutboundWebrtcLegAnswer(...args),
    handleIceRestart: (...args) => handleIceRestart(...args),
    handleRing: (...args) => handleRing(...args),
    handleCallEnd: (...args) => handleCallEnd(...args),
    handleCallDtmf: (...args) => handleCallDtmf(...args),
    handleCallHold: (sessionId, held) => callRuntime.setSipHold(sessionId, !held),
    handleDataMessage: (...args) => messagingFlowApi.handleDataMessage(...args),
    resetPostCallForNewRing: (sessionId) => callRuntime.resetForNewRing(sessionId, { source: "client", reason: "post-call-new-ring" }),
    isEndRenegotiationPending: (session) => callRuntime.isEndRenegotiationPending(session),
    canAcceptNewRing: (session) => callRuntime.canAcceptNewRing(session),
    isRinging: (session) => callRuntime.isRinging(session),
    isInCall: (session) => callRuntime.isInCall(session),
    getSessionKind: (session) => callRuntime.getSessionKind(session),
    logger: console,
});
const peerConnectionApi = createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers: ICE_SERVERS,
    onDataChannelOpen: (sessionId) => onDataChannelOpen(sessionId),
    onPeerConnected: (sessionId) => onPeerConnected(sessionId),
    onDataChannelMessage: (sessionId, raw, meta = {}) => signalingHandlersApi.onDataChannelMessage(sessionId, raw, meta),
    onInboundRtp: (sessionId, rtp) => ivrAudioPlaybackApi.onInboundRtp(sessionId, rtp),
    onSessionDestroyRequested: (sessionId, event) => callEngine.dispatch(sessionId, {
        type: CallEvents.SessionDestroyRequested,
        source: event.source || CallEventSources.WebRtc,
        reason: event.reason || "peer-connection-destroy",
        notify: event.notify === true,
    }),
    logger: console,
});
ivrAudioPlaybackApi.validateDependencies();

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
    handleHttpReject: (sessionId, offer) => {
        const session = sessions.get(sessionId);
        const rejectedByOwnedWebRtcLeg = Boolean(
            session?.outboundWebrtc &&
            relationIdentityLabel(session.outboundWebrtc.toIdentity) === relationIdentityLabel(offer.from),
        );
        return callEngine.dispatch(sessionId, {
            type: CallEvents.CallEndRequested,
            source: CallEventSources.Client,
            route: "webrtc",
            reason: "client-reject",
            notifyClient: rejectedByOwnedWebRtcLeg,
            notifyOwnedWebRtcLegs: !rejectedByOwnedWebRtcLeg,
            propagateLinkedSession: false,
        });
    },
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
const callSdpUseCases = new CallSdpUseCases({
    sessions,
    MediaStreamTrack,
    patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
    logSdp: (...args) => logSdp(...args),
    enqueueSignaling: (...args) => enqueueSignaling(...args),
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


// Call routing implementation moved to modules/routing/CallRouterApi.js.


// ═════════════════════════════════════════════════════════════
// HTTP SERVER — ENTRY POINT
// ═════════════════════════════════════════════════════════════

async function handleInboundCallRequest(data, serviceContext = null) {
    const payload = serviceContext?.serviceId ? { ...data, serviceId: serviceContext.serviceId } : data;
    return inboundCallFlowApi.handleInboundCallRequest(payload);
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
openAiSipGatewayApi.startAuthServer();

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
    return callEngine.dispatch(sessionId, {
        type: CallEvents.CallOfferReceived,
        source: CallEventSources.Http,
        payload: { fromEns, toIdentity, offerSdp, candidates, callNonce },
    });
}

/**
 * Handles the callee's SDP answer for an inbound SBC call where the gateway is the offerer.
 * Applies the remote answer and lets ICE complete — data channel will open afterwards.
 */
async function handleInboundAnswer(sessionId, answerSdp, candidates) {
    return handshakeFlowApi.handleInboundAnswer(sessionId, answerSdp, candidates);
}

/**
 * Creates PC1 — the client-facing WebRTC PeerConnection.
 * Initially data-channel only. Audio tracks are added later during Phase 2 renegotiation.
 */
function createPeerConnection(...args) {
    return peerConnectionApi.createPeerConnection(...args);
}

/**
 * Called when the data channel opens after the handshake completes.
 */
function onDataChannelOpen(sessionId) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.DataChannelOpened,
        source: CallEventSources.WebRtc,
        deps: {
            checkPendingBridge: (...args) => checkPendingBridge(...args),
            checkPendingInboundCall: (...args) => checkPendingInboundCall(...args),
            sendInboundRing: (...args) => sendInboundRing(...args),
            destroySession: (...args) => destroySession(...args),
        },
    });
}

function onPeerConnected(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.walletAddress) return;
    checkPendingBridge(sessionId, session.walletAddress);
    checkPendingInboundCall(sessionId, session.walletAddress);
}

/**
 * Gateway-as-caller: sends RING + audio SDP offer over the data channel.
 * The callee will respond with an ANSWER + audio SDP, handled in onDataChannelMessage.
 */
async function sendInboundRing(sessionId) {
    return startCallUseCase.sendInboundRing(sessionId);
}

/**
 * Gateway-as-caller: callee responded to RING with an audio answer SDP via data channel.
 * Apply the answer and open the SIP leg to resume the suspended Kamailio INVITE.
 */
async function handleInboundCalleeAnswer(sessionId, payload) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.CalleeAnswered,
        source: CallEventSources.Client,
        payload,
        answerKind: "inbound-callee",
    });
}

async function handleOutboundWebrtcLegAnswer(sessionId, payload) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.CalleeAnswered,
        source: CallEventSources.WebRtc,
        payload,
        answerKind: "outbound-webrtc-leg",
    });
}

/**
 * Enqueues an async task on the session's signaling queue so SDP operations
 * (end-call renegotiation, RING offers, answers, ICE restarts) never overlap.
 */
function enqueueSignaling(sessionId, label, fn) {
    return signalingHandlersApi.enqueueSignaling(sessionId, label, fn);
}

/**
 * Called when a message arrives on the data channel.
 * Routes to the appropriate handler based on message type.
 * SDP-touching operations are serialized via enqueueSignaling.
 */
function onDataChannelMessage(sessionId, rawMessage, meta = {}) {
    return signalingHandlersApi.onDataChannelMessage(sessionId, rawMessage, meta);
}


// ═════════════════════════════════════════════════════════════
// PHASE 2 — AUDIO CALL (via Data Channel + SIP)
// ═════════════════════════════════════════════════════════════

/**
 * Called when the client sends a RING over the data channel.
 * Runs the call routing pipeline to determine where the call goes,
 * then accepts audio renegotiation on PC1 and routes accordingly.
 */
async function handleRing(sessionId, payload) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.CallRingRequested,
        source: CallEventSources.Client,
        payload,
    });
}

/**
 * Called when the client answers a server-initiated re-offer (Phase 2).
 * Since the call is already routed (SIP session opened in Phase 1),
 * this just applies the answer to PC1 to fix currentDirection.
 */
async function handleReofferAnswer(sessionId, payload) {
    return renegotiateCallUseCase.handleReofferAnswer(sessionId, payload);
}

/**
 * WebRTC-to-WebRTC bridge: notifies the callee to connect, waits for them,
 * then pipes audio between the caller's PC1 and the callee's PC1.
 */
async function notifyAndBridge(callerSessionId, destination) {
    const reused = await bridgeApi.tryBridgeOverExistingLeg(
        callerSessionId,
        destination,
        () => startCallUseCase.triggerOutboundWebrtcLegRing(callerSessionId),
    );
    if (reused) return reused;
    return bridgeApi.notifyAndBridge(callerSessionId, destination);
}

async function notifyAndBridgeMulti(callerSessionId, destinations) {
    return bridgeApi.notifyAndBridgeMulti(callerSessionId, destinations);
}

async function onVerifiedNotifyAnswer(sessionId, offer, session) {
    return verifiedNotifyAnswerHandler.handle(sessionId, offer, session);
}

/**
 * Bridges audio between two WebRTC sessions (caller PC1 ↔ callee PC1).
 * Audio tracks may not exist yet (callee hasn't sent RING), so wiring is
 * event-driven: we subscribe to onTrack on both PCs and wire each direction
 * as tracks become available.
 */
function startWebRtcBridge(callerSessionId, calleeSessionId) {
    return bridgeApi.startBridgeRtp(callerSessionId, calleeSessionId);
}

/**
 * Called when an incoming offer arrives from a user who might be a callee
 * for a pending WebRTC bridge. Checks pendingBridges and resolves if matched.
 */
function checkPendingBridge(sessionId, walletAddress) {
    return bridgeApi.checkPendingBridge(sessionId, walletAddress);
}

/**
 * Called when a callee connects who might be the target of a pending inbound
 * SBC call. Marks the session so handleRing routes through the inbound path.
 */
function checkPendingInboundCall(sessionId, walletAddress) {
    return bridgeApi.checkPendingInboundCall(sessionId, walletAddress);
}

/**
 * Handles an ICE restart from the client during an active call.
 * Renegotiates PC1 (client-facing) without touching PC2 (SIP leg).
 */
async function handleIceRestart(sessionId, payload) {
    return bridgeApi.handleIceRestart(sessionId, payload);
}

/**
 * Opens a SIP session to Kamailio via sip.js.
 *
 * sip.js handles the full SIP dialog: WSS connect → REGISTER → INVITE → 200 OK → ACK
 *
 * Thanks to the werift polyfill, sip.js's internal PeerConnection (PC2) is actually
 * a werift RTCPeerConnection. After the call is established, we access PC2 via
 * inviter.sessionDescriptionHandler.peerConnection for RTP piping.
 */
async function openSipSession(sessionId, callerEns, calleeIdentity, sipDirective = null) {
    return sipGateway.openOutbound(sessionId, { callerEns, calleeIdentity, sipDirective });
}

async function openOpenAiSipSession(sessionId, options = {}) {
    return openAiSipGatewayApi.openOpenAiSipSession(sessionId, options);
}

/**
 * Opens a SIP session for an inbound SBC call. Registers with Kamailio using
 * the called phone number as the SIP identity, which triggers PUSHJOIN to
 * resume the suspended INVITE. Then accepts the incoming INVITE and bridges
 * PC1 (callee's WebRTC) ↔ PC2 (SBC via Kamailio/RTPEngine).
 */
async function openInboundSipSession(sessionId, phoneNumber) {
    return sipGateway.openInbound(sessionId, { phoneNumber });
}

/**
 * Starts relaying audio between PC1 (client) and PC2 (Kamailio/sip.js)
 * by piping raw RTP packets between the two PeerConnections.
 *
 *   Client audio → PC1 remote track → onReceiveRtp → PC2 local track → writeRtp → Kamailio
 *   Kamailio audio → PC2 remote track → onReceiveRtp → PC1 local track → writeRtp → Client
 */
function startMediaRelay(sessionId) {
    return mediaRelayController.startWebRtcToSip(sessionId);
}

/**
 * Stops the media relay for a session.
 */
function stopMediaRelay(sessionId) {
    return mediaRelayController.stopSession(sessionId);
}

async function startIvrMediaSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.peerConnection) return false;
    await mediaGraphFactory.ivrToWebrtc(session, {
        payloadType: session.mediaCodecPolicy === "pcmu" ? 0 : 8,
    });
    return true;
}

async function stopIvrMediaSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session?.media?.ivrLeg) return false;
    await session.resources?.mediaSession?.().stop("ivr-media-stop");
    return true;
}

/**
 * Called when the client sends an end-call message over the data channel.
 * Tears down the SIP leg (PC2) and media relay. Does NOT touch PC1 —
 * the client will send a renegotiation offer to drop audio from PC1.
 */
async function handleCallEnd(sessionId, reason = "client-initiated", options = {}) {
    const normalizedOptions = typeof options === "boolean" ? { propagate: options } : options;
    const propagate = normalizedOptions.propagate !== false;
    return callEngine.dispatch(sessionId, {
        type: reason === "client-reject" ? CallEvents.CallCancelRequested : CallEvents.CallEndRequested,
        source: CallEventSources.Client,
        reason,
        notifyClient: normalizedOptions.notifyClient === true,
        notifyOwnedWebRtcLegs: normalizedOptions.notifyOwnedWebRtcLegs !== false,
        propagateLinkedSession: propagate,
    });
}

async function handleCallDtmf(sessionId, msg) {
    if (await ivrFeatureApi.handleDtmf(sessionId, msg)) {
        return;
    }
    try {
        return await callEngine.dispatch(sessionId, {
            type: CallEvents.DtmfReceived,
            source: CallEventSources.Client,
            route: "sbc",
            payload: msg,
        });
    } catch (err) {
        console.error(`[${sessionId}] DTMF relay failed: ${err.message}`);
    }
}

/**
 * Handles end-call renegotiation — client wants to drop audio but keep the data channel.
 */
async function handleEndCallRenegotiation(sessionId, payload, options = {}) {
    return callEngine.dispatch(sessionId, {
        type: CallEvents.EndRenegotiationReceived,
        source: CallEventSources.Client,
        reason: "end-call-renegotiated",
        payload,
        channelRole: options.channelRole || "caller-webrtc",
    });
}

/**
 * Closes the SIP session — sends BYE via sip.js, tears down UserAgent.
 */
async function closeSipSession(sessionId) {
    minuteCounterApi.finish(sessions.get(sessionId));
    await openAiSipGatewayApi.closeOpenAiSipSession(sessionId);
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
};
