const { RouteStrategyRegistry } = require("../../routing/strategies/RouteStrategyRegistry");
const { SbcRouteStrategy } = require("../../routing/strategies/SbcRouteStrategy");
const { OpenAiSipRouteStrategy } = require("../../routing/strategies/OpenAiSipRouteStrategy");
const { WebRtcRouteStrategy } = require("../../routing/strategies/WebRtcRouteStrategy");
const { MultiringRouteStrategy } = require("../../routing/strategies/MultiringRouteStrategy");
const { IvrRouteStrategy } = require("../../routing/strategies/IvrRouteStrategy");
const { RejectRouteStrategy } = require("../../routing/strategies/RejectRouteStrategy");

function createRouteStrategies({
    openSipSession,
    closeSipSession,
    resolveCallerId,
    minuteCounter,
    minuteCounterPolicy,
    startMediaRelay,
    stopMediaRelay,
    finishMinuteCounter,
    openOpenAiSipSession,
    closeOpenAiSipSession,
    notifyAndBridge,
    notifyAndBridgeMulti,
    startPendingMultiBridge,
    destroyRuntimeSession,
    startIvrSession,
    stopIvrSession,
    logger = console,
} = {}) {
    const sipRoutePort = {
        open: openSipSession,
        close: closeSipSession,
        resolveCallerId,
        startMedia: startMediaRelay,
        stopMedia: stopMediaRelay,
        sendDtmf: async (context, { digit, durationMs }) => {
            const sipSession = context.resources?.sipLeg?.().getSession();
            if (!sipSession) throw new Error("no active SIP session");
            if (typeof sipSession.sendDtmf === "function") return sipSession.sendDtmf(digit, { duration: durationMs });
            if (typeof sipSession.dtmf === "function") return sipSession.dtmf(digit, { duration: durationMs });
            if (typeof sipSession.info === "function") {
                const infoBody = `Signal=${digit}\r\nDuration=${durationMs}\r\n`;
                try {
                    return await sipSession.info({
                        requestOptions: {
                            extraHeaders: ["Content-Type: application/dtmf-relay"],
                            body: {
                                contentType: "application/dtmf-relay",
                                content: infoBody,
                            },
                        },
                    });
                } catch (_) {
                    return sipSession.info(infoBody, "application/dtmf-relay");
                }
            }
            throw new Error("no supported SIP DTMF method on session");
        },
    };
    const billingPort = {
        counter: minuteCounter,
        policy: minuteCounterPolicy,
        finish: finishMinuteCounter,
    };
    const openAiRoutePort = {
        open: openOpenAiSipSession,
        close: closeOpenAiSipSession,
        resolveCallerId,
        stopMedia: stopMediaRelay,
    };
    const webRtcBridgePort = {
        notifyAndBridge,
        notifyAndBridgeMulti,
        startPendingMultiBridge,
        stopMedia: stopMediaRelay,
        stopSession: (sessionId, reason) => destroyRuntimeSession(sessionId, { source: "webrtc", reason }),
    };
    const ivrRoutePort = {
        start: startIvrSession,
        stop: stopIvrSession,
    };
    const sbcRouteStrategy = new SbcRouteStrategy({
        sipRoutePort,
        billingPort,
        logger,
    });
    const openAiSipRouteStrategy = new OpenAiSipRouteStrategy({
        openAiRoutePort,
        billingPort,
        logger,
    });
    const webRtcRouteStrategy = new WebRtcRouteStrategy({
        webRtcBridgePort,
        logger,
    });
    const multiringRouteStrategy = new MultiringRouteStrategy({
        webRtcBridgePort: {
            ...webRtcBridgePort,
            stopSession: (sessionId, reason) => destroyRuntimeSession(sessionId, { source: "multiring", reason }),
        },
        logger,
    });
    const ivrRouteStrategy = new IvrRouteStrategy({
        ivrRoutePort,
        logger,
    });
    const rejectRouteStrategy = new RejectRouteStrategy();
    const routeStrategyRegistry = new RouteStrategyRegistry({
        strategies: {
            sbc: sbcRouteStrategy,
            "sbc-inbound": sbcRouteStrategy,
            "openai-sip": openAiSipRouteStrategy,
            webrtc: webRtcRouteStrategy,
            "webrtc-multiring": multiringRouteStrategy,
            ivr: ivrRouteStrategy,
            reject: rejectRouteStrategy,
        },
    });
    return {
        routeStrategyRegistry,
        sbcRouteStrategy,
        openAiSipRouteStrategy,
        webRtcRouteStrategy,
        multiringRouteStrategy,
        ivrRouteStrategy,
        rejectRouteStrategy,
    };
}

function createCallEngineHandlers({
    handshakeFlowApi,
    startCallUseCase,
    answerCallUseCase,
    renegotiateCallUseCase,
    bridgeApi,
    callRuntime,
    logger = console,
} = {}) {
    const resolve = (value) => (typeof value === "function" ? value() : value);

    async function handleOutboundWebrtcLegAnswerDirect(sessionId, payload) {
        const session = callRuntime.sessions.get(sessionId);
        const sessionKind = callRuntime.getSessionKind(session);
        if (!session || (sessionKind !== "gateway-outbound-leg" && sessionKind !== "multiring-leg" && !session.outboundWebrtc)) return null;
        const answerUseCase = resolve(answerCallUseCase);
        const bridge = resolve(bridgeApi);
        const answeredLeg = await answerUseCase.handleOutboundWebrtcLegAnswer(sessionId, payload);
        logger.log(`[Bridge] outbound WebRTC pickup observed sessionId=${sessionId} kind=${session.outboundBridgeKind || "unknown"}`);
        if (sessionKind === "multiring-leg" || session.outboundWebrtcLegs) {
            const winner = bridge.commitWinnerFromDataChannelAnswer(answeredLeg?.walletAddress || sessionId);
            return winner || null;
        }
        return bridge.commitWebrtcBridgePickup(sessionId);
    }

    return {
        onCallOfferReceived: (sessionId, event) => resolve(handshakeFlowApi).handleHandshake(
            sessionId,
            event.payload.fromEns,
            event.payload.toIdentity,
            event.payload.offerSdp,
            event.payload.candidates,
            event.payload.callNonce,
        ),
        onDataChannelOpened: (sessionId, event) => resolve(startCallUseCase).onDataChannelOpen(sessionId, event.deps || {}),
        onCallRingRequested: (sessionId, event) => resolve(startCallUseCase).handleRing(sessionId, event.payload),
        onCalleeAnswered: (sessionId, event) => {
            if (event.answerKind === "outbound-webrtc-leg") return handleOutboundWebrtcLegAnswerDirect(sessionId, event.payload);
            return resolve(answerCallUseCase).handleInboundCalleeAnswer(sessionId, event.payload);
        },
        onEndRenegotiationReceived: (sessionId, event) => resolve(renegotiateCallUseCase).handleEndCallRenegotiation(sessionId, event.payload),
    };
}

module.exports = {
    createRouteStrategies,
    createCallEngineHandlers,
};
