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

    // PolySession.connect: transport is established by the ingress/factory layer.
    // A callee leg has no transport until it is invited (ring), so only the
    // caller leg asserts an existing PC here.
    async connect() {
        if (this.role === "callee") return;
        if (!this.pc) throw new Error(`[${this.id}] WebRtc leg has no peer connection`);
    }

    async ring(ctx = {}) {
        if (this.role === "callee") return this._inviteCallee(ctx);
        return this._sendDataChannelRing(ctx);
    }

    // Callee leg: create the outbound PC + FCM-invite the callee. Delegates to the
    // proven WebRtcOutboundLegFactory (via injected inviteCallee) so the invite
    // payload/codec/ICE handling stays identical to the legacy path. The created
    // legSession (caller.outboundWebrtc) becomes this leg's transport state; the
    // callee's pickup later arrives as an ANSWER ingress event.
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
                sessionId: session.sessionId,
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
        // We do NOT ack here: P decides WHEN to ack (reconcile emits the ACK
        // intent); this adapter only knows HOW (ackRing below).
        this._pendingAnswerSdp = answerSdp;
    }

    // HOW to ack this endpoint's ring (P decides WHEN via the ACK intent).
    // No persistent guard: every ring P tells us to ack gets an ack. P already
    // emits the ACK intent exactly once per ring (gated on the CALLING event),
    // so two rings => two acks, even when this leg is reused across calls.
    async ackRing() {
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "ring" });
    }

    // This endpoint's client answered our ring: apply its answer. Ported from
    // AnswerCallUseCase.handleOutboundWebrtcLegAnswer.
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
