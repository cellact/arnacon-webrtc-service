class VerifiedNotifyAnswerHandler {
    constructor({
        bridgeApi,
        startCallUseCase,
        destroySession,
        getSessionKind = null,
        logger = console,
    } = {}) {
        this.bridgeApi = bridgeApi;
        this.startCallUseCase = startCallUseCase;
        this.destroySession = destroySession;
        this.getSessionKind = getSessionKind;
        this.logger = logger;
    }

    async handle(sessionId, offer, session) {
        const sessionKind = this.getSessionKind?.(session);
        if (!session || (sessionKind !== "gateway-outbound-leg" && sessionKind !== "multiring-leg")) return null;

        session.outboundLegHttpAnswered = true;
        this.logger.log(
            `[Bridge] outbound WebRTC stage1 HTTP answer observed ` +
            `sessionId=${sessionId} kind=${session.outboundBridgeKind || "unknown"}`
        );

        let observed = { handled: true };
        if (sessionKind === "multiring-leg") {
            observed = this.bridgeApi.commitWinnerFromAnswer(sessionId);
            if (!observed || !observed.handled) return null;
        }

        try {
            await this.startCallUseCase.triggerOutboundWebrtcLegRing(sessionId, this.destroySession);
        } catch (err) {
            this.logger.error(`[${sessionId}] Failed outbound stage1->stage2 ring trigger: ${err.message}`);
        }
        return {
            ok: true,
            handled: true,
            sessionId,
            pickedUp: false,
            won: false,
            offerType: offer?.type || null,
        };
    }
}

module.exports = {
    VerifiedNotifyAnswerHandler,
};
