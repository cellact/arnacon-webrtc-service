// Concrete CallNegotiationPort for a WebRTC endpoint. Ports the SDP flows that
// used to live across StartCallUseCase / AnswerCallUseCase / RenegotiateCallUseCase
// into one transport adapter, driven by the leg's own peer connection + data
// channel. Depends only on injected low-level primitives (the same helpers the
// legacy use cases received) + a SignalingTransportPort, so it stays testable
// and free of global reaches.

const { CallNegotiationPort } = require("../ports");
const { WebRtcClientLeg } = require("../../../media/legs/WebRtcClientLeg");
const {
    normalizeEndCallOfferSdp,
    alignEndCallAnswerSdp,
    audioDirection,
} = require("./sdp");

function identityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

class WebRtcNegotiation extends CallNegotiationPort {
    constructor({
        id,
        endpoint,
        session,
        role = "caller", // "caller": client offered to us; "callee": we invite via FCM
        signaling, // SignalingTransportPort -> this endpoint's data channel
        primitives, // { RTCSessionDescription, MediaStreamTrack, createAnswerSdp,
                    //   waitForIceGathering, formatIceCandidates, getRelayCandidates,
                    //   embedCandidatesInSdp, patchInactiveToSendrecv, ensureLocalAudioTrack, logSdp }
        MediaStreamTrack,
        // Callee role only: delegates the proven FCM-invite transport to the
        // existing outbound leg factory. Returns the created legSession (which is
        // callerSession.outboundWebrtc). Keeps us from reimplementing the invite.
        inviteCallee = null, // async ({ leg, destination }) -> legSession
        destination = null, // resolved peer { wallet, ensName } for the invite
        logger = console,
    } = {}) {
        super();
        if (!signaling) throw new Error("WebRtcNegotiation requires a SignalingTransportPort");
        if (!primitives) throw new Error("WebRtcNegotiation requires SDP primitives");
        if (role === "caller" && !session) {
            throw new Error("WebRtcNegotiation (caller) requires a session/transport state");
        }
        this.id = id;
        this.endpoint = endpoint;
        this.role = role;
        this.session = session || null; // callee: bound lazily on ring()
        this.signaling = signaling;
        this.p = primitives;
        this.MediaStreamTrack = MediaStreamTrack || primitives.MediaStreamTrack;
        this.inviteCallee = inviteCallee;
        this.destination = destination;
        this.logger = logger;
    }

    get pc() {
        return this.session?.peerConnection || null;
    }

    // PolySession.connect:
    //   caller: its PC was established upstream (HTTP handshake) -> just assert it.
    //   callee: bring up the transport by FCM-inviting it with a DC-only session
    //           offer. This returns { deferred: true } so the leg stays CONNECTING
    //           until the callee's data channel opens (TRANSPORT_OPEN ingress);
    //           the callee's session answer arrives in between as a (session)
    //           ANSWER ingress. Audio is negotiated later, on ring().
    async connect(ctx = {}) {
        if (this.role === "callee") {
            await this._inviteCallee(ctx);
            return { deferred: true };
        }
        if (!this.pc) throw new Error(`[${this.id}] WebRtc leg has no peer connection`);
        return undefined;
    }

    // Present the call to this endpoint: send a fresh RING + audio offer over its
    // data channel (renegotiating audio on top of the DC-only session). Same for a
    // caller leg being re-rung and a freshly-connected callee leg.
    async ring(ctx = {}) {
        return this._sendDataChannelRing(ctx);
    }

    // Callee leg: create the outbound PC (DC-only) + FCM-invite the callee.
    // Delegates to the proven WebRtcOutboundLegFactory (via injected inviteCallee)
    // so the invite payload/ICE handling stays identical to the legacy path. The
    // created legSession (caller.outboundWebrtc) becomes this leg's transport
    // state; the callee's session answer arrives later as an ANSWER ingress while
    // still CONNECTING.
    async _inviteCallee(ctx = {}) {
        if (typeof this.inviteCallee !== "function") {
            throw new Error(`[${this.id}] callee leg has no inviteCallee transport`);
        }
        const destination = ctx.destination || this.destination;
        if (!destination) throw new Error(`[${this.id}] callee leg ring without a resolved destination`);
        const legSession = await this.inviteCallee({ leg: ctx.leg, destination, ...ctx });
        if (legSession) this.session = legSession;
        return legSession;
    }

    // Caller leg: send a fresh RING offer over this endpoint's data channel.
    // Ported from StartCallUseCase.sendInboundRing.
    async _sendDataChannelRing(ctx = {}) {
        const session = this.session;
        const pc = this.pc;
        if (!pc) throw new Error(`[${this.id}] cannot ring without a peer connection`);

        if (!session.localAudioTrack) {
            const track = new this.MediaStreamTrack({ kind: "audio" });
            session.localAudioTrack = track;
            pc.addTrack(track);
        } else {
            const audioT = pc.getTransceivers().find((t) => t.kind === "audio");
            if (audioT) audioT.setDirection("sendrecv");
        }
        session.iceCandidates = [];
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this.p.waitForIceGathering(pc);
        const gathered = this.p.formatIceCandidates(session).filter((c) => !String(c.candidate || "").toLowerCase().includes(" tcp "));
        const srflxRelay = gathered.filter((c) => c.candidate.includes("typ srflx") || c.candidate.includes("typ relay"));
        const toEmbed = srflxRelay.length > 0 ? srflxRelay : gathered;
        const relayCandidates = this.p.getRelayCandidates(gathered);
        const offerSdp = this.p.embedCandidatesInSdp(offer.sdp, toEmbed);
        this.p.logSdp?.(this.id, "RING OFFER SDP", offerSdp);
        const fromLabel = identityLabel(session.callerEns);
        this.signaling.send({
            msgType: "signaling",
            payload: {
                type: "offer",
                from: ctx.from ? identityLabel(ctx.from) : fromLabel,
                to: session.toIdentity,
                // A callee leg negotiated its session under the "caller|callee"
                // signaling id (set by the outbound factory); reuse it so the
                // client matches this ring to that session. Caller legs fall back
                // to their own session id.
                sessionId: session.signalingSessionId || session.sessionId,
                sdp: offerSdp,
                candidates: relayCandidates,
                label: fromLabel,
            },
        });
    }

    // This endpoint's client sent an offer (ring): apply it and answer. Ported
    // from StartCallUseCase.handleRing SDP portion + AnswerCallUseCase answer.
    async applyOffer(ctx = {}) {
        const pc = this.pc;
        if (!pc) throw new Error(`[${this.id}] cannot apply offer without a peer connection`);
        const payload = ctx.payload || {};
        const isIceRestart = ctx.mode === "ice-restart";
        let offerSdp = payload.sdp;
        if (audioDirection(offerSdp) === "inactive" && this.p.patchInactiveToSendrecv) {
            offerSdp = this.p.patchInactiveToSendrecv(offerSdp);
        }
        await pc.setRemoteDescription(new this.p.RTCSessionDescription(offerSdp, "offer"));
        // On ICE restart the track set is unchanged; only the caller-ring path
        // needs to (re)attach the local audio track.
        if (!isIceRestart && this.p.ensureLocalAudioTrack) {
            this.p.ensureLocalAudioTrack(this.session, pc, this.id);
        }
        const label = isIceRestart ? "ICE-RESTART ANSWER SDP" : "ANSWER SDP";
        const answerSdp = await this.p.createAnswerSdp(pc, this.id, label);
        this.session.lastAnswerSdp = answerSdp;
        // In-call renegotiation (ICE restart) answers immediately. For a fresh
        // ring we hold the answer: the caller must not see "connected" until the
        // peer actually picks up. PolySession fires answer() (peer reached
        // in-call) and we flush the held SDP then.
        if (isIceRestart) {
            this.signaling.send({
                msgType: "signaling",
                payload: {
                    type: "answer",
                    from: identityLabel(this.session.callerEns),
                    to: this.session.toIdentity,
                    sessionId: this.session.sessionId,
                    sdp: answerSdp,
                },
            });
            return;
        }
        // Hold the answer SDP until PolySession fires answer() (peer picked up).
        // We do NOT ack here: P decides WHEN to ack (reconcile emits ACK_CONNECTED
        // on the fresh ring); this adapter only knows HOW (ackConnected above).
        this._pendingAnswerSdp = answerSdp;
    }

    // The caller's client offered a ring and we are connected: ack it so the
    // client stops re-offering. The ios client needs an ack-for-ring here even
    // though, server-side, the peer is only being reached now. No persistent
    // guard: P fires this once per fresh ring (gated on the CALLING event), so a
    // reused leg gets a fresh ack on each new call.
    async ackConnected() {
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "ring" });
    }

    // The peer is actually ringing now. The webrtc caller already received its
    // ack-for-ring at connect (ackConnected), so there is nothing more to send.
    async ackRing() {
        // no-op for webrtc
    }

    // The callee answered our session offer (bringing its PC/DC up) -- NOT a call
    // accept. Apply the remote SDP and return; we do NOT ack (the data channel may
    // not be open yet; the /notify HTTP response is the client's ack) and we do
    // NOT advance to in-call (the leg stays connecting until the DC opens).
    async applySessionAnswer(ctx = {}) {
        const pc = this.pc;
        if (!pc) throw new Error(`[${this.id}] cannot apply session answer without a peer connection`);
        const payload = ctx.payload || {};
        await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "answer"));
    }

    // This endpoint's client accepted the call (answer to our ring's audio offer):
    // apply its answer and ack. Ported from AnswerCallUseCase.handleOutboundWebrtcLegAnswer.
    async applyAnswer(ctx = {}) {
        const pc = this.pc;
        if (!pc) throw new Error(`[${this.id}] cannot apply answer without a peer connection`);
        const payload = ctx.payload || {};
        await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "answer"));
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "answer" });
    }

    // PolySession told us the peer picked up. Flush the answer SDP we held back
    // during the ring (so the caller only now negotiates audio / shows connected),
    // then ack. If there is no held answer (e.g. ICE-restart already answered),
    // just ack.
    async answer() {
        if (this._pendingAnswerSdp) {
            this.signaling.send({
                msgType: "signaling",
                payload: {
                    type: "answer",
                    from: identityLabel(this.session.callerEns),
                    to: this.session.toIdentity,
                    sessionId: this.session.sessionId,
                    sdp: this._pendingAnswerSdp,
                },
            });
            this._pendingAnswerSdp = null;
        }
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "answer" });
    }

    // Teardown. mode "remote" => the client drove the end (we answer its inactive
    // offer); otherwise we initiate the end-call renegotiation toward this leg.
    // Ported from RenegotiateCallUseCase.
    async endCall(ctx = {}) {
        const pc = this.pc;
        if (!pc) return; // already gone
        const payload = ctx.payload || {};

        if (ctx.mode === "remote" && payload.type === "answer") {
            await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "answer"));
            return;
        }
        if (ctx.mode === "remote" && payload.sdp) {
            // client sent an inactive offer -> answer it inactive (reusable).
            await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "offer"));
            await this._setAudioInactive(pc);
            const answer = await pc.createAnswer();
            const answerSdp = alignEndCallAnswerSdp(answer.sdp, payload.sdp);
            await pc.setLocalDescription(new this.p.RTCSessionDescription(answerSdp, "answer"));
            this.p.logSdp?.(this.id, "END-CALL ANSWER SDP", answerSdp);
            this.signaling.send({
                msgType: "signaling",
                action: "end-call",
                payload: {
                    type: "answer",
                    from: identityLabel(this.session.toIdentity || this.session.callerEns),
                    to: identityLabel(this.session.callerEns),
                    sessionId: this.session.sessionId,
                    sdp: answerSdp,
                },
            });
            return;
        }

        // Initiated by us toward this leg: send an inactive end-call offer.
        await this._setAudioInactive(pc);
        const offer = await pc.createOffer();
        const offerSdp = normalizeEndCallOfferSdp(offer.sdp);
        await pc.setLocalDescription(new this.p.RTCSessionDescription(offerSdp, "offer"));
        this.p.logSdp?.(this.id, "END-CALL OFFER SDP", offerSdp);
        this.signaling.send({
            msgType: "signaling",
            action: "end-call",
            payload: {
                type: "offer",
                from: ctx.from ? identityLabel(ctx.from) : identityLabel(this.session.callerEns),
                to: this.session.toIdentity,
                sessionId: this.session.sessionId,
                sdp: offerSdp,
            },
        });
    }

    async _setAudioInactive(pc) {
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.kind !== "audio") continue;
            transceiver.setDirection("inactive");
            if (transceiver.sender && typeof transceiver.sender.replaceTrack === "function") {
                try { await transceiver.sender.replaceTrack(null); } catch (_) {}
            }
            return true;
        }
        return false;
    }

    getMediaEndpoint() {
        return new WebRtcClientLeg({
            session: this.session,
            sessionId: this.session.sessionId || this.id,
            peerConnection: this.pc,
            MediaStreamTrack: this.MediaStreamTrack,
            logger: this.logger,
        });
    }

    async dispose() {
        const pc = this.pc;
        if (pc) {
            try { pc.close(); } catch (_) {}
            this.session.peerConnection = null;
        }
        if (this.session.dataChannel) {
            try { this.session.dataChannel.close(); } catch (_) {}
            this.session.dataChannel = null;
        }
    }
}

module.exports = {
    WebRtcNegotiation,
};
