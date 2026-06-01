class VerifiedNotifyAnswerHandler {
    constructor({
        bridgeApi,
        startCallUseCase,
        destroySession,
        getSessionKind = null,
        callRuntime = null,
        RTCSessionDescription = null,
        addIceCandidates = null,
        logger = console,
    } = {}) {
        this.bridgeApi = bridgeApi;
        this.startCallUseCase = startCallUseCase;
        this.destroySession = destroySession;
        this.getSessionKind = getSessionKind;
        this.callRuntime = callRuntime;
        this.RTCSessionDescription = RTCSessionDescription;
        this.addIceCandidates = addIceCandidates;
        this.logger = logger;
    }

    identityLabel(identity) {
        if (!identity || typeof identity !== "string") return identity;
        const trimmed = identity.trim();
        const atPos = trimmed.indexOf("@");
        if (atPos > 0) return trimmed.slice(0, atPos);
        const dotPos = trimmed.indexOf(".");
        if (dotPos > 0) return trimmed.slice(0, dotPos);
        return trimmed;
    }

    sameIdentity(a, b) {
        return String(this.identityLabel(a) || "").toLowerCase() === String(this.identityLabel(b) || "").toLowerCase();
    }

    async applyStage1Answer(sessionId, offer, session) {
        const leg = session.outboundWebrtc;
        if (!leg?.peerConnection) throw new Error("Outbound WebRTC leg PeerConnection not found");
        if (leg.stage1AnswerApplied) return;
        if (!this.RTCSessionDescription) throw new Error("RTCSessionDescription dependency missing");
        await leg.peerConnection.setRemoteDescription(new this.RTCSessionDescription(offer.sdp, "answer"));
        if (typeof this.addIceCandidates === "function") {
            await this.addIceCandidates(leg.peerConnection, offer.candidates || []);
        }
        leg.stage1AnswerApplied = true;
        this.logger.log(`[${sessionId}] outbound WebRTC stage1 answer applied to callee leg`);
    }

    async waitForDataChannelOpen(sessionId, session, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const channel = session.outboundWebrtc?.dataChannel;
            if (session.outboundWebrtc?.dataChannelOpen || channel?.readyState === "open") return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Outbound WebRTC leg data channel did not open");
    }

    async handle(sessionId, offer, session) {
        const sessionKind = this.getSessionKind?.(session);
        if (!session) return null;
        if (!session.outboundWebrtc && session.outboundWebrtcLegs && offer?.from) {
            for (const leg of session.outboundWebrtcLegs.values()) {
                if (
                    this.sameIdentity(leg.toIdentity, offer.from) ||
                    this.sameIdentity(leg.walletAddress, offer.from)
                ) {
                    session.outboundWebrtc = leg;
                    break;
                }
            }
        }
        if (sessionKind !== "gateway-outbound-leg" && sessionKind !== "multiring-leg" && !session.outboundWebrtc) return null;

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
            await this.applyStage1Answer(sessionId, offer, session);
            await this.waitForDataChannelOpen(sessionId, session);
            await this.startCallUseCase.triggerOutboundWebrtcLegRing(sessionId, this.destroySession);
        } catch (err) {
            this.logger.error(`[${sessionId}] Failed outbound stage1->stage2 ring trigger: ${err.message}`);
            if (this.callRuntime) {
                try {
                    this.callRuntime.markFailed(sessionId, { source: "webrtc", reason: "outbound-webrtc-stage2-ring-failed", error: err });
                    this.callRuntime.notifyCallEnd(sessionId, { reason: "outbound-webrtc-stage2-ring-failed", source: "webrtc" });
                    this.callRuntime.notifyOwnedWebRtcLegsCallEnd(sessionId, { reason: "outbound-webrtc-stage2-ring-failed", source: "webrtc" });
                } catch (_) {}
            }
            return {
                ok: false,
                handled: true,
                sessionId,
                pickedUp: false,
                won: false,
                offerType: offer?.type || null,
                error: err.message,
            };
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
