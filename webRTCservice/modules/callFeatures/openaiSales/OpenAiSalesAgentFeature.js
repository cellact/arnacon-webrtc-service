class OpenAiSalesAgentFeature {
    constructor({
        sessions,
        triggerCaller,
        salesAgentFrom,
        createSession,
        parseAddress,
        notifyAndBridge,
        notifyAndBridgeMulti,
        startPendingMultiBridge,
        routeCall,
        openOpenAiSipSession,
        closeSipSession,
        closeNativeSipSession,
        sendDataChannelMessage,
        destroySession,
        mediaGraphFactory,
        adaptRtpPayloadType,
        crypto,
        SessionState,
        callRuntime = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            triggerCaller,
            salesAgentFrom,
            createSession,
            parseAddress,
            notifyAndBridge,
            notifyAndBridgeMulti,
            startPendingMultiBridge,
            routeCall,
            openOpenAiSipSession,
            closeSipSession,
            closeNativeSipSession,
            sendDataChannelMessage,
            destroySession,
            mediaGraphFactory,
            adaptRtpPayloadType,
            crypto,
            SessionState,
            callRuntime,
            logger,
        });
    }

    getIdentityLabel(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const withoutSip = raw.replace(/^sip:/i, "").split(";")[0].split("@")[0].trim();
        const dotPos = withoutSip.indexOf(".");
        return (dotPos > 0 ? withoutSip.slice(0, dotPos) : withoutSip).replace(/^\+/, "");
    }

    shouldStart(session, payload, parsedFrom) {
        if (!session || session.openAiSalesAgentTriggerHandled) return false;
        const trigger = String(this.triggerCaller || "").replace(/^\+/, "");
        if (!trigger) return false;
        const candidates = [
            parsedFrom?.value,
            parsedFrom?.full,
            session.callerEns,
            payload?.from,
        ].map((value) => this.getIdentityLabel(value)).filter(Boolean);
        return candidates.includes(trigger);
    }

    createMediaAdapter(targetSessionId, { source = "webrtc" } = {}) {
        let targetLeg = null;
        const getTargetLeg = () => {
            const targetSession = this.sessions.get(targetSessionId);
            if (!targetSession) return null;
            if (targetLeg) return targetLeg;
            targetLeg = source === "sbc"
                ? this.mediaGraphFactory.createSipLeg(targetSession)
                : this.mediaGraphFactory.createWebRtcLeg(targetSession);
            targetLeg.start().catch((err) => {
                this.logger.warn(`[${targetSessionId}] OpenAI sales target leg start failed: ${err.message}`);
            });
            return targetLeg;
        };
        return {
            writeOpenAiRtp: (packet) => {
                const leg = getTargetLeg();
                if (!leg || !packet?.header) return;
                leg.writeRtp(this.adaptRtpPayloadType(packet, leg.payloadType));
            },
            subscribeSourceRtp: (forwardRtp) => {
                const openAiPayloadType = 0;
                const leg = getTargetLeg();
                if (!leg) return () => {};
                const unsubscribe = leg.onRtp((rtp) => forwardRtp(this.adaptRtpPayloadType(rtp, openAiPayloadType)));
                this.logger.log(
                    `[${targetSessionId}] OpenAI sales media adapter attached source=${source} ` +
                    `leg=${leg.kind}`,
                );
                return () => {
                    try { unsubscribe(); } catch (_) {}
                    if (targetLeg) targetLeg.stop().catch(() => {});
                    targetLeg = null;
                };
            },
        };
    }

    async endTarget(salesSessionId, targetSessionId, reason = "openai-sales-ended") {
        const target = this.sessions.get(targetSessionId);
        if (target && !this.callRuntime.isPostCall(target)) {
            try {
                this.sendDataChannelMessage(targetSessionId, { msgType: "call", action: "end", reason });
            } catch (_) {}
            if (this.callRuntime) this.callRuntime.markPostCall(targetSessionId, { source: "openai-sales", reason });
        }
        if (targetSessionId !== salesSessionId) {
            this.callRuntime.destroyRuntimeSession(targetSessionId, { source: "openai-sales", reason });
        }
        const sales = this.sessions.get(salesSessionId);
        if (sales) {
            if (this.callRuntime) this.callRuntime.markPostCall(salesSessionId, { source: "openai-sales", reason });
            if (targetSessionId === salesSessionId && typeof this.closeNativeSipSession === "function") {
                await this.closeNativeSipSession(salesSessionId).catch(() => {});
            }
            this.callRuntime.destroyRuntimeSession(salesSessionId, { source: "openai-sales", reason });
        }
    }

    async start({
        triggerSessionId,
        triggerSession,
        payload,
        parsedTo,
        destination,
    } = {}) {
        const serviceId = triggerSession?.serviceId || "secnum";
        const targetIdentity = payload?.to || triggerSession?.toIdentity || parsedTo?.full || parsedTo?.value || "";
        const salesSessionId = `${triggerSessionId}-openai-sales-${Date.now()}`;
        const parsedSalesFrom = this.parseAddress(this.salesAgentFrom, serviceId);

        if (this.sessions.has(triggerSessionId)) {
            setTimeout(() => {
                const trigger = this.sessions.get(triggerSessionId);
                if (!trigger || !this.callRuntime.isEndRenegotiationPending(trigger)) return;
                this.logger.warn(`[${triggerSessionId}] OpenAI sales-agent trigger fallback destroy after missing end-call renegotiation`);
                this.callRuntime.destroyRuntimeSession(triggerSessionId, { source: "openai-sales", reason: "missing-end-call-renegotiation" });
            }, 10000);
        }
        if (!destination || destination.route === "reject" || destination.route === "openai-sip" || destination.route === "ivr") {
            this.logger.warn(
                `[${triggerSessionId}] OpenAI sales-agent target rejected ` +
                `target=${targetIdentity} route=${destination?.route || "none"}`,
            );
            return;
        }

        const salesSession = this.createSession(salesSessionId, this.salesAgentFrom, targetIdentity);
        salesSession.serviceId = serviceId;
        if (this.callRuntime) this.callRuntime.markRinging(salesSessionId, { source: "openai-sales", reason: "sales-agent-start" });
        salesSession.mediaCodecPolicy = "pcmu";
        salesSession.openAiSalesAgent = {
            triggerSessionId,
            targetIdentity,
            route: destination.route,
            startedAt: Date.now(),
        };
        salesSession.lastRingOfferPayload = {
            callNonce: this.crypto.randomUUID ? this.crypto.randomUUID() : this.crypto.randomBytes(16).toString("hex"),
        };

        let targetSessionId = salesSessionId;
        let mediaSource = "sbc";
        try {
            this.logger.log(
                `[${salesSessionId}] OpenAI sales-agent dialing target=${targetIdentity} ` +
                `route=${destination.route} from=${this.salesAgentFrom}`,
            );
            if (destination.route === "webrtc") {
                targetSessionId = await this.notifyAndBridge(salesSessionId, destination);
                mediaSource = "webrtc";
            } else if (destination.route === "webrtc-multiring") {
                targetSessionId = await this.notifyAndBridgeMulti(salesSessionId, destination.targets || []);
                this.startPendingMultiBridge(salesSessionId);
                mediaSource = "webrtc";
            } else if (destination.route === "sbc") {
                await this.routeCall(salesSessionId, salesSession, destination, parsedSalesFrom);
                mediaSource = "sbc";
            } else {
                throw new Error(`unsupported OpenAI sales-agent route: ${destination.route}`);
            }

            const currentSalesSession = this.sessions.get(salesSessionId);
            const targetSession = this.sessions.get(targetSessionId);
            if (!currentSalesSession || !targetSession) {
                throw new Error("sales-agent callee session disappeared before OpenAI attach");
            }
            if (this.callRuntime) {
                this.callRuntime.markInCall(salesSessionId, { source: "openai-sales", reason: "sales-agent-connected" });
                this.callRuntime.markInCall(targetSessionId, { source: "openai-sales", reason: "sales-agent-target-connected" });
            }

            const sipSession = currentSalesSession.sipConnection?.inviter || currentSalesSession.sipConnection?.invitation || null;
            if (mediaSource === "sbc" && sipSession?.stateChange?.addListener) {
                sipSession.stateChange.addListener((state) => {
                    if (state !== this.SessionState.Terminated) return;
                    this.closeSipSession(salesSessionId).catch(() => {});
                });
            }

            await this.openOpenAiSipSession(salesSessionId, {
                callerEns: this.salesAgentFrom,
                mode: "sales-agent",
                headers: {
                    "X-Arnacon-AI-Mode": "sales-agent",
                    "X-Arnacon-Session-Id": salesSessionId,
                    "X-Arnacon-Trigger-Session-Id": triggerSessionId,
                    "X-Arnacon-Original-To": targetIdentity,
                },
                mediaAdapter: this.createMediaAdapter(targetSessionId, { source: mediaSource }),
                onRemoteBye: (reason) => this.endTarget(salesSessionId, targetSessionId, reason),
            });
            this.logger.log(
                `[${salesSessionId}] OpenAI sales-agent active targetSessionId=${targetSessionId} ` +
                `source=${mediaSource}`,
            );
        } catch (err) {
            this.logger.warn(`[${salesSessionId}] OpenAI sales-agent failed: ${err.message}`);
            await this.closeSipSession(salesSessionId).catch(() => {});
            if (targetSessionId && targetSessionId !== salesSessionId) {
                try {
                    this.sendDataChannelMessage(targetSessionId, {
                        msgType: "call",
                        action: "end",
                        reason: "openai-sales-agent-failed",
                    });
                } catch (_) {}
                this.callRuntime.destroyRuntimeSession(targetSessionId, { source: "openai-sales", reason: "openai-sales-agent-failed" });
            }
            this.callRuntime.destroyRuntimeSession(salesSessionId, { source: "openai-sales", reason: "openai-sales-agent-failed" });
        }
    }
}

module.exports = {
    OpenAiSalesAgentFeature,
};
