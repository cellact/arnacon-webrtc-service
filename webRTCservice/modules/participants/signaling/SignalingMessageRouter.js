class SignalingMessageRouter {
    constructor({
        sessions,
        enqueueSignaling,
        handleEndCallRenegotiation,
        handleReofferAnswer,
        handleInboundCalleeAnswer,
        handleOutboundWebrtcLegAnswer = null,
        handleIceRestart,
        handleRing,
        handleCallEnd,
        handleCallDtmf = null,
        handleCallHold = null,
        handleDataMessage,
        resetPostCallForNewRing = null,
        isEndRenegotiationPending = null,
        canAcceptNewRing = null,
        isRinging = null,
        isInCall = null,
        getSessionKind = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            enqueueSignaling,
            handleEndCallRenegotiation,
            handleReofferAnswer,
            handleInboundCalleeAnswer,
            handleOutboundWebrtcLegAnswer,
            handleIceRestart,
            handleRing,
            handleCallEnd,
            handleCallDtmf,
            handleCallHold,
            handleDataMessage,
            resetPostCallForNewRingHandler: resetPostCallForNewRing,
            isEndRenegotiationPending,
            canAcceptNewRing,
            isRinging,
            isInCall,
            getSessionKind,
            logger,
        });
        this.dcHandlers = {
            signaling: (sessionId, msg, sess, phase, meta) => this.handleSignaling(sessionId, msg, sess, meta),
            call: (sessionId, msg, sess, phase, meta) => this.handleCallMessage(sessionId, msg, sess, meta),
            data: (sessionId, msg, sess, phase) => this.handleData(sessionId, msg, phase),
        };
    }

    onDataChannelMessage(sessionId, rawMessage, meta = {}) {
        let msg;
        try {
            msg = JSON.parse(rawMessage);
        } catch (err) {
            this.logger.error(`[${sessionId}] Failed to parse DC message: ${err.message}`);
            return;
        }

        const sess = this.sessions.get(sessionId);
        const phase = sess ? sess.phase : "no-session";
        const msgType = msg.msgType;
        const dcAction = msg.action || msg.payload?.type || "unknown";
        const sdpLen = msg.payload?.sdp ? msg.payload.sdp.length : 0;
        const channelRole = meta.channelRole || "caller-webrtc";
        this.logger.log(`[${sessionId}] DC-IN(${channelRole}): msgType=${msgType} action=${dcAction} phase=${phase}${sdpLen ? ` sdpLen=${sdpLen}` : ""}`);

        const handler = this.dcHandlers[msgType];
        if (handler) {
            handler(sessionId, msg, sess, phase, meta);
            return;
        }

        this.logger.log(
            `[${sessionId}] DC-IN unhandled msgType=${msgType} phase=${phase} keys=${Object.keys(msg || {}).join(",")}`,
        );
    }

    handleSignaling(sessionId, msg, sess, meta = {}) {
        const action = msg.action;
        const payload = msg.payload;

        if (action === "end-call" && payload) {
            if (
                sess &&
                !this.isEndRenegotiationPending?.(sess) &&
                this.canAcceptNewRing?.(sess)
            ) {
                this.logger.log(`[${sessionId}] Ignoring duplicate end-call renegotiation after post-call completion`);
                return;
            }
            if (
                sess &&
                (
                    this.isRinging?.(sess) ||
                    this.isEndRenegotiationPending?.(sess)
                )
            ) {
                this.handleEndCallRenegotiation(sessionId, payload, meta).catch((err) => {
                    this.logger.error(`[${sessionId}] Immediate end-call failed: ${err.message}`);
                });
                return;
            }
            this.enqueueSignaling(sessionId, "end-call", () => this.handleEndCallRenegotiation(sessionId, payload, meta));
            return;
        }

        if (payload && payload.type === "answer") {
            const s = this.sessions.get(sessionId);
            if (s && s.pendingReoffer) {
                this.enqueueSignaling(sessionId, "reoffer-answer", () => this.handleReofferAnswer(sessionId, payload));
            } else if (
                s &&
                (this.getSessionKind?.(s) === "gateway-outbound-leg" || s.outboundWebrtc) &&
                typeof this.handleOutboundWebrtcLegAnswer === "function"
            ) {
                this.handleOutboundWebrtcLegAnswer(sessionId, payload).catch((err) => {
                    this.logger.error(`[${sessionId}] Immediate outbound WebRTC leg answer failed: ${err.message}`);
                });
            } else if (s && this.getSessionKind?.(s) === "gateway-inbound") {
                this.enqueueSignaling(sessionId, "inbound-answer", () => this.handleInboundCalleeAnswer(sessionId, payload));
            }
            return;
        }

        if (payload && payload.type === "offer") {
            const s = this.sessions.get(sessionId);
            if (s && this.isInCall?.(s)) {
                this.enqueueSignaling(sessionId, "ice-restart", () => this.handleIceRestart(sessionId, payload));
            } else if (
                s &&
                (
                    this.isEndRenegotiationPending?.(s) ||
                    this.canAcceptNewRing?.(s)
                )
            ) {
                this.logger.log(`[${sessionId}] Treating late signaling offer as post-call renegotiation`);
                this.handleEndCallRenegotiation(sessionId, payload, meta).catch((err) => {
                    this.logger.error(`[${sessionId}] Immediate post-call renegotiation failed: ${err.message}`);
                });
            } else {
                this.enqueueSignaling(sessionId, "ring", () => this.handleRing(sessionId, payload));
            }
        }
    }

    resetPostCallForNewRing(session) {
        if (typeof this.resetPostCallForNewRingHandler === "function") {
            return this.resetPostCallForNewRingHandler(session.sessionId);
        }
        session.signalingQueue = Promise.resolve();
    }

    handleCallMessage(sessionId, msg, sess, meta = {}) {
        const action = msg.action;
        const fromOwnedWebRtcLeg = meta.channelRole === "callee-webrtc";
        const endOptions = {
            notifyClient: fromOwnedWebRtcLeg,
            notifyOwnedWebRtcLegs: !fromOwnedWebRtcLeg,
        };
        if (action === "end") {
            if (
                sess &&
                !this.isEndRenegotiationPending?.(sess) &&
                this.canAcceptNewRing?.(sess)
            ) {
                this.logger.log(`[${sessionId}] Ignoring duplicate call-end after post-call completion`);
                return;
            }
            if (sess && !this.isInCall?.(sess)) {
                this.handleCallEnd(sessionId, "client-initiated", endOptions).catch((err) => {
                    this.logger.error(`[${sessionId}] Immediate call-end failed: ${err.message}`);
                });
                return;
            }
            this.enqueueSignaling(sessionId, "call-end", () => this.handleCallEnd(sessionId, "client-initiated", endOptions));
            return;
        }
        if (action === "reject") {
            if (sess && !this.isInCall?.(sess)) {
                this.handleCallEnd(sessionId, "client-reject", endOptions).catch((err) => {
                    this.logger.error(`[${sessionId}] Immediate call-reject failed: ${err.message}`);
                });
                return;
            }
            this.enqueueSignaling(sessionId, "call-reject", () => this.handleCallEnd(sessionId, "client-reject", endOptions));
            return;
        }
        if (action === "hold") {
            if (typeof this.handleCallHold === "function") this.handleCallHold(sessionId, true);
            return;
        }
        if (action === "unhold") {
            if (typeof this.handleCallHold === "function") this.handleCallHold(sessionId, false);
            return;
        }
        if (action === "dtmf" && typeof this.handleCallDtmf === "function") {
            this.enqueueSignaling(sessionId, "call-dtmf", () => this.handleCallDtmf(sessionId, msg));
        }
    }

    handleData(sessionId, msg, phase) {
        const inferredAction =
            msg.action ||
            msg.event ||
            msg.kind ||
            msg.payload?.type ||
            (typeof msg.data === "string" ? msg.data : "data");
        const textBody =
            typeof msg.text === "string"
                ? msg.text
                : typeof msg.data === "string"
                    ? msg.data
                    : typeof msg.payload === "string"
                        ? msg.payload
                        : null;
        const previewSource = textBody || JSON.stringify(msg.payload ?? msg.data ?? msg);
        const preview = String(previewSource || "")
            .replace(/\s+/g, " ")
            .slice(0, 200);
        this.logger.log(
            `[${sessionId}] DC-DATA: action=${inferredAction} phase=${phase} preview="${preview}"`,
        );
        if (typeof this.handleDataMessage === "function") {
            this.handleDataMessage(sessionId, msg, phase).catch((err) => {
                this.logger.error(`[${sessionId}] DC-DATA forward failed: ${err.message}`);
            });
        }
    }
}

module.exports = {
    SignalingMessageRouter,
};
