const CallBehaviorInvariants = Object.freeze({
    outboundRing: Object.freeze({
        ackBeforeRouting: true,
        finalAnswerAfterRouteCompletes: true,
        ivrStartsAfterAnswer: true,
        sbcMediaStartsAfterAnswer: true,
        multiringBridgeStartsAfterCallerAnswer: true,
    }),
    inboundGateway: Object.freeze({
        dataChannelOpenAckForAnswer: true,
        inboundSipStartsAfterCalleeAnswer: true,
    }),
    teardown: Object.freeze({
        twoStepEndCall: true,
        callEndTearsDownResources: true,
        signalingEndCallAnswersInactiveSdp: true,
        postCallOfferAlwaysStartsNewRing: true,
    }),
    cancellation: Object.freeze({
        singleLifecyclePath: true,
        legalBeforeAnswerStates: Object.freeze(["handshake", "waiting-for-dc", "connected", "ringing"]),
        sources: Object.freeze([
            "http",
            "client-end",
            "client-reject",
            "multiring-loser",
            "sip-timeout",
            "openai-failure",
            "ivr-failure",
            "peer-disconnect",
        ]),
    }),
    routing: Object.freeze({
        serviceModulesOwnPolicy: true,
        notificationPlanRulesUnchanged: true,
        callerIdRulesRemainPerService: true,
    }),
});

module.exports = {
    CallBehaviorInvariants,
};
