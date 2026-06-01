const { narrowAudioOfferForCodecPolicy } = require("../../media/negotiation/SdpCodecNegotiator");
const { buildOfferPayload, serializeNotifyPayload } = require("../../participants/signaling/SignalingEnvelope");

function getCallerNumberLabel(identity) {
    if (!identity || typeof identity !== "string") return "";
    const trimmed = identity.trim();
    if (!trimmed) return "";
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

class WebRtcOutboundLegFactory {
    constructor({
        sessions,
        createSession,
        createPeerConnection,
        MediaStreamTrack,
        waitForIceGathering,
        formatIceCandidates,
        getRelayCandidates,
        embedCandidatesInSdp,
        onDataChannelOpen = null,
        onDataChannelMessage = null,
        logger = console,
    }) {
        Object.assign(this, {
            sessions,
            createSession,
            createPeerConnection,
            MediaStreamTrack,
            waitForIceGathering,
            formatIceCandidates,
            getRelayCandidates,
            embedCandidatesInSdp,
            onDataChannelOpen,
            onDataChannelMessage,
            logger,
        });
    }

    attachOutboundDataChannel(legSessionId, legSession) {
        const pc = this.createPeerConnection(legSessionId);
        if (typeof pc.createDataChannel !== "function") return pc;

        const dc = pc.createDataChannel("chat");
        if (!dc) return pc;

        legSession.dataChannel = dc;
        dc.onopen = () => {
            if (typeof this.onDataChannelOpen === "function") {
                this.onDataChannelOpen(legSessionId);
            }
        };
        dc.onMessage.subscribe((msg) => {
            if (typeof this.onDataChannelMessage !== "function") return;
            const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf-8");
            this.onDataChannelMessage(legSessionId, raw);
        });
        dc.onclose = () => this.logger.log(`[${legSessionId}] Data channel closed`);
        return pc;
    }

    async create(callerSessionId, destination, options = {}) {
        const callerSession = this.sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        const callerEns = callerSession.callerEns;
        const callerNumberLabel = getCallerNumberLabel(callerEns);
        const walletKey = String(calleeWallet || "").toLowerCase();
        const legSessionId = options.legSessionId || `${callerSessionId}-webrtc-${Date.now()}`;
        if (!calleeWallet || !calleeEns) {
            throw new Error("WebRTC destination missing callee wallet/ENS");
        }

        const legSession = this.createSession(legSessionId, callerEns, calleeEns);
        legSession.isGatewayCaller = true;
        legSession.outboundWebrtcLeg = true;
        legSession.outboundBridgeKind = options.kind || "single";
        legSession.walletAddress = walletKey;
        legSession.serviceId = callerSession.serviceId || null;
        legSession.mediaCodecPolicy = callerSession.mediaCodecPolicy || null;
        if (options.multiRingGroupId) {
            legSession.multiRingGroupId = options.multiRingGroupId;
            legSession.multiRingLeg = true;
        }

        const pc = this.attachOutboundDataChannel(legSessionId, legSession);
        legSession.localAudioTrack = new this.MediaStreamTrack({ kind: "audio" });
        pc.addTrack(legSession.localAudioTrack);
        legSession.iceCandidates = [];

        const offer = await pc.createOffer();
        let baseOfferSdp = offer.sdp;
        if (callerSession.mediaCodecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(baseOfferSdp, callerSession.mediaCodecPolicy);
            if (narrowedOfferSdp !== baseOfferSdp) {
                this.logger.log(`[${legSessionId}] WebRTC leg inherited bridge codec policy=${callerSession.mediaCodecPolicy}`);
                baseOfferSdp = narrowedOfferSdp;
                offer.sdp = baseOfferSdp;
            }
        }
        await pc.setLocalDescription(offer);
        await this.waitForIceGathering(pc);
        const gatheredCandidates = this.formatIceCandidates(legSession).filter((c) => {
            const cand = String(c?.candidate || "").toLowerCase();
            return !cand.includes(" tcp ");
        });
        const srflxAndRelay = gatheredCandidates.filter((c) => {
            const cand = String(c?.candidate || "");
            return cand.includes("typ srflx") || cand.includes("typ relay");
        });
        const candidatesToEmbed = srflxAndRelay.length > 0 ? srflxAndRelay : gatheredCandidates;
        const relayCandidates = this.getRelayCandidates(gatheredCandidates);
        const offerSdp = this.embedCandidatesInSdp(baseOfferSdp, candidatesToEmbed);
        const sourceOffer = callerSession.lastRingOfferPayload || null;

        const callPayload = serializeNotifyPayload(buildOfferPayload({
            from: callerNumberLabel || callerEns,
            to: calleeEns,
            sessionId: legSessionId,
            sdp: offerSdp,
            candidates: relayCandidates,
            callNonce: sourceOffer?.callNonce || null,
            isCall: true,
            extra: {
                label: callerNumberLabel || undefined,
                ...(options.payload || {}),
            },
        }));
        this.logger.log(
            `[${legSessionId}] outbound WebRTC invite payload from=${callerNumberLabel || callerEns} ` +
            `to=${calleeEns} callerEns=${callerEns}`
        );

        return {
            callerSession,
            legSession,
            legSessionId,
            walletKey,
            calleeEns,
            callerEns,
            callPayload,
        };
    }
}

module.exports = {
    WebRtcOutboundLegFactory,
};
