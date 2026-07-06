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

    attachOutboundDataChannel(sessionId, legSession) {
        const pc = this.createPeerConnection(sessionId, legSession, {
            label: "PC-callee",
            destroyOnTerminalState: false,
        });
        if (typeof pc.createDataChannel !== "function") return pc;

        const dc = pc.createDataChannel("chat");
        if (!dc) return pc;

        legSession.dataChannel = dc;
        dc.onopen = () => {
            legSession.dataChannelOpen = true;
            if (typeof this.onDataChannelOpen === "function") {
                this.onDataChannelOpen(sessionId, {
                    channelRole: "callee-webrtc",
                    calleeIdentity: legSession.toIdentity,
                    walletAddress: legSession.walletAddress,
                    signalingSessionId: legSession.signalingSessionId,
                });
            }
        };
        dc.onMessage.subscribe((msg) => {
            if (typeof this.onDataChannelMessage !== "function") return;
            const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf-8");
            this.onDataChannelMessage(sessionId, raw, {
                channelRole: "callee-webrtc",
                calleeIdentity: legSession.toIdentity,
                walletAddress: legSession.walletAddress,
                signalingSessionId: legSession.signalingSessionId,
            });
        });
        dc.onclose = () => {
            legSession.dataChannelOpen = false;
            this.logger.log(`[${sessionId}] Callee data channel closed`);
        };
        return pc;
    }

    async create(callerSessionId, destination, options = {}) {
        const callerSession = this.sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        const callerEns = callerSession.callerEns;
        const callerNumberLabel = getCallerNumberLabel(callerEns);
        // Build the wire sessionId in the RECIPIENT's (callee's) own convention:
        // every client keys a session as sort(ownFullEns, peerBareNumber) -- it
        // stores ITSELF as the full ENS and the peer as the bare number. So the
        // callee must receive sort(calleeEns, callerNumberLabel), NOT a bare|bare
        // key. Otherwise the incoming session is stored as "488|490" while the
        // callee's own next outgoing call computes "488.ens|490" -> keys never match
        // -> the parked session isn't reused and a fresh PC is built every time.
        // Server-internal matching is unaffected: PolySessionRegistry.pairKey strips
        // the ENS to bare on both sides regardless of the wire string.
        const signalingSessionId = [calleeEns, callerNumberLabel].sort().join("|");
        const walletKey = String(calleeWallet || "").toLowerCase();
        if (!calleeWallet || !calleeEns) {
            throw new Error("WebRTC destination missing callee wallet/ENS");
        }

        const legSession = {
            sessionId: callerSessionId,
            // The signaling id the callee client negotiates its session under; the
            // poly ring (audio offer over the DC) must reuse it so the client
            // matches the ring to this session.
            signalingSessionId: signalingSessionId,
            role: "callee-webrtc",
            callerEns,
            toIdentity: calleeEns,
            outboundBridgeKind: options.kind || "single",
            walletAddress: walletKey,
            serviceId: callerSession.serviceId || null,
            mediaCodecPolicy: callerSession.mediaCodecPolicy || null,
            peerConnection: null,
            dataChannel: null,
            iceCandidates: [],
            remoteTracks: [],
            localAudioTrack: null,
            connectionState: "new",
            dataChannelOpen: false,
        };
        if (options.multiRingGroupId) {
            legSession.multiRingGroupId = options.multiRingGroupId;
            legSession.multiRingLeg = true;
        }
        if (options.kind === "multi") {
            if (!callerSession.outboundWebrtcLegs) callerSession.outboundWebrtcLegs = new Map();
            callerSession.outboundWebrtcLegs.set(walletKey, legSession);
        } else {
            callerSession.outboundWebrtc = legSession;
        }
        callerSession.outboundLegHttpAnswered = false;
        callerSession.outboundLegRingSent = false;
        callerSession.outboundWebrtcTransportReady = false;

        const pc = this.attachOutboundDataChannel(callerSessionId, legSession);
        // DC-only session offer (mirrors the caller's HTTP handshake): audio is
        // negotiated later via the poly ring (audio offer over the data channel),
        // so the callee only sets up its PC/DC here. Legacy callers (multiring,
        // etc.) keep the audio-in-session-offer behavior unless dcOnly is set.
        if (!options.dcOnly) {
            legSession.localAudioTrack = new this.MediaStreamTrack({ kind: "audio" });
            pc.addTrack(legSession.localAudioTrack);
        }
        legSession.iceCandidates = [];

        const offer = await pc.createOffer();
        let baseOfferSdp = offer.sdp;
        if (callerSession.mediaCodecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(baseOfferSdp, callerSession.mediaCodecPolicy);
            if (narrowedOfferSdp !== baseOfferSdp) {
                this.logger.log(`[${callerSessionId}] WebRTC callee leg inherited bridge codec policy=${callerSession.mediaCodecPolicy}`);
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
        // Send the callee the SAME srflx+relay set the caller gets in our answer --
        // NOT relay-only. A relay-only callee strips embedded-SDP candidates and only
        // reads this `candidates` array, so a relay-only list leaves it with just our
        // TURN relay (134.x). Its sole pair is then callee-relay <-> server-relay, both
        // on the TURN's own IP, which coturn refuses to hairpin (loopback peer) -> ICE
        // fails. Our public srflx (the AWS elastic IP) lets it pair callee-relay <->
        // server-srflx, the exact path the caller leg already connects on.
        const offerSdp = this.embedCandidatesInSdp(baseOfferSdp, candidatesToEmbed);
        const sourceOffer = callerSession.lastRingOfferPayload || null;

        const callPayload = serializeNotifyPayload(buildOfferPayload({
            from: callerNumberLabel,
            to: calleeEns,
            sessionId: signalingSessionId,
            sdp: offerSdp,
            candidates: candidatesToEmbed,
            callNonce: sourceOffer?.callNonce || callerSession.callNonce || null,
            isCall: true,
            extra: {
                ...(sourceOffer?.xdata ? { xdata: sourceOffer.xdata } : {}),
                ...(sourceOffer?.xsign ? { xsign: sourceOffer.xsign } : {}),
                label: callerNumberLabel || undefined,
                ...(options.payload || {}),
            },
        }));
        this.logger.log(
            `[${callerSessionId}] outbound WebRTC invite payload from=${callerNumberLabel} ` +
            `to=${calleeEns} sessionId=${signalingSessionId}`
        );

        return {
            callerSession,
            legSession,
            legSessionId: options.kind === "multi" ? walletKey : callerSessionId,
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
