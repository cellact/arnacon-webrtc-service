const { exactG711PolicyFromAnswer } = require("../../media/negotiation/SdpCodecNegotiator");
const { buildCallAck, buildCallEnd } = require("../../participants/signaling/SignalingEnvelope");

class AnswerCallUseCase {
    constructor({
        sessions,
        openInboundSipSession,
        startMediaRelay,
        sendDataChannelMessage,
        sendAnswer,
        sendAckAndAnswer,
        failCall,
        schedulePhase2Reoffer,
        RTCSessionDescription,
        startPendingMultiBridge = null,
        shouldStartIvrForSession = null,
        callRuntime = null,
        connectRoute = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            openInboundSipSession,
            startMediaRelay,
            sendDataChannelMessage,
            sendAnswer,
            sendAckAndAnswer,
            failCall,
            schedulePhase2Reoffer,
            RTCSessionDescription,
            startPendingMultiBridge,
            shouldStartIvrForSession,
            callRuntime,
            connectRoute,
            logger,
        });
    }

    storeIvrNegotiatedAudio(session, sessionId, answerSdp) {
        session.ivrLastAnswerSdp = answerSdp;
        const ssrcMatch = answerSdp.match(/a=ssrc:(\d+)/);
        if (!ssrcMatch) return;
        const parsedSsrc = Number(ssrcMatch[1]);
        if (!Number.isFinite(parsedSsrc) || parsedSsrc <= 0) return;

        session.ivrNegotiatedSsrc = parsedSsrc >>> 0;
        if (session.localAudioTrack) {
            try {
                session.localAudioTrack.ssrc = session.ivrNegotiatedSsrc;
            } catch (_) {}
        }
        this.logger.log(`[${sessionId}] IVR negotiated audio SSRC=${session.ivrNegotiatedSsrc}`);
    }

    async handleInboundCalleeAnswer(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        const pc = session.peerConnection;
        if (this.callRuntime) this.callRuntime.markInCall(sessionId, { source: "inbound-answer", reason: "callee-answered" });
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "answer"));
        this.sendDataChannelMessage(sessionId, buildCallAck({ ackFor: "answer" }));
        const shouldStartIvr =
            typeof this.shouldStartIvrForSession === "function" &&
            this.shouldStartIvrForSession(session, session?.inboundCall?.toNumber) &&
            typeof this.connectRoute === "function";
        try {
            await this.openInboundSipSession(sessionId, session.inboundCall.toNumber);
            if (shouldStartIvr) {
                await this.connectRoute(sessionId, {
                    destination: {
                        route: "ivr",
                        target: session?.inboundCall?.toNumber || "",
                    },
                    routeResult: "ivr",
                    source: "inbound-answer",
                });
            }
        } catch (_) {
            if (this.callRuntime) {
                this.callRuntime.markFailed(sessionId, { source: "inbound-answer", reason: "inbound-sip-session-failed", error: new Error("Inbound SIP session failed") });
                this.callRuntime.notifyCallEnd(sessionId, { reason: "inbound-sip-session-failed" });
            } else {
                this.sendDataChannelMessage(sessionId, buildCallEnd());
            }
        }
    }

    async handleOutboundWebrtcLegAnswer(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        const pc = session.peerConnection;
        if (this.callRuntime) this.callRuntime.markInCall(sessionId, { source: "webrtc-outbound-leg", reason: "callee-answered" });
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "answer"));
        this.sendDataChannelMessage(sessionId, buildCallAck({ ackFor: "answer" }));
        this.logger.log(`[${sessionId}] outbound WebRTC stage2: pickup answer received over data channel`);
    }

    async finalizeRing({
        sessionId,
        isInbound,
        isInactive,
        answerSdp,
        destination,
        parsedFrom,
        parsedTo,
        routeCall,
        routeResult = null,
    }) {
        let session = this.sessions.get(sessionId);
        if (!session) return;
        if (!isInbound && destination?.route === "ivr") {
            const exactPolicy = exactG711PolicyFromAnswer(answerSdp);
            if (exactPolicy) {
                session.mediaCodecPolicy = exactPolicy;
                this.logger.log(`[${sessionId}] IVR bridge codec policy resolved to ${exactPolicy}`);
            }
            this.storeIvrNegotiatedAudio(session, sessionId, answerSdp);
        }

        try {
            if (isInbound) await this.openInboundSipSession(sessionId, session.inboundCall.toNumber);
            else routeResult = await routeCall(sessionId, session, destination, parsedFrom);
        } catch (err) {
            session = this.sessions.get(sessionId);
            if (!session) {
                this.logger.warn(
                    `[${sessionId}] Route failure completed after session teardown: ` +
                    `${err?.message || err}`,
                );
                return;
            }
            this.failCall(sessionId, err, isInbound ? "Inbound SIP session failed" : "Call routing failed");
            return;
        }

        session = this.sessions.get(sessionId);
        if (!session) {
            this.logger.warn(`[${sessionId}] Route connected after session teardown; skipping answer commit`);
            return;
        }
        if (this.callRuntime) this.callRuntime.markInCall(sessionId, { source: "route", reason: "route-connected" });
        if (isInbound) this.sendAckAndAnswer(sessionId, answerSdp);
        else this.sendAnswer(sessionId, answerSdp);
        if (!isInbound && typeof this.connectRoute === "function") {
            await this.connectRoute(sessionId, {
                destination,
                routeResult,
                source: "answer",
            });
        }
        if (isInactive) {
            const pendingReoffer = isInbound
                ? { destination: { route: "sbc-inbound", toNumber: session.inboundCall.toNumber }, parsedFrom: null, parsedTo: null }
                : { destination, parsedFrom, parsedTo };
            this.schedulePhase2Reoffer(sessionId, pendingReoffer);
            return;
        }
        if (!isInbound && this.callRuntime?.shouldQueuePhase2Reoffer(session)) {
            this.schedulePhase2Reoffer(sessionId, { destination, parsedFrom, parsedTo });
        }
    }
}

module.exports = {
    AnswerCallUseCase,
};
