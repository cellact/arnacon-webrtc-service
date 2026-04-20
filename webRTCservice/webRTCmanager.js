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
const { createSignalingPipeline } = require("./modules/signalingPipeline");
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
const NOTI_TYPE_CALL = 1;

// ─── Ephemeral Wallet (for CLIENT_ETH_SIGN steps) ───────────
const ephemeralWallet = ethers.Wallet.createRandom();
console.log(`Ephemeral wallet generated: ${ephemeralWallet.address}`);

// ─── Active Sessions (single injected store) ────────────────
const sessionStore = createSessionStore();
const sessions = sessionStore.sessions;
const sessionsByUser = sessionStore.sessionsByUser; // stableKey(from, to) → sessionId
const pendingBridges = sessionStore.pendingBridges; // callee wallet (lowercase) → { callerSessionId, resolve, reject, timer }
const pendingInboundCalls = sessionStore.pendingInboundCalls; // callee wallet (lowercase) → { fromNumber, toNumber, callId, timer }
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
        `chainId=${roflLogicInfo.chainId || "n/a"} businessDb=${roflLogicInfo.businessNumberDbAddress || "n/a"} ` +
        `callerIdPool=${roflLogicInfo.callerIdPoolAddress || "n/a"} roflAddress=${roflLogicInfo.roflAddress || "n/a"}`,
);
const notificationApi = createNotificationApi({
    blockchainApi,
    signalingPlanAbi: SIGNALING_PLAN_ABI,
    notiTypeCall: NOTI_TYPE_CALL,
    ephemeralWallet,
    logger: console,
    fetchImpl: fetch,
});
const sipRuntimeApi = createSipRuntime({
    sessions,
    stopMediaRelay: (...args) => stopMediaRelay(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    patchRouterForDynamicSsrc: (...args) => peerConnectionApi.patchRouterForDynamicSsrc(...args),
    SessionState,
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
const bridgeApi = createBridgeApi({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    sendNotification: (...args) => sendNotification(...args),
    sendDataChannelMessage: (...args) => sendDataChannelMessage(...args),
    startWebRtcBridge: (...args) => startWebRtcBridge(...args),
    destroySession: (...args) => destroySession(...args),
    notiTypeCall: NOTI_TYPE_CALL,
    RTCSessionDescription,
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
    logger: console,
});
const signalingHandlersApi = createSignalingHandlers({
    sessions,
    handleEndCallRenegotiation: (...args) => handleEndCallRenegotiation(...args),
    handleReofferAnswer: (...args) => handleReofferAnswer(...args),
    handleInboundCalleeAnswer: (...args) => handleInboundCalleeAnswer(...args),
    handleIceRestart: (...args) => handleIceRestart(...args),
    handleRing: (...args) => handleRing(...args),
    handleCallEnd: (...args) => handleCallEnd(...args),
    handleDataMessage: (...args) => messagingFlowApi.handleDataMessage(...args),
    logger: console,
});
const peerConnectionApi = createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers: ICE_SERVERS,
    onDataChannelOpen: (sessionId) => onDataChannelOpen(sessionId),
    onDataChannelMessage: (sessionId, raw) => signalingHandlersApi.onDataChannelMessage(sessionId, raw),
    destroySession: (sessionId, notify) => destroySession(sessionId, notify),
    logger: console,
});

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
    notifyAndBridge: (...args) => notifyAndBridge(...args),
    notifyAndBridgeMulti: (...args) => notifyAndBridgeMulti(...args),
    logger: console,
});
const signalingPipelineApi = createSignalingPipeline({
    onIncomingOffer: (...args) => onIncomingOffer(...args),
    handleInboundCallRequest: (...args) => handleInboundCallRequest(...args),
    verifyHttpNotifySignature: (...args) => verifyHttpSignalingSignature(...args),
    createHttpError: (...args) => createHttpError(...args),
    enforceNotifySignatures: true,
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

async function onVerifiedNotifyAnswer(sessionId, offer, session) {
    const winner = bridgeApi.tryCommitMultiRingWinner(sessionId);
    if (!winner || !winner.handled) return null;
    if (!winner.won) {
        return {
            ok: true,
            ignored: true,
            reason: "multiring-loser",
            type: offer?.type || "answer",
            sessionId,
        };
    }
    console.log(`[${sessionId}] Multi-ring winner selected on verified answer`);
    return {
        ok: true,
        accepted: true,
        reason: "multiring-winner",
        type: offer?.type || "answer",
        sessionId,
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
    return callFlowApi.handleCallEnd(sessionId, reason, propagate);
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
