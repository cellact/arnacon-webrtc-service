const { WebRtcNegotiation } = require("../../negotiation/WebRtcNegotiation");
const { CallSdpUseCases } = require("../../../useCases/CallSdpUseCases");
const { applyPolyfills } = require("../../../../media/werift/Polyfills");
const {
    fixSdpForWerift,
    waitForIceGathering,
    formatIceCandidates,
    getRelayCandidates,
    embedCandidatesInSdp,
    patchInactiveToSendrecv,
    logSdp,
    addIceCandidates: addIceCandidatesUtil,
} = require("../../../../media/negotiation/SdpUtils");
const { narrowAudioOfferForCodecPolicy } = require("../../../../media/negotiation/SdpCodecNegotiator");

const silentLogger = { log() {}, warn() {}, error() {} };

function ensureWeriftPolyfills() {
    if (globalThis.__polyWeriftTestPolyfillsApplied) return;
    applyPolyfills({ fixSdpForWerift, logger: silentLogger });
    globalThis.__polyWeriftTestPolyfillsApplied = true;
}

function createSignalingRecorder() {
    return {
        sent: [],
        send(message) {
            this.sent.push(message);
        },
        isOpen() {
            return true;
        },
        lastOfType(msgType, action) {
            return [...this.sent].reverse().find(
                (m) => m.msgType === msgType && (action === undefined || m.action === action || m.payload?.type === action),
            );
        },
    };
}

function createProductionLikePrimitives({ sessionMap, logger = silentLogger } = {}) {
    const callSdpUseCases = new CallSdpUseCases({
        sessions: sessionMap,
        MediaStreamTrack: globalThis.MediaStreamTrack,
        patchInactiveToSendrecv,
        logSdp: (_id, _label, _sdp) => {},
        enqueueSignaling: (_sessionId, _label, fn) => Promise.resolve().then(fn),
        sendDataChannelMessage: () => {},
        callRuntime: null,
        logger,
    });
    return {
        RTCSessionDescription: globalThis.RTCSessionDescription,
        MediaStreamTrack: globalThis.MediaStreamTrack,
        waitForIceGathering,
        formatIceCandidates,
        getRelayCandidates,
        embedCandidatesInSdp,
        patchInactiveToSendrecv,
        narrowAudioOfferForCodecPolicy,
        logSdp: (...args) => logSdp(...args, logger),
        addIceCandidates: (...args) => addIceCandidatesUtil(...args, globalThis.RTCIceCandidate),
        ensureLocalAudioTrack: (...args) => callSdpUseCases.ensureLocalAudioTrack(...args),
        createAnswerSdp: (...args) => callSdpUseCases.createAnswerSdp(...args),
    };
}

function buildWeriftNegotiationHarness({
    id = "alice",
    endpoint = "alice.secnum.global",
    sessionId = "alice|bob",
    callerEns = "alice.secnum.global",
    toIdentity = "bob.secnum.global",
    withDataChannel = true,
    withAudioTrack = true,
} = {}) {
    ensureWeriftPolyfills();
    const sessionMap = new Map();
    const pc = new globalThis.RTCPeerConnection({ iceServers: [] });
    if (withDataChannel && typeof pc.createDataChannel === "function") {
        pc.createDataChannel("chat");
    }

    const session = {
        sessionId,
        callerEns,
        toIdentity,
        peerConnection: pc,
        localAudioTrack: null,
        remoteTracks: [],
        iceCandidates: [],
    };
    if (withAudioTrack) {
        session.localAudioTrack = new globalThis.MediaStreamTrack({ kind: "audio" });
        if (typeof pc.addTrack === "function") {
            pc.addTrack(session.localAudioTrack);
        }
    }

    sessionMap.set(sessionId, session);
    const signaling = createSignalingRecorder();
    const primitives = createProductionLikePrimitives({ sessionMap });
    const neg = new WebRtcNegotiation({
        id,
        endpoint,
        session,
        signaling,
        primitives,
        logger: silentLogger,
    });

    const dispose = async () => {
        try { pc.close(); } catch (_) {}
    };

    return { neg, session, signaling, primitives, pc, dispose };
}

module.exports = {
    buildWeriftNegotiationHarness,
    ensureWeriftPolyfills,
    createProductionLikePrimitives,
    createSignalingRecorder,
    silentLogger,
};
