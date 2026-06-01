const { routeToCodecPolicy, labelForPolicy } = require("../../media/negotiation/CodecPolicy");
const { narrowAudioOfferForCodecPolicy } = require("../../media/negotiation/SdpCodecNegotiator");
const { buildCallAck, buildCallEnd } = require("../../participants/signaling/SignalingEnvelope");

function identityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

class StartCallUseCase {
    constructor({
        sessions,
        pendingInboundCalls,
        parseAddress,
        resolveDestination,
        routeCall,
        sendDataChannelMessage,
        sendAck,
        sendAnswer,
        ensureLocalAudioTrack,
        createAnswerSdp,
        logSdp,
        patchInactiveToSendrecv,
        waitForIceGathering,
        formatIceCandidates,
        getRelayCandidates,
        embedCandidatesInSdp,
        MediaStreamTrack,
        RTCSessionDescription,
        answerCallUseCase,
        shouldStartOpenAiSalesAgent = null,
        startOpenAiSalesAgentFlow = null,
        cancelCall = null,
        callRuntime = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            pendingInboundCalls,
            parseAddress,
            resolveDestination,
            routeCall,
            sendDataChannelMessage,
            sendAck,
            sendAnswer,
            ensureLocalAudioTrack,
            createAnswerSdp,
            logSdp,
            patchInactiveToSendrecv,
            waitForIceGathering,
            formatIceCandidates,
            getRelayCandidates,
            embedCandidatesInSdp,
            MediaStreamTrack,
            RTCSessionDescription,
            answerCallUseCase,
            shouldStartOpenAiSalesAgent,
            startOpenAiSalesAgentFlow,
            cancelCall,
            callRuntime,
            logger,
        });
    }

    onDataChannelOpen(sessionId, deps = {}) {
        const { checkPendingBridge, checkPendingInboundCall, sendInboundRing, destroySession } = deps;
        const session = this.sessions.get(sessionId);
        if (!session) return;
        const sessionKind = this.callRuntime?.getSessionKind(session);
        if (sessionKind === "gateway-inbound") {
            if (session.inboundRingSent) return;
            session.inboundRingSent = true;
            this.sendDataChannelMessage(sessionId, buildCallAck({ ackFor: "answer" }));
            sendInboundRing(sessionId).catch((err) => {
                session.inboundRingSent = false;
                this.logger.error(`[${sessionId}] Failed to send inbound RING: ${err.message}`);
                this.callRuntime.destroyRuntimeSession(sessionId, { source: "ring", reason: "inbound-ring-failed" });
            });
            return;
        }
        if (sessionKind === "gateway-outbound-leg" || session.outboundWebrtc) {
            this.triggerOutboundWebrtcLegRing(sessionId, destroySession).catch((err) => {
                this.logger.error(`[${sessionId}] Failed to send outbound WebRTC leg RING on DC open: ${err.message}`);
            });
        }
        if (session.walletAddress) {
            checkPendingBridge(sessionId, session.walletAddress);
            checkPendingInboundCall(sessionId, session.walletAddress);
        }
    }

    async triggerOutboundWebrtcLegRing(sessionId, destroySession = null) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.outboundWebrtc) return false;
        if (!session.outboundLegHttpAnswered) return false;
        if (session.outboundLegRingSent) return true;
        if (!session.outboundWebrtc.dataChannel) return false;
        session.outboundLegRingSent = true;
        try {
            await this.sendInboundRing(sessionId);
            this.logger.log(`[${sessionId}] outbound WebRTC stage1->stage2: RING offer sent over data channel`);
            return true;
        } catch (err) {
            session.outboundLegRingSent = false;
            this.callRuntime.destroyRuntimeSession(sessionId, { source: "ring", reason: "outbound-leg-ring-failed" });
            throw err;
        }
    }

    async sendInboundRing(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const target = session.outboundWebrtc || session;
        if (!target.peerConnection) throw new Error("Session peer connection not found");
        const pc = target.peerConnection;
        if (!target.localAudioTrack) {
            const localTrack = new this.MediaStreamTrack({ kind: "audio" });
            target.localAudioTrack = localTrack;
            pc.addTrack(localTrack);
        } else {
            const audioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (audioT) audioT.setDirection("sendrecv");
        }
        target.iceCandidates = [];
        const offer = await pc.createOffer();
        let baseOfferSdp = offer.sdp;
        if (session.mediaCodecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(baseOfferSdp, session.mediaCodecPolicy);
            if (narrowedOfferSdp !== baseOfferSdp) {
                this.logger.log(`[${sessionId}] outbound WebRTC leg: narrowed RING offer codecPolicy=${session.mediaCodecPolicy}`);
                baseOfferSdp = narrowedOfferSdp;
                offer.sdp = baseOfferSdp;
            }
        }
        await pc.setLocalDescription(offer);
        await this.waitForIceGathering(pc);
        const gatheredCandidates = this.formatIceCandidates(target).filter(c => !c.candidate.toLowerCase().includes(" tcp "));
        const srflxAndRelay = gatheredCandidates.filter(c => c.candidate.includes("typ srflx") || c.candidate.includes("typ relay"));
        const candidatesToEmbed = srflxAndRelay.length > 0 ? srflxAndRelay : gatheredCandidates;
        const relayCandidates = this.getRelayCandidates(gatheredCandidates);
        const offerSdp = this.embedCandidatesInSdp(baseOfferSdp, candidatesToEmbed);
        this.logSdp(sessionId, "RING OFFER SDP (to callee)", offerSdp);
        const fromLabel = identityLabel(target.callerEns || session.callerEns);
        const message = {
            msgType: "signaling",
            payload: {
                type: "offer",
                from: fromLabel,
                to: target.toIdentity || session.toIdentity,
                sessionId,
                sdp: offerSdp,
                candidates: relayCandidates,
                label: fromLabel,
                ...(session.lastRingOfferPayload?.xdata ? { xdata: session.lastRingOfferPayload.xdata } : {}),
                ...(session.lastRingOfferPayload?.xsign ? { xsign: session.lastRingOfferPayload.xsign } : {}),
            },
        };
        if (target !== session) {
            target.dataChannel.send(JSON.stringify(message));
            this.logger.log(`[${sessionId}] DC-OUT(callee): msgType=signaling action=offer phase=${session.phase || "?"} sdpLen=${offerSdp.length}`);
        } else {
            this.sendDataChannelMessage(sessionId, message);
        }
        if (session.calleeWallet) {
            const pending = this.pendingInboundCalls.get(session.calleeWallet);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingInboundCalls.delete(session.calleeWallet);
            }
        }
    }

    async answerSalesTriggerOfferInactive(sessionId, session, payload) {
        const pc = session.peerConnection;
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "offer"));
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.kind !== "audio") continue;
            transceiver.setDirection("inactive");
            if (transceiver.sender && typeof transceiver.sender.replaceTrack === "function") {
                try { await transceiver.sender.replaceTrack(null); } catch (_) {}
            }
            break;
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.logSdp(sessionId, "OPENAI SALES TRIGGER INACTIVE ANSWER SDP", answer.sdp);
        this.sendAnswer(sessionId, answer.sdp);
    }

    async handleRing(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) throw new Error("Session or PeerConnection not found");
        session.lastRingOfferPayload = payload;
        const pc = session.peerConnection;
        const isInbound = !!session.inboundCall;
        const rawDir = payload.sdp.match(/m=audio[\s\S]*?a=(sendrecv|recvonly|sendonly|inactive)/m)?.[1] || "no-audio-dir";
        const isInactive = rawDir === "inactive";
        this.logSdp(sessionId, "CLIENT OFFER SDP (raw)", payload.sdp);

        let destination;
        let parsedFrom;
        let parsedTo;
        const serviceId = session.serviceId || null;
        if (!isInbound) {
            parsedTo = this.parseAddress(payload.to || session.toIdentity, serviceId);
            parsedFrom = this.parseAddress(session.callerEns, serviceId);
            destination = await this.resolveDestination(parsedTo, parsedFrom, serviceId);
            if (destination.route === "reject") {
                if (typeof this.cancelCall === "function") await this.cancelCall(sessionId, { destination, reason: "reject-route" });
                return;
            }
            if (
                typeof this.shouldStartOpenAiSalesAgent === "function" &&
                this.shouldStartOpenAiSalesAgent(session, payload, parsedFrom, parsedTo, destination)
            ) {
                this.logger.log(`[${sessionId}] OpenAI sales-agent trigger accepted`);
                session.openAiSalesAgentTriggerHandled = true;
                try {
                    await this.answerSalesTriggerOfferInactive(sessionId, session, payload);
                } catch (err) {
                    this.logger.warn(`[${sessionId}] OpenAI sales-agent inactive answer failed: ${err.message}`);
                }
                this.sendAck(sessionId);
                this.sendDataChannelMessage(sessionId, buildCallEnd({ reason: "openai-sales-agent-triggered" }));
                if (this.callRuntime) {
                    this.callRuntime.markPostCall(sessionId, {
                        source: "openai-sales",
                        reason: "openai-sales-agent-triggered",
                        endCallRenegDone: false,
                    });
                }
                if (typeof this.startOpenAiSalesAgentFlow === "function") {
                    setImmediate(() => {
                        this.startOpenAiSalesAgentFlow({
                            triggerSessionId: sessionId,
                            triggerSession: session,
                            payload,
                            parsedFrom,
                            parsedTo,
                            destination,
                        }).catch((err) => {
                            this.logger.error(`[${sessionId}] OpenAI sales-agent flow failed: ${err.message}`);
                        });
                    });
                }
                return;
            }
        }

        if (this.callRuntime) {
            if (isInbound) this.callRuntime.markInCall(sessionId, { source: "ring", reason: "inbound-ring" });
            else this.callRuntime.markRinging(sessionId, { source: "ring", reason: "outbound-ring" });
        }
        if (!(isInbound && isInactive)) {
            const existingAudioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (existingAudioT) existingAudioT.setDirection("sendrecv");
        }

        let offerSdp = payload.sdp;
        if (isInactive) offerSdp = this.patchInactiveToSendrecv(offerSdp);
        const codecPolicy = routeToCodecPolicy(destination, { isInbound });
        if (codecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(offerSdp, codecPolicy);
            if (narrowedOfferSdp !== offerSdp) {
                this.logger.log(`[${sessionId}] ${destination.route} route: narrowed caller audio offer to ${labelForPolicy(codecPolicy)}`);
                offerSdp = narrowedOfferSdp;
            }
            session.mediaCodecPolicy = codecPolicy;
        } else {
            session.mediaCodecPolicy = null;
        }
        await pc.setRemoteDescription(new this.RTCSessionDescription(offerSdp, "offer"));

        this.ensureLocalAudioTrack(session, pc, sessionId);
        const answerLabel = isInactive ? "PHASE 1 ANSWER SDP" : "ANSWER SDP";
        const answerSdp = await this.createAnswerSdp(pc, sessionId, answerLabel);

        if (!isInbound) this.sendAck(sessionId);
        await this.answerCallUseCase.finalizeRing({
            sessionId,
            isInbound,
            isInactive,
            answerSdp,
            destination,
            parsedFrom,
            parsedTo,
            routeCall: this.routeCall,
        });
    }
}

module.exports = {
    StartCallUseCase,
};
