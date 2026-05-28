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

const { applyPolyfills } = require("./modules/polyfills");
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
} = require("./modules/peerConnection");
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
    return callRuntimeCoreApi.failCall(sessionId, err, context);
}

function ensureLocalAudioTrack(session, pc, sessionId) {
    return callRuntimeCoreApi.ensureLocalAudioTrack(session, pc, sessionId);
}

async function createAnswerSdp(pc, sessionId, label) {
    return callRuntimeCoreApi.createAnswerSdp(pc, sessionId, label);
}

function sendSignalingOffer(sessionId, sdp) {
    return callRuntimeCoreApi.sendSignalingOffer(sessionId, sdp);
}

function schedulePhase2Reoffer(sessionId, pendingReoffer) {
    return callRuntimeCoreApi.schedulePhase2Reoffer(sessionId, pendingReoffer);
}

async function routeCall(sessionId, session, destination, parsedFrom) {
    return callRuntimeCoreApi.routeCall(sessionId, session, destination, parsedFrom);
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
const { createSessionStore } = require("./modules/sessionStore");
const { createCallRouter } = require("./modules/callRouter");
const { createBlockchainApi } = require("./modules/blockchain");
const { createNotificationApi } = require("./modules/notification");
const { createHandlers } = require("./modules/handlers");
const { createHttpServers } = require("./modules/httpServer");
const { createPeerConnectionFactory } = require("./modules/peerConnection");
const { createSipClient } = require("./modules/sipClient");
const { createSignalingHandlers } = require("./modules/signalingHandlers");
const { createMessagingFlow } = require("./modules/messagingFlow");
const { createBridgeApi } = require("./modules/bridge");
const { createCallFlowApi } = require("./modules/callFlow");
const { createInboundCallFlow } = require("./modules/inboundCallFlow");
const { createOfferFlow } = require("./modules/offerFlow");
const { createHandshakeFlow } = require("./modules/handshakeFlow");
const { createDataChannelApi } = require("./modules/dataChannel");
const { createSipRuntime } = require("./modules/sipRuntime");
const { createCallRuntimeCore } = require("./modules/callRuntimeCore");
const { createOpenAiSipGateway } = require("./modules/openAiSipGateway");
const { createSignalingPipeline } = require("./modules/signalingPipeline");
const { createIvrRuntime } = require("./modules/ivrRuntime");
const { createIvrAudioPlayback } = require("./modules/ivrAudioPlayback");
const { createMinuteCounter } = require("./modules/minuteCounter");
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

function getServiceRuntime(serviceId = null) {
    if (serviceId && serviceRuntimes[serviceId]) {
        return serviceRuntimes[serviceId];
    }
    return defaultServiceRuntime;
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
const minuteCounterApi = createMinuteCounter({
    filePath: config.minuteCounterPath,
    logger: console,
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
const callRouterApi = createCallRouter({
    roflBaseUrl: ROFL_BASE_URL,
    fetchImpl: fetch,
    logger: console,
    useLocalRoflLogic: USE_LOCAL_ROFL_LOGIC,
    lookupBusinessNumberImpl: (...args) => blockchainApi.roflFindBusinessNumber(...args),
    assignFromNumberImpl: (...args) => blockchainApi.roflAssignFromNumber(...args),
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
const ivrAudioPlaybackApi = createIvrAudioPlayback({
    sessions,
    logger: console,
    demoAudioDir: IVR_DEMO_AUDIO_DIR,
});
const ivrRuntimeApi = createIvrRuntime({
    sessions,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    playAudioForSession: (...args) => ivrAudioPlaybackApi.playText(...args),
    playAudioFileForSession: (...args) => ivrAudioPlaybackApi.playFile(...args),
    stopAudioForSession: (...args) => ivrAudioPlaybackApi.stopSessionPlayback(...args),
    redirectCallForSession: (...args) => redirectIvrSessionToWebrtc(...args),
    logger: console,
});
const sipRuntimeApi = createSipRuntime({
    sessions,
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    patchRouterForDynamicSsrc: (...args) => peerConnectionApi.patchRouterForDynamicSsrc(...args),
    SessionState,
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
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
    logger: console,
});
const openAiSipGatewayApi = createOpenAiSipGateway({
    sessions,
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    onTransferOpenAiCall: (...args) => transferOpenAiCallRequest(...args),
    config: OPENAI_SIP_CONFIG,
    logger: console,
});
const bridgeApi = createBridgeApi({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    createSession: (...args) => createSession(...args),
    createPeerConnection: (...args) => createPeerConnection(...args),
    sendNotification: (...args) => sendNotification(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    startWebRtcBridge: (...args) => startWebRtcBridge(...args),
    destroySession: (...args) => destroySession(...args),
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
const callFlowApi = createCallFlowApi({
    sessions,
    pendingInboundCalls,
    parseAddress: (...args) => parseAddress(...args),
    resolveDestination: (...args) => resolveDestination(...args),
    routeCall: (...args) => routeCall(...args),
    openInboundSipSession: (...args) => openInboundSipSession(...args),
    startMediaRelay: (...args) => startMediaRelay(...args),
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    closeSipSession: (...args) => closeSipSession(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    sendAck: (...args) => sendAck(...args),
    sendAnswer: (...args) => sendAnswer(...args),
    sendAckAndAnswer: (...args) => sendAckAndAnswer(...args),
    failCall: (...args) => failCall(...args),
    ensureLocalAudioTrack: (...args) => ensureLocalAudioTrack(...args),
    createAnswerSdp: (...args) => createAnswerSdp(...args),
    schedulePhase2Reoffer: (...args) => schedulePhase2Reoffer(...args),
    logSdp: (...args) => logSdp(...args),
    patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
    waitForIceGathering: (...args) => waitForIceGathering(...args),
    formatIceCandidates: (...args) => formatIceCandidates(...args),
    getRelayCandidates: (...args) => getRelayCandidates(...args),
    embedCandidatesInSdp: (...args) => embedCandidatesInSdp(...args),
    MediaStreamTrack,
    RTCSessionDescription,
    enqueueSignaling: (...args) => enqueueSignaling(...args),
    startPendingMultiBridge: (...args) => bridgeApi.startPendingMultiBridge(...args),
    shouldStartIvrForSession: (...args) => ivrRuntimeApi.shouldStartForSession(...args),
    startIvrForSession: (...args) => ivrRuntimeApi.startIvr(...args),
    shouldStartOpenAiSalesAgent: (...args) => shouldStartOpenAiSalesAgent(...args),
    startOpenAiSalesAgentFlow: (...args) => startOpenAiSalesAgentFlow(...args),
    finishMinuteCounter: (session) => minuteCounterApi.finish(session),
    logger: console,
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
    handleDataMessage: (...args) => messagingFlowApi.handleDataMessage(...args),
    logger: console,
});
const peerConnectionApi = createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers: ICE_SERVERS,
    onDataChannelOpen: (sessionId) => onDataChannelOpen(sessionId),
    onPeerConnected: (sessionId) => onPeerConnected(sessionId),
    onDataChannelMessage: (sessionId, raw) => signalingHandlersApi.onDataChannelMessage(sessionId, raw),
    onInboundRtp: (sessionId, rtp) => ivrAudioPlaybackApi.onInboundRtp(sessionId, rtp),
    destroySession: (sessionId, notify) => destroySession(sessionId, notify),
    logger: console,
});
ivrAudioPlaybackApi.validateDependencies();

// Module-backed APIs used by manager orchestration.
function parseAddress(addr, serviceId = null) {
    return callRouterApi.parseAddress(addr, serviceId);
}
const isRawEmail = callRouterApi.isRawEmail;
const emailToEnsName = callRouterApi.emailToEnsName;
const resolveEnsToAddress = blockchainApi.resolveEnsToAddress;
const verifyHttpSignalingSignature = blockchainApi.verifyHttpSignalingSignature;
const isEthAddress = blockchainApi.isEthAddress;
const zeroAddress = ethers.constants.AddressZero;

const sendNotification = notificationApi.sendNotification;

function normalizePhone(value) {
    return String(value || "").replace(/^\+/, "");
}

function getMinuteLimitSeconds(serviceRuntime) {
    const constants = serviceRuntime?.serviceConstants || {};
    if (constants.minuteLimitSeconds !== undefined) {
        const parsedSeconds = Number(constants.minuteLimitSeconds);
        return Number.isFinite(parsedSeconds) && parsedSeconds > 0 ? Math.floor(parsedSeconds) : null;
    }
    if (constants.minuteLimitMinutes !== undefined) {
        const parsedMinutes = Number(constants.minuteLimitMinutes);
        return Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? Math.floor(parsedMinutes * 60) : null;
    }
    return null;
}

function getMinuteCounterSettings(serviceId = null) {
    const runtime = getServiceRuntime(serviceId);
    const limitSeconds = getMinuteLimitSeconds(runtime);
    if (!runtime?.id || !limitSeconds) return null;
    return {
        serviceId: runtime.id,
        limitSeconds,
    };
}

function getMinuteCounterIdentity(parsedFrom, session) {
    const rawFull = String(parsedFrom?.full || session?.callerEns || "").trim().toLowerCase();
    if (rawFull.endsWith(".global")) return rawFull;

    const runtime = getServiceRuntime(session?.serviceId || null);
    const domains = Array.isArray(runtime?.serviceConstants?.domains) ? runtime.serviceConstants.domains : [];
    const domain = domains[0] || runtime?.primaryDomain || "";
    const label = normalizePhone(parsedFrom?.value || rawFull).trim().toLowerCase();
    if (!label || !domain) return rawFull || label;
    return `${label}.${domain}`;
}

function getAllServiceDomains() {
    const domains = [];
    for (const runtime of Object.values(serviceRuntimes)) {
        const configured = Array.isArray(runtime.serviceConstants?.domains)
            ? runtime.serviceConstants.domains
            : [];
        if (configured.length > 0) domains.push(...configured);
        else {
            if (runtime.primaryDomain) domains.push(runtime.primaryDomain);
            if (Array.isArray(runtime.domainAliases)) domains.push(...runtime.domainAliases);
        }
    }
    return Array.from(new Set(domains.filter(Boolean)));
}

async function tryInternalWebrtcLookup(label, targetDomains = []) {
    const normalized = normalizePhone(label);
    for (const domain of targetDomains || []) {
        const ensName = `${normalized}.${domain}`;
        try {
            const addr = await resolveEnsToAddress(ensName);
            if (addr && addr !== zeroAddress) {
                return { route: "webrtc", wallet: addr, ensName };
            }
        } catch (_) {}
    }
    return null;
}

function selectInboundLookupValue({ payload, lookupField }) {
    const field = lookupField === "diversion" ? "diversion" : "to";
    return payload?.[field] || null;
}

function buildInboundCandidates({ value, domains = [] }) {
    const normalized = normalizePhone(value);
    if (!normalized) return [];
    const variants = new Set([normalized]);
    if (normalized.startsWith("0") && normalized.length > 1) variants.add(`972${normalized.slice(1)}`);
    if (normalized.startsWith("972") && normalized.length > 3) variants.add(`0${normalized.slice(3)}`);
    const out = [];
    for (const domain of domains) {
        for (const variant of variants) out.push(`${variant}.${domain}`);
    }
    return out;
}

function getServiceHelpers(serviceRuntime) {
    return {
        zeroAddress,
        getServiceConstants: () => serviceRuntime.serviceConstants || {},
        parseIdentity: (value) => parseAddress(value, serviceRuntime.id),
        normalizePhone,
        normalizeEmail: (value) => String(value || "").trim().toLowerCase(),
        buildEnsLabel: (value) => String(value || "").trim().toLowerCase(),
        formatProviderEns: (label, domain) => `${label}.${domain}`,
        lookupEnsOwner: (...args) => blockchainApi.resolveEnsToOwner(...args),
        lookupEnsAddress: (...args) => resolveEnsToAddress(...args),
        lookupEnsTextRecord: (...args) => blockchainApi.resolveEnsTextRecord(...args),
        lookupNftOwnedNumber: (...args) => blockchainApi.nftGetOwnedNumber(...args),
        lookupBusinessNumber: (...args) => callRouterApi.roflFindBusinessNumber(...args),
        lookupBusinessNumberCascade: (...args) => callRouterApi.roflCascadingBusinessLookup(...args),
        assignPoolFromNumber: (...args) => callRouterApi.roflAssignFromNumber(...args),
        getProviderForDomain: (domain) => {
            if (!domain) return null;
            const configured = Array.isArray(serviceRuntime.serviceConstants?.domains)
                ? serviceRuntime.serviceConstants.domains
                : [serviceRuntime.primaryDomain, ...(serviceRuntime.domainAliases || [])];
            if (configured.includes(domain)) return serviceRuntime.providerId;
            return null;
        },
        extractInboundFields: (payload) => payload || {},
        buildInboundCandidates,
        findLinkedOutboundSession: (...args) => findOutboundSessionForInbound(...args),
        selectInboundLookupValue,
        notifyAndWakeUser: async (input) => {
            let message = input.message;
            if (serviceRuntime.shapeNotifyPayload) {
                message = await serviceRuntime.shapeNotifyPayload({
                    serviceId: serviceRuntime.id,
                    providerId: serviceRuntime.providerId,
                    message: input.message,
                    payload: input.payload || null,
                    helpers: getServiceHelpers(serviceRuntime),
                });
            }
            return sendNotification(input.callerEns, input.calleeEns, message, input.notificationType);
        },
        forwardInviteToKamailio: async (input) => openSipSession(input.sessionId, input.sipFrom, input.sipTo),
        openInboundSipLeg: async (input) => openInboundSipSession(input.sessionId, input.phoneNumber),
        bridgeWebrtcSessions: async (input) => notifyAndBridge(input.sessionId, input.destination),
        buildCallerIdPayload: (input) => input,
        sendAck,
        sendAnswer,
        sendAckAndAnswer,
        sendDataChannelMessage,
        endCall: (sessionId, reason) => handleCallEnd(sessionId, reason, true),
        logRouteDecision: (entry) => console.log("[ServiceRoute]", entry),
        emitServiceMetric: (metric) => console.log("[ServiceMetric]", metric),
        getAllServiceDomains,
        getFirstServiceDomain: () => {
            const configured = Array.isArray(serviceRuntime.serviceConstants?.domains)
                ? serviceRuntime.serviceConstants.domains
                : [];
            return configured[0] || serviceRuntime.primaryDomain || getAllServiceDomains()[0] || "";
        },
        tryInternalWebrtcLookup: (label, targetDomains = []) => tryInternalWebrtcLookup(label, targetDomains),
        emailToEnsName,
    };
}

async function resolveDestination(parsedTo, parsedFrom = null, serviceId = null) {
    const runtime = getServiceRuntime(serviceId);
    if (!runtime || typeof runtime.resolveDestination !== "function") {
        return { route: "reject", reason: "Missing service resolver" };
    }
    return runtime.resolveDestination({
        serviceId: runtime.id,
        providerId: runtime.providerId,
        parsedTo,
        parsedFrom,
        helpers: getServiceHelpers(runtime),
    });
}

async function resolveCallerId(parsedFrom, walletAddress, serviceId = null) {
    const runtime = getServiceRuntime(serviceId);
    if (!runtime || typeof runtime.resolveCallerId !== "function") {
        return { callerId: parsedFrom?.full || parsedFrom?.value || null, privateId: null };
    }
    return runtime.resolveCallerId({
        serviceId: runtime.id,
        providerId: runtime.providerId,
        parsedFrom,
        walletAddress,
        helpers: getServiceHelpers(runtime),
    });
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
    notiTypeCall: NOTI_TYPE_CALL,
    crypto,
    logger: console,
});
const offerFlowApi = createOfferFlow({
    sessions,
    sessionsByUser,
    stableKey: (...args) => stableKey(...args),
    createSession: (...args) => createSession(...args),
    destroySession: (...args) => destroySession(...args),
    handleHandshake: (...args) => handleHandshake(...args),
    handleInboundAnswer: (...args) => handleInboundAnswer(...args),
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
    logger: console,
});
const callRuntimeCoreApi = createCallRuntimeCore({
    sessions,
    MediaStreamTrack,
    patchInactiveToSendrecv: (...args) => patchInactiveToSendrecv(...args),
    logSdp: (...args) => logSdp(...args),
    enqueueSignaling: (...args) => enqueueSignaling(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    resolveCallerId: (...args) => resolveCallerId(...args),
    openSipSession: (...args) => openSipSession(...args),
    openOpenAiSipSession: (...args) => openOpenAiSipSession(...args),
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    notifyAndBridgeMulti: (...args) => notifyAndBridgeMulti(...args),
    startIvrSession: (sessionId, destination) =>
        ivrRuntimeApi.startIvr(sessionId, {
            route: destination?.route || "ivr",
            source: "outbound-route",
            target: destination?.target || "",
        }),
    minuteCounter: minuteCounterApi,
    getMinuteCounterSettings: (...args) => getMinuteCounterSettings(...args),
    getMinuteCounterIdentity: (...args) => getMinuteCounterIdentity(...args),
    logger: console,
});
// TEMPORARY:
// For test flows where clients do not yet send xdata/xsign on /notify,
// keep notify signature enforcement disabled by default.
// Set ENFORCE_NOTIFY_SIGNATURES=true to re-enable strict verification.
const enforceNotifySignatures =
    String(process.env.ENFORCE_NOTIFY_SIGNATURES || "false").toLowerCase() === "true";
if (!enforceNotifySignatures) {
    console.warn("[SECURITY] /notify signature verification is temporarily DISABLED");
}
const signalingPipelineApi = createSignalingPipeline({
    onIncomingOffer: (...args) => onIncomingOffer(...args),
    handleInboundCallRequest: (...args) => handleInboundCallRequest(...args),
    verifyHttpNotifySignature: (...args) => verifyHttpSignalingSignature(...args),
    createHttpError: (...args) => createHttpError(...args),
    enforceNotifySignatures,
});


// Call routing implementation moved to modules/callRouter.js.


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
    return handshakeFlowApi.handleHandshake(sessionId, fromEns, toIdentity, offerSdp, candidates, callNonce);
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
function createPeerConnection(sessionId) {
    return peerConnectionApi.createPeerConnection(sessionId);
}

/**
 * Called when the data channel opens after the handshake completes.
 */
function onDataChannelOpen(sessionId) {
    return callFlowApi.onDataChannelOpen(sessionId, {
        checkPendingBridge: (...args) => checkPendingBridge(...args),
        checkPendingInboundCall: (...args) => checkPendingInboundCall(...args),
        sendInboundRing: (...args) => sendInboundRing(...args),
        destroySession: (...args) => destroySession(...args),
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
    return callFlowApi.sendInboundRing(sessionId);
}

/**
 * Gateway-as-caller: callee responded to RING with an audio answer SDP via data channel.
 * Apply the answer and open the SIP leg to resume the suspended Kamailio INVITE.
 */
async function handleInboundCalleeAnswer(sessionId, payload) {
    return callFlowApi.handleInboundCalleeAnswer(sessionId, payload);
}

async function handleOutboundWebrtcLegAnswer(sessionId, payload) {
    const session = sessions.get(sessionId);
    if (!session || !session.outboundWebrtcLeg) return null;
    await callFlowApi.handleOutboundWebrtcLegAnswer(sessionId, payload);
    console.log(`[Bridge] outbound WebRTC pickup observed sessionId=${sessionId} kind=${session.outboundBridgeKind || "unknown"}`);
    if (session.multiRingLeg) {
        const winner = bridgeApi.commitWinnerFromDataChannelAnswer(sessionId);
        return winner || null;
    }
    return bridgeApi.commitWebrtcBridgePickup(sessionId);
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
function onDataChannelMessage(sessionId, rawMessage) {
    return signalingHandlersApi.onDataChannelMessage(sessionId, rawMessage);
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
    return callFlowApi.handleRing(sessionId, payload);
}

/**
 * Called when the client answers a server-initiated re-offer (Phase 2).
 * Since the call is already routed (SIP session opened in Phase 1),
 * this just applies the answer to PC1 to fix currentDirection.
 */
async function handleReofferAnswer(sessionId, payload) {
    return callFlowApi.handleReofferAnswer(sessionId, payload);
}

/**
 * WebRTC-to-WebRTC bridge: notifies the callee to connect, waits for them,
 * then pipes audio between the caller's PC1 and the callee's PC1.
 */
async function notifyAndBridge(callerSessionId, destination) {
    return bridgeApi.notifyAndBridge(callerSessionId, destination);
}

async function notifyAndBridgeMulti(callerSessionId, destinations) {
    return bridgeApi.notifyAndBridgeMulti(callerSessionId, destinations);
}

async function redirectIvrSessionToWebrtc(sessionId, targetEns, { reason = "ivr-redirect", waitingAudioFile = null } = {}) {
    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`[${sessionId}] IVR redirect skipped: session missing target=${targetEns}`);
        return false;
    }

    const serviceId = session.serviceId || "secnum";
    const parsedTo = parseAddress(targetEns, serviceId);
    const parsedFrom = parseAddress(session.callerEns, serviceId);
    const destination = await resolveDestination(parsedTo, parsedFrom, serviceId);
    if (destination?.route !== "webrtc") {
        console.warn(
            `[${sessionId}] IVR redirect rejected target=${targetEns} ` +
            `route=${destination?.route || "n/a"} reason=${destination?.reason || "not-webrtc"}`
        );
        return false;
    }

    console.log(`[${sessionId}] IVR redirect target=${targetEns} wallet=${destination.wallet} reason=${reason}`);
    const waitingFile = waitingAudioFile || session.ivr?.waitingAudioFile || null;
    try {
        if (waitingFile) {
            await ivrAudioPlaybackApi.playFile(sessionId, waitingFile, {
                interrupt: true,
                reason: `redirect-waiting:${reason}`,
                loop: true,
            });
            console.log(`[${sessionId}] IVR redirect waiting audio started file=${waitingFile}`);
        }
        await notifyAndBridge(sessionId, destination);
        return true;
    } catch (err) {
        console.warn(`[${sessionId}] IVR redirect failed target=${targetEns} reason=${reason} err=${err.message}`);
        return false;
    } finally {
        ivrRuntimeApi.stopIvr(sessionId, `redirect:${reason}`);
        await ivrAudioPlaybackApi.stopSessionPlayback(sessionId, `redirect:${reason}`);
    }
}

function normalizeOpenAiTransferTarget(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withoutSip = raw.replace(/^sip:/i, "").split(";")[0].split("@")[0].trim();
    if (withoutSip.toLowerCase().endsWith(".global")) return withoutSip.toLowerCase();

    let number = withoutSip.replace(/[^\d+*]/g, "");
    if (number.startsWith("*")) return `*${number.slice(1).replace(/\D/g, "")}`;
    if (number.startsWith("+")) return `+${number.slice(1).replace(/\D/g, "")}`;
    number = number.replace(/\D/g, "");
    return number;
}

function isSessionEnded(session) {
    return !session || session.phase === "post-call" || session.callEndInProgress === true;
}

function createOpenAiTransferToken() {
    return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function getIdentityLabel(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withoutSip = raw.replace(/^sip:/i, "").split(";")[0].split("@")[0].trim();
    const dotPos = withoutSip.indexOf(".");
    return (dotPos > 0 ? withoutSip.slice(0, dotPos) : withoutSip).replace(/^\+/, "");
}

function shouldStartOpenAiSalesAgent(session, payload, parsedFrom) {
    if (!session || session.openAiSalesAgentTriggerHandled) return false;
    const trigger = String(OPENAI_SALES_TRIGGER_CALLER || "").replace(/^\+/, "");
    if (!trigger) return false;
    const candidates = [
        parsedFrom?.value,
        parsedFrom?.full,
        session.callerEns,
        payload?.from,
    ].map(getIdentityLabel).filter(Boolean);
    return candidates.includes(trigger);
}

function getAudioReceiverTracksFromPeerConnection(pc) {
    const out = [];
    const seen = new Set();
    const addTrack = (track) => {
        if (!track || track.kind !== "audio" || seen.has(track)) return;
        seen.add(track);
        out.push(track);
    };
    if (pc?.getReceivers) {
        for (const receiver of pc.getReceivers()) {
            addTrack(receiver?.track);
        }
    }
    if (pc?.getTransceivers) {
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver?.kind !== "audio") continue;
            if (Array.isArray(transceiver.receiver?.tracks)) {
                for (const track of transceiver.receiver.tracks) addTrack(track);
            } else {
                addTrack(transceiver.receiver?.track);
            }
        }
    }
    return out;
}

function parsePrimaryAudioPayloadType(sdp) {
    const audioSection = String(sdp || "").match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
    const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
    const pt = Number(mLine.split(/\s+/).slice(3)[0]);
    return Number.isFinite(pt) ? pt : null;
}

function payloadTypeFromPolicy(policy) {
    if (policy === "pcmu") return 0;
    if (policy === "pcma") return 8;
    return null;
}

function deriveSalesTargetPayloadType(session, source) {
    if (source === "sbc") {
        return (
            parsePrimaryAudioPayloadType(session?.sipPeerConnection?.remoteDescription?.sdp) ??
            parsePrimaryAudioPayloadType(session?.sipPeerConnection?.localDescription?.sdp)
        );
    }
    return (
        payloadTypeFromPolicy(session?.mediaCodecPolicy) ??
        parsePrimaryAudioPayloadType(session?.peerConnection?.localDescription?.sdp)
    );
}

function muLawToLinear(value) {
    const u = (~value) & 0xff;
    let sample = ((u & 0x0f) << 3) + 0x84;
    sample <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (0x84 - sample) : (sample - 0x84);
}

function linearToMuLaw(sample) {
    const sign = sample < 0 ? 0x80 : 0;
    let magnitude = Math.min(32635, Math.abs(sample)) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent -= 1;
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function aLawToLinear(value) {
    const a = value ^ 0x55;
    let sample = (a & 0x0f) << 4;
    const segment = (a & 0x70) >> 4;
    if (segment === 0) sample += 8;
    else if (segment === 1) sample += 0x108;
    else {
        sample += 0x108;
        sample <<= segment - 1;
    }
    return (a & 0x80) ? sample : -sample;
}

function linearToALaw(sample) {
    const sign = sample < 0 ? 0x00 : 0x80;
    let magnitude = Math.min(32635, Math.abs(sample));
    let encoded;
    if (magnitude < 256) {
        encoded = sign | (magnitude >> 4);
    } else {
        let exponent = 7;
        for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent -= 1;
        encoded = sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 0x0f);
    }
    return encoded ^ 0x55;
}

function transcodeG711Payload(payload, fromPt, toPt) {
    if (!payload || fromPt === toPt) return payload;
    if (!((fromPt === 0 && toPt === 8) || (fromPt === 8 && toPt === 0))) return payload;
    const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const converted = Buffer.allocUnsafe(source.length);
    if (fromPt === 0) {
        for (let i = 0; i < source.length; i += 1) converted[i] = linearToALaw(muLawToLinear(source[i]));
    } else {
        for (let i = 0; i < source.length; i += 1) converted[i] = linearToMuLaw(aLawToLinear(source[i]));
    }
    return converted;
}

function adaptSalesRtpPacket(rtp, targetPt) {
    const sourcePt = Number(rtp?.header?.payloadType);
    if (!rtp || !rtp.header || !Number.isFinite(sourcePt) || !Number.isFinite(targetPt)) return rtp;
    if (sourcePt === targetPt) return rtp;
    const convertedPayload = transcodeG711Payload(rtp.payload, sourcePt, targetPt);
    if (convertedPayload === rtp.payload && !((sourcePt === 0 && targetPt === 8) || (sourcePt === 8 && targetPt === 0))) {
        return rtp;
    }
    const packet = Object.assign(Object.create(Object.getPrototypeOf(rtp)), rtp);
    packet.header = Object.assign(Object.create(Object.getPrototypeOf(rtp.header)), rtp.header);
    packet.header.payloadType = targetPt;
    packet.payload = convertedPayload;
    return packet;
}

function createOpenAiSalesMediaAdapter(targetSessionId, { source = "webrtc" } = {}) {
    let openAiSourceNotified = false;
    return {
        writeOpenAiRtp(packet) {
            const targetSession = sessions.get(targetSessionId);
            const targetTrack = source === "sbc" ? targetSession?.sipLocalAudioTrack : targetSession?.localAudioTrack;
            if (!targetTrack || !packet?.header) return;
            const targetPt = deriveSalesTargetPayloadType(targetSession, source);
            const outgoing = adaptSalesRtpPacket(packet, targetPt);
            if (!openAiSourceNotified) {
                openAiSourceNotified = true;
                targetTrack.onSourceChanged.execute({
                    sequenceNumber: outgoing.header.sequenceNumber,
                    timestamp: outgoing.header.timestamp,
                });
            }
            targetTrack.writeRtp(outgoing);
        },
        subscribeSourceRtp(forwardRtp) {
            const targetSession = sessions.get(targetSessionId);
            const pc = source === "sbc" ? targetSession?.sipPeerConnection : targetSession?.peerConnection;
            const openAiPayloadType = 0;
            const disposers = [];
            const subscribed = new Set();

            const subscribeTrack = (track) => {
                if (!track || track.kind !== "audio" || !track.onReceiveRtp?.subscribe || subscribed.has(track)) return;
                subscribed.add(track);
                const sub = track.onReceiveRtp.subscribe((rtp) => forwardRtp(adaptSalesRtpPacket(rtp, openAiPayloadType)));
                if (sub?.unSubscribe) disposers.push(() => sub.unSubscribe());
            };

            for (const track of getAudioReceiverTracksFromPeerConnection(pc)) {
                subscribeTrack(track);
            }

            const onTrackSub = pc?.onTrack?.subscribe?.((track) => subscribeTrack(track));
            if (onTrackSub?.unSubscribe) disposers.push(() => onTrackSub.unSubscribe());

            console.log(
                `[${targetSessionId}] OpenAI sales media adapter attached source=${source} ` +
                `tracks=${subscribed.size}`,
            );
            return () => {
                for (const dispose of disposers) {
                    try { dispose(); } catch (_) {}
                }
            };
        },
    };
}

async function endOpenAiSalesTarget(salesSessionId, targetSessionId, reason = "openai-sales-ended") {
    const target = sessions.get(targetSessionId);
    if (target && target.phase !== "post-call") {
        try {
            sendDataChannelMessage(targetSessionId, { msgType: "call", action: "end", reason });
        } catch (_) {}
        target.phase = "post-call";
    }
    if (targetSessionId !== salesSessionId) {
        destroySession(targetSessionId, false);
    }
    const sales = sessions.get(salesSessionId);
    if (sales) {
        sales.phase = "post-call";
        if (targetSessionId === salesSessionId) {
            await sipClientApi.closeSipSession(salesSessionId, sessionStore).catch(() => {});
        }
        destroySession(salesSessionId, false);
    }
}

async function startOpenAiSalesAgentFlow({
    triggerSessionId,
    triggerSession,
    payload,
    parsedTo,
    destination,
} = {}) {
    const serviceId = triggerSession?.serviceId || "secnum";
    const targetIdentity = payload?.to || triggerSession?.toIdentity || parsedTo?.full || parsedTo?.value || "";
    const salesSessionId = `${triggerSessionId}-openai-sales-${Date.now()}`;
    const parsedSalesFrom = parseAddress(OPENAI_SALES_AGENT_FROM, serviceId);

    if (sessions.has(triggerSessionId)) {
        setTimeout(() => {
            const trigger = sessions.get(triggerSessionId);
            if (!trigger || trigger.endCallRenegDone === true) return;
            console.warn(`[${triggerSessionId}] OpenAI sales-agent trigger fallback destroy after missing end-call renegotiation`);
            destroySession(triggerSessionId, false);
        }, 10000);
    }
    if (!destination || destination.route === "reject" || destination.route === "openai-sip" || destination.route === "ivr") {
        console.warn(
            `[${triggerSessionId}] OpenAI sales-agent target rejected ` +
            `target=${targetIdentity} route=${destination?.route || "none"}`,
        );
        return;
    }

    const salesSession = createSession(salesSessionId, OPENAI_SALES_AGENT_FROM, targetIdentity);
    salesSession.serviceId = serviceId;
    salesSession.phase = "ringing";
    salesSession.mediaCodecPolicy = "pcmu";
    salesSession.openAiSalesAgent = {
        triggerSessionId,
        targetIdentity,
        route: destination.route,
        startedAt: Date.now(),
    };

    let targetSessionId = salesSessionId;
    let mediaSource = "sbc";
    try {
        console.log(
            `[${salesSessionId}] OpenAI sales-agent dialing target=${targetIdentity} ` +
            `route=${destination.route} from=${OPENAI_SALES_AGENT_FROM}`,
        );
        if (destination.route === "webrtc") {
            targetSessionId = await notifyAndBridge(salesSessionId, destination);
            mediaSource = "webrtc";
        } else if (destination.route === "webrtc-multiring") {
            targetSessionId = await notifyAndBridgeMulti(salesSessionId, destination.targets || []);
            bridgeApi.startPendingMultiBridge(salesSessionId);
            mediaSource = "webrtc";
        } else if (destination.route === "sbc") {
            await routeCall(salesSessionId, salesSession, destination, parsedSalesFrom);
            mediaSource = "sbc";
        } else {
            throw new Error(`unsupported OpenAI sales-agent route: ${destination.route}`);
        }

        const currentSalesSession = sessions.get(salesSessionId);
        const targetSession = sessions.get(targetSessionId);
        if (!currentSalesSession || !targetSession) {
            throw new Error("sales-agent callee session disappeared before OpenAI attach");
        }
        currentSalesSession.phase = "in-call";
        targetSession.phase = "in-call";

        const sipSession = currentSalesSession.sipConnection?.inviter || currentSalesSession.sipConnection?.invitation || null;
        if (mediaSource === "sbc" && sipSession?.stateChange?.addListener) {
            sipSession.stateChange.addListener((state) => {
                if (state !== SessionState.Terminated) return;
                openAiSipGatewayApi.closeOpenAiSipSession(salesSessionId).catch(() => {});
            });
        }

        await openOpenAiSipSession(salesSessionId, {
            callerEns: OPENAI_SALES_AGENT_FROM,
            mode: "sales-agent",
            headers: {
                "X-Arnacon-AI-Mode": "sales-agent",
                "X-Arnacon-Session-Id": salesSessionId,
                "X-Arnacon-Trigger-Session-Id": triggerSessionId,
                "X-Arnacon-Original-To": targetIdentity,
            },
            mediaAdapter: createOpenAiSalesMediaAdapter(targetSessionId, { source: mediaSource }),
            onRemoteBye: (reason) => endOpenAiSalesTarget(salesSessionId, targetSessionId, reason),
        });
        console.log(
            `[${salesSessionId}] OpenAI sales-agent active targetSessionId=${targetSessionId} ` +
            `source=${mediaSource}`,
        );
    } catch (err) {
        console.warn(`[${salesSessionId}] OpenAI sales-agent failed: ${err.message}`);
        await closeSipSession(salesSessionId).catch(() => {});
        if (targetSessionId && targetSessionId !== salesSessionId) {
            try {
                sendDataChannelMessage(targetSessionId, {
                    msgType: "call",
                    action: "end",
                    reason: "openai-sales-agent-failed",
                });
            } catch (_) {}
            destroySession(targetSessionId, false);
        }
        destroySession(salesSessionId, false);
    }
}

async function transferOpenAiCallRequest({
    sessionId,
    sipCallId = null,
    openAiCallId = null,
    target,
    label = null,
    reason = "openai-transfer-call",
} = {}) {
    const session = sessions.get(sessionId);
    if (!session || !session.peerConnection) {
        throw Object.assign(new Error("transfer session not found"), { statusCode: 404 });
    }
    if (session.openAiTransferInProgress) {
        throw Object.assign(new Error("transfer already in progress"), { statusCode: 409 });
    }

    const normalizedTarget = normalizeOpenAiTransferTarget(target);
    if (
        !normalizedTarget ||
        (
            !normalizedTarget.endsWith(".global") &&
            !/^(?:\+?\d{3,18}|\*\d{2,18})$/.test(normalizedTarget)
        )
    ) {
        throw Object.assign(new Error(`invalid transfer target: ${target}`), { statusCode: 400 });
    }

    const serviceId = session.serviceId || "secnum";
    const parsedTo = parseAddress(normalizedTarget, serviceId);
    const parsedFrom = parseAddress(session.callerEns, serviceId);
    const destination = await resolveDestination(parsedTo, parsedFrom, serviceId);
    if (!destination || destination.route === "reject") {
        throw Object.assign(
            new Error(destination?.reason || `transfer target rejected: ${normalizedTarget}`),
            { statusCode: 400 },
        );
    }
    if (destination.route === "openai-sip" || destination.route === "ivr") {
        throw Object.assign(
            new Error(`unsupported transfer route: ${destination.route}`),
            { statusCode: 400 },
        );
    }

    console.log(
        `[${sessionId}] OpenAI transfer requested target=${normalizedTarget} ` +
        `route=${destination.route} label=${label || ""} reason=${reason} ` +
        `openAiCallId=${openAiCallId || ""} sipCallId=${sipCallId || ""}`,
    );

    session.openAiTransferInProgress = {
        id: createOpenAiTransferToken(),
        target: normalizedTarget,
        route: destination.route,
        label,
        reason,
        requestedAt: Date.now(),
        openAiCallId,
        sipCallId,
    };
    const transferState = session.openAiTransferInProgress;

    try {
        if (isSessionEnded(session)) {
            if (session.openAiTransferInProgress === transferState) {
                session.openAiTransferInProgress = null;
            }
            console.log(
                `[${sessionId}] OpenAI transfer cancelled before dial target=${normalizedTarget} ` +
                `route=${destination.route}`,
            );
            return {
                status: "cancelled",
                route: destination.route,
                target: normalizedTarget,
                label,
                reason,
            };
        }
        session.callEndInProgress = false;
        session.phase = "ringing";
        console.log(
            `[${sessionId}] OpenAI transfer accepted target=${normalizedTarget} ` +
            `route=${destination.route}; closing OpenAI and starting destination dial`,
        );
        setImmediate(() => {
            runOpenAiTransferDial({
                sessionId,
                transferState,
                destination,
                parsedFrom,
            }).catch((err) => {
                console.warn(`[${sessionId}] OpenAI transfer dial worker crashed: ${err.message}`);
            });
        });
        return {
            status: "dialing",
            route: destination.route,
            target: normalizedTarget,
            label,
            reason,
        };
    } catch (err) {
        console.warn(
            `[${sessionId}] OpenAI transfer failed target=${normalizedTarget} ` +
            `route=${destination.route} err=${err.message}`,
        );
        if (session.openAiTransferInProgress === transferState) {
            session.openAiTransferInProgress = null;
        }
        throw err;
    }
}

async function runOpenAiTransferDial({
    sessionId,
    transferState,
    destination,
    parsedFrom,
}) {
    const initialSession = sessions.get(sessionId);
    if (!initialSession || initialSession.openAiTransferInProgress !== transferState) return;

    try {
        await openAiSipGatewayApi.closeOpenAiSipSession(sessionId);
        stopMediaRelay(sessionId);
        if (
            isSessionEnded(initialSession) ||
            !initialSession.peerConnection ||
            initialSession.openAiTransferInProgress !== transferState
        ) {
            console.log(
                `[${sessionId}] OpenAI transfer cancelled before destination dial ` +
                `target=${transferState.target} route=${destination.route}`,
            );
            return;
        }
        const routeResult = await routeCall(sessionId, initialSession, destination, parsedFrom);
        const session = sessions.get(sessionId);
        if (
            isSessionEnded(session) ||
            !session.peerConnection ||
            session.openAiTransferInProgress !== transferState
        ) {
            await closeSipSession(sessionId);
            stopMediaRelay(sessionId);
            console.log(
                `[${sessionId}] OpenAI transfer dial answered after caller ended; ` +
                `torn down target=${transferState.target} route=${destination.route}`,
            );
            return;
        }

        session.phase = "in-call";
        if (destination.route === "webrtc-multiring") {
            bridgeApi.startPendingMultiBridge(sessionId);
        }
        if (routeResult === "sbc") {
            startMediaRelay(sessionId);
        }
        console.log(
            `[${sessionId}] OpenAI transfer committed target=${transferState.target} ` +
            `route=${destination.route} routeResult=${routeResult || ""}`,
        );
    } catch (err) {
        const session = sessions.get(sessionId);
        console.warn(
            `[${sessionId}] OpenAI transfer failed target=${transferState.target} ` +
            `route=${destination.route} err=${err.message}`,
        );
        if (session && session.openAiTransferInProgress === transferState && !isSessionEnded(session)) {
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason: "openai-transfer-failed" });
            session.phase = "post-call";
        }
    } finally {
        const session = sessions.get(sessionId);
        if (session?.openAiTransferInProgress === transferState) {
            session.openAiTransferInProgress = null;
        }
    }
}

async function onVerifiedNotifyAnswer(sessionId, offer, session) {
    if (!session || !session.outboundWebrtcLeg) return null;

    session.outboundLegHttpAnswered = true;
    console.log(
        `[Bridge] outbound WebRTC stage1 HTTP answer observed ` +
        `sessionId=${sessionId} kind=${session.outboundBridgeKind || "unknown"}`
    );

    let observed = { handled: true };
    if (session.multiRingLeg) {
        observed = bridgeApi.commitWinnerFromAnswer(sessionId);
        if (!observed || !observed.handled) return null;
    }

    try {
        await callFlowApi.triggerOutboundWebrtcLegRing(sessionId, destroySession);
    } catch (err) {
        console.error(`[${sessionId}] Failed outbound stage1->stage2 ring trigger: ${err.message}`);
    }
    return {
        ok: true,
        handled: true,
        sessionId,
        pickedUp: false,
        won: false,
    };
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
    return sipClientApi.openSipSession(sessionId, sessionStore, { callerEns, calleeIdentity, sipDirective });
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
    return sipClientApi.openInboundSipSession(sessionId, sessionStore, { phoneNumber });
}

/**
 * Starts relaying audio between PC1 (client) and PC2 (Kamailio/sip.js)
 * by piping raw RTP packets between the two PeerConnections.
 *
 *   Client audio → PC1 remote track → onReceiveRtp → PC2 local track → writeRtp → Kamailio
 *   Kamailio audio → PC2 remote track → onReceiveRtp → PC1 local track → writeRtp → Client
 */
function startMediaRelay(sessionId) {
    return peerConnectionApi.startMediaRelay(sessionId);
}

/**
 * Stops the media relay for a session.
 */
function stopMediaRelay(sessionId) {
    return peerConnectionApi.stopMediaRelay(sessionId);
}

/**
 * Called when the client sends an end-call message over the data channel.
 * Tears down the SIP leg (PC2) and media relay. Does NOT touch PC1 —
 * the client will send a renegotiation offer to drop audio from PC1.
 */
async function handleCallEnd(sessionId, reason = "client-initiated", propagate = true) {
    ivrRuntimeApi.stopIvr(sessionId, reason);
    await ivrAudioPlaybackApi.stopSessionPlayback(sessionId, reason);
    return callFlowApi.handleCallEnd(sessionId, reason, propagate);
}

async function handleCallDtmf(sessionId, msg) {
    if (await ivrRuntimeApi.handleDtmf(sessionId, msg)) {
        return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`[${sessionId}] DTMF ignored: session not found`);
        return;
    }

    const rawDigit = String(msg?.digit ?? "").trim();
    if (!/^[0-9*#ABCD]$/i.test(rawDigit)) {
        console.warn(`[${sessionId}] DTMF ignored: invalid digit "${rawDigit}"`);
        return;
    }
    const digit = rawDigit.toUpperCase();

    const rawDuration = Number(msg?.durationMs);
    const durationMs = Number.isFinite(rawDuration)
        ? Math.max(70, Math.min(6000, Math.floor(rawDuration)))
        : 160;

    const sipSession = session.sipConnection?.inviter || session.sipConnection?.invitation || null;
    if (!sipSession) {
        console.warn(`[${sessionId}] DTMF ignored: no active SIP session`);
        return;
    }

    try {
        // Prefer native helpers when available (transport/method handled by SIP stack).
        if (typeof sipSession.sendDtmf === "function") {
            await sipSession.sendDtmf(digit, { duration: durationMs });
        } else if (typeof sipSession.dtmf === "function") {
            await sipSession.dtmf(digit, { duration: durationMs });
        } else if (typeof sipSession.info === "function") {
            // Fallback: SIP INFO with application/dtmf-relay body.
            const infoBody = `Signal=${digit}\r\nDuration=${durationMs}\r\n`;
            let infoSent = false;

            try {
                await sipSession.info({
                    requestOptions: {
                        extraHeaders: ["Content-Type: application/dtmf-relay"],
                        body: {
                            contentType: "application/dtmf-relay",
                            content: infoBody,
                        },
                    },
                });
                infoSent = true;
            } catch (_) {}

            if (!infoSent) {
                try {
                    await sipSession.info({
                        requestOptions: {
                            extraHeaders: ["Content-Type: application/dtmf-relay"],
                            body: infoBody,
                        },
                    });
                    infoSent = true;
                } catch (_) {}
            }

            if (!infoSent) {
                await sipSession.info(infoBody, "application/dtmf-relay");
            }
        } else {
            throw new Error("no supported SIP DTMF method on session");
        }

        sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "ack",
            ackFor: "dtmf",
            digit,
            durationMs,
            eventId: msg?.eventId || null,
        });
        console.log(`[${sessionId}] DTMF relayed to SIP: digit=${digit} durationMs=${durationMs}`);
    } catch (err) {
        console.error(`[${sessionId}] DTMF relay failed: ${err.message}`);
    }
}

/**
 * Handles end-call renegotiation — client wants to drop audio but keep the data channel.
 */
async function handleEndCallRenegotiation(sessionId, payload) {
    return callFlowApi.handleEndCallRenegotiation(sessionId, payload);
}

/**
 * Closes the SIP session — sends BYE via sip.js, tears down UserAgent.
 */
async function closeSipSession(sessionId) {
    minuteCounterApi.finish(sessions.get(sessionId));
    await openAiSipGatewayApi.closeOpenAiSipSession(sessionId);
    return sipClientApi.closeSipSession(sessionId, sessionStore);
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


// Blockchain and notification-plan implementations moved to modules/blockchain.js and modules/notification.js.


// ═════════════════════════════════════════════════════════════
// LEGACY NOTIFICATION FLOW (fallback)
// ═════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════
// SESSION STATE
// ═════════════════════════════════════════════════════════════

function createSession(sessionId, callerEns, toIdentity) {
    return sessionStore.createSession(sessionId, callerEns, toIdentity, console);
}

function destroySession(sessionId, notify = false) {
    minuteCounterApi.finish(sessions.get(sessionId));
    ivrRuntimeApi.stopIvr(sessionId, "session-destroyed");
    ivrAudioPlaybackApi.stopSessionPlayback(sessionId, "session-destroyed").catch(() => {});
    return sessionStore.destroySession(sessionId, {
        notify,
        sendDataChannelMessage,
        closeSipSession: (id) => sipClientApi.closeSipSession(id, sessionStore),
        logger: console,
    });
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
