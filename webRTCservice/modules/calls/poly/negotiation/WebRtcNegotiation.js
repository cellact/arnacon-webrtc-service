// Concrete CallNegotiationPort for a WebRTC endpoint. Ports the SDP flows that
// used to live across StartCallUseCase / AnswerCallUseCase / RenegotiateCallUseCase
// into one transport adapter, driven by the leg's own peer connection + data
// channel. Depends only on injected low-level primitives (the same helpers the
// legacy use cases received) + a SignalingTransportPort, so it stays testable
// and free of global reaches.

const { CallNegotiationPort } = require("../ports");
const { LEG_STATES } = require("../states");
const { WebRtcClientLeg } = require("../../../media/legs/WebRtcClientLeg");
const {
    normalizeEndCallOfferSdp,
    alignEndCallAnswerSdp,
    audioDirection,
} = require("./sdp");
const {
    identityLabel,
} = require("../../../runtime/CallPairRef");

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

    _normalizeCallId(value) {
        if (value === undefined || value === null || value === "") return null;
        const n = Number.parseInt(String(value), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    _allocateCallId() {
        const now = Date.now() % 1000000000;
        const salt = Math.floor(Math.random() * 1000);
        return Math.max(1, now + salt);
    }

    _rememberCallMeta(payload = {}) {
        const session = this.session || {};
        if (!session._activeCallMeta) session._activeCallMeta = {};
        const meta = session._activeCallMeta;

        if (payload.from) meta.remoteIdentity = payload.from;
        if (payload.to) meta.localIdentity = payload.to;
        if (payload.sessionId) meta.signalingSessionId = payload.sessionId;

        const payloadCallId = this._normalizeCallId(payload.callId);
        if (payloadCallId) {
            meta.callId = payloadCallId;
            return;
        }
        if (!meta.callId) {
            meta.callId = this._allocateCallId();
        }
    }

    _activeCallMeta() {
        const session = this.session || {};
        if (!session._activeCallMeta) session._activeCallMeta = {};
        const meta = session._activeCallMeta;
        if (!meta.callId) {
            meta.callId = this._allocateCallId();
        }
        if (!meta.remoteIdentity) {
            meta.remoteIdentity = identityLabel(session.callerEns);
        }
        if (!meta.localIdentity) {
            meta.localIdentity = session.toIdentity;
        }
        if (!meta.signalingSessionId) {
            meta.signalingSessionId = session.signalingSessionId || session.sessionId;
        }
        return meta;
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
        // A MULTI_RING candidate already negotiated audio in its authenticated
        // session offer and the coordinator has already observed the user's
        // pickup. PolySession still needs the leg to enter RINGING so its normal
        // two-leg policy can answer SIP, but sending a second offer here would
        // invalidate the ready transport.
        if (this.session.multiRingPreNegotiated) return;
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
        this._rememberCallMeta({
            from: identityLabel(session.callerEns),
            to: session.toIdentity,
            sessionId: session.signalingSessionId || session.sessionId,
        });
        const callMeta = this._activeCallMeta();

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
        // Narrow the ring offer to the route's codec policy (e.g. PCMA only for
        // webrtc<->webrtc) so the callee answers with that single codec and the
        // G711-only bridge relays cleanly. Without this the offer carries opus and
        // the two legs can settle on mismatched codecs -> grain noise.
        if (session.mediaCodecPolicy && this.p.narrowAudioOfferForCodecPolicy) {
            const narrowed = this.p.narrowAudioOfferForCodecPolicy(offer.sdp, session.mediaCodecPolicy);
            if (narrowed !== offer.sdp) offer.sdp = narrowed;
        }
        await pc.setLocalDescription(offer);
        await this.p.waitForIceGathering(pc);
        const gathered = this.p.formatIceCandidates(session).filter((c) => !String(c.candidate || "").toLowerCase().includes(" tcp "));
        const srflxRelay = gathered.filter((c) => c.candidate.includes("typ srflx") || c.candidate.includes("typ relay"));
        const toEmbed = srflxRelay.length > 0 ? srflxRelay : gathered;
        const offerSdp = this.p.embedCandidatesInSdp(offer.sdp, toEmbed);
        this.p.logSdp?.(this.id, "RING OFFER SDP", offerSdp);
        const fromLabel = identityLabel(session.callerEns);
        this.signaling.send({
            msgType: "signaling",
            callId: callMeta.callId,
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
                callId: callMeta.callId,
                // srflx+relay, not relay-only: a relay-only client can only reach us
                // via our public srflx (relay<->relay on the same TURN is refused as a
                // loopback peer). Same reasoning as the outbound invite candidates.
                candidates: toEmbed,
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
        this._rememberCallMeta(payload);
        const isIceRestart = ctx.mode === "ice-restart";
        let offerSdp = payload.sdp;
        // Pin the audio to the route's codec policy (e.g. PCMA for webrtc<->webrtc)
        // BEFORE answering, so PC1's answer can only contain that codec. Otherwise
        // werift re-exposes/re-orders opus in the answer, the client sends opus, and
        // the G711-only media bridge relays opus bytes the peer decodes as PCMA ->
        // grain noise. Mirrors the legacy narrowing the poly cutover dropped.
        if (this.session.mediaCodecPolicy && this.p.narrowAudioOfferForCodecPolicy) {
            offerSdp = this.p.narrowAudioOfferForCodecPolicy(offerSdp, this.session.mediaCodecPolicy);
        }
        if (audioDirection(offerSdp) === "inactive" && this.p.patchInactiveToSendrecv) {
            offerSdp = this.p.patchInactiveToSendrecv(offerSdp);
        }
        const offerHasAudio = this._offerHasAudioMLine(offerSdp);
        if (!isIceRestart && offerHasAudio) this._ensureAudioReadyForOffer(offerSdp, pc);
        await this._setRemoteOfferWithRecovery(pc, offerSdp);
        await this.p.addIceCandidates?.(pc, payload.candidates || []);
        // On ICE restart the track set is unchanged; only the caller-ring path
        // needs to (re)attach the local audio track.
        if (!isIceRestart && offerHasAudio && this.p.ensureLocalAudioTrack) {
            this.p.ensureLocalAudioTrack(this.session, pc, this.id);
        }
        const label = isIceRestart ? "ICE-RESTART ANSWER SDP" : "ANSWER SDP";
        const answerSdp = await this._createAnswerWithRecovery(pc, offerSdp, label);
        this.session.lastAnswerSdp = answerSdp;
        // In-call renegotiation (ICE restart) answers immediately. For a fresh
        // ring we hold the answer: the caller must not see "connected" until the
        // peer actually picks up. PolySession fires answer() (peer reached
        // in-call) and we flush the held SDP then.
        if (isIceRestart) {
            const callMeta = this._activeCallMeta();
            this.signaling.send({
                msgType: "signaling",
                callId: callMeta.callId,
                payload: {
                    type: "answer",
                    from: identityLabel(this.session.callerEns),
                    to: this.session.toIdentity,
                    sessionId: this.session.sessionId,
                    sdp: answerSdp,
                    callId: callMeta.callId,
                },
            });
            return;
        }
        // Hold the answer SDP until PolySession fires answer() (peer picked up).
        // We do NOT ack here: P decides WHEN to ack (reconcile emits ACK_CONNECTED
        // on the fresh ring); this adapter only knows HOW (ackConnected above).
        this._pendingAnswerSdp = answerSdp;
    }

    _offerHasAudioMLine(sdp = "") {
        return /\bm=audio\b/.test(sdp);
    }

    _offerAudioMid(sdp = "") {
        const sections = String(sdp).split(/\r?\nm=/);
        for (const rawSection of sections) {
            const section = rawSection.startsWith("m=") ? rawSection : `m=${rawSection}`;
            if (!/^m=audio\b/m.test(section)) continue;
            const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1];
            if (mid) return String(mid).trim();
        }
        return null;
    }

    _isMissingMidError(err) {
        const msg = String(err?.message || "");
        return /Transceiver with mid=\d+ not found/i.test(msg);
    }

    _isMLineOrParserMappingError(err) {
        const msg = String(err?.message || "");
        return (
            /m[-\s]?line not found/i.test(msg) ||
            /iceParams/i.test(msg) ||
            /media section/i.test(msg)
        );
    }

    _offerMediaSections(sdp = "") {
        const out = [];
        const parts = String(sdp).split(/\r?\nm=/);
        for (let i = 0; i < parts.length; i += 1) {
            const section = i === 0 ? parts[i] : `m=${parts[i]}`;
            if (!/^m=/m.test(section)) continue;
            const kind = section.match(/^m=([^\s]+)/m)?.[1] || null;
            const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1] || null;
            out.push({ kind, mid: mid ? String(mid).trim() : null, raw: section });
        }
        return out;
    }

    _alignTransceiversToOffer(pc, sdp) {
        const sections = this._offerMediaSections(sdp);
        const hasAudio = sections.some((s) => s.kind === "audio");
        const audioOfferMids = new Set(
            sections
                .filter((s) => s.kind === "audio" && s.mid)
                .map((s) => String(s.mid)),
        );
        const audioTransceivers = pc.getTransceivers?.().filter((t) => t.kind === "audio") || [];
        if (!audioTransceivers.length) return;
        for (const transceiver of audioTransceivers) {
            const currentMid = String(transceiver?.mid || "").trim();
            const midIsOffered = currentMid && audioOfferMids.has(currentMid);
            if (hasAudio && midIsOffered) continue;
            try { transceiver.setDirection?.("inactive"); } catch (_) {}
            try { transceiver.sender?.replaceTrack?.(null); } catch (_) {}
        }
    }

    _extractMissingMidFromError(err) {
        const msg = String(err?.message || "");
        const mid = msg.match(/Transceiver with mid=(\d+) not found/i)?.[1];
        return mid || null;
    }

    async _setRemoteOfferWithRecovery(pc, offerSdp) {
        let forceCreate = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await pc.setRemoteDescription(new this.p.RTCSessionDescription(offerSdp, "offer"));
                return;
            } catch (err) {
                const hasAudio = this._offerHasAudioMLine(offerSdp);
                const isMissingMid = this._isMissingMidError(err);
                const isParserMapping = this._isMLineOrParserMappingError(err);
                if (!isMissingMid && !isParserMapping) throw err;
                this._alignTransceiversToOffer(pc, offerSdp);
                if (hasAudio) {
                    const missingMid = this._extractMissingMidFromError(err);
                    this._repairAudioForOfferMid(offerSdp, pc, { preferredMid: missingMid, forceCreate });
                }
                forceCreate = true;
                if (attempt === 2) throw err;
            }
        }
    }

    async _createAnswerWithRecovery(pc, offerSdp, label) {
        let forceCreate = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await this.p.createAnswerSdp(pc, this.id, label);
            } catch (err) {
                const hasAudio = this._offerHasAudioMLine(offerSdp);
                const isMissingMid = this._isMissingMidError(err);
                const isParserMapping = this._isMLineOrParserMappingError(err);
                if (!isMissingMid && !isParserMapping) throw err;
                this._alignTransceiversToOffer(pc, offerSdp);
                if (hasAudio) {
                    const missingMid = this._extractMissingMidFromError(err);
                    this._repairAudioForOfferMid(offerSdp, pc, { preferredMid: missingMid, forceCreate });
                }
                forceCreate = true;
                if (attempt === 2) throw err;
            }
        }
        return undefined;
    }

    _isTrackAlreadyAddedError(err) {
        const msg = String(err?.message || "");
        return /Track already added/i.test(msg);
    }

    _isTrackBoundToAudioTransceiver(pc, track) {
        if (!track) return false;
        const audioTransceivers = pc.getTransceivers?.().filter((t) => t.kind === "audio") || [];
        return audioTransceivers.some((t) => t?.sender?.track === track);
    }

    _primeAudioTransceiver(transceiver, track) {
        if (!transceiver) return;
        try { transceiver.setDirection?.("sendrecv"); } catch (_) {}
        if (!track) return;
        try { transceiver.sender?.registerTrack?.(track); } catch (_) {}
        try { transceiver.sender?.replaceTrack?.(track); } catch (_) {}
    }

    _repairAudioForOfferMid(sdp, pc, opts = {}) {
        this._ensureAudioReadyForOffer(sdp, pc, { force: true });
        const offerMid = String(opts.preferredMid || this._offerAudioMid(sdp) || "").trim() || null;
        const forceCreate = opts.forceCreate === true;
        const preferredFromError = String(opts.preferredMid || "").trim() || null;
        const track = this.session.localAudioTrack || null;
        const audioTransceivers = pc.getTransceivers?.().filter((t) => t.kind === "audio") || [];
        for (const transceiver of audioTransceivers) this._primeAudioTransceiver(transceiver, track);
        if (!offerMid || audioTransceivers.length === 0) return;

        const hasExactMid = () =>
            (pc.getTransceivers?.().some((t) => t.kind === "audio" && String(t.mid || "") === offerMid) ?? false);
        if (hasExactMid() && !forceCreate) return;

        // If the stack explicitly reported a missing MID, prefer creating/syncing that
        // MID before retagging existing transceivers. Some implementations keep an
        // internal MID map that lags behind exposed transceiver.mid changes.
        const canRetagExisting = !preferredFromError;
        if (canRetagExisting) {
            const candidate =
                audioTransceivers.find((t) => t.mid == null || t.mid === "") ||
                audioTransceivers[0];
            if (candidate && String(candidate.mid || "") !== offerMid) {
                try { candidate.mid = offerMid; } catch (_) {}
            }
            if (hasExactMid() && !forceCreate) return;
        }

        // Final fallback: try creating/binding a fresh audio transceiver if the
        // implementation supports it.
        if (typeof pc.addTransceiver === "function") {
            let created = null;
            try {
                created = track
                    ? pc.addTransceiver(track, { direction: "sendrecv" })
                    : pc.addTransceiver("audio", { direction: "sendrecv" });
            } catch (_) {}
            // Some stacks reject addTransceiver(track) when that track is already
            // attached; retry with kind-only to still create the missing MID slot.
            if (!created) {
                try {
                    created = pc.addTransceiver("audio", { direction: "sendrecv" });
                } catch (_) {}
            }
            if (created) {
                try { created.mid = offerMid; } catch (_) {}
                this._primeAudioTransceiver(created, track);
            }
        }

        if (!hasExactMid()) {
            const candidate =
                (pc.getTransceivers?.().find((t) => t.kind === "audio" && (t.mid == null || t.mid === ""))) ||
                (pc.getTransceivers?.().find((t) => t.kind === "audio")) ||
                null;
            if (candidate && String(candidate.mid || "") !== offerMid) {
                try { candidate.mid = offerMid; } catch (_) {}
            }
        }
    }

    _ensureAudioReadyForOffer(sdp, pc, opts = {}) {
        if (!this._offerHasAudioMLine(sdp)) return;
        const force = opts.force === true;
        const audioTransceiver = pc.getTransceivers?.().find((t) => t.kind === "audio");
        if (audioTransceiver && !force) {
            this._primeAudioTransceiver(audioTransceiver, this.session.localAudioTrack || null);
            return;
        }

        if (!this.session.localAudioTrack) {
            this.session.localAudioTrack = new this.MediaStreamTrack({ kind: "audio" });
        }
        const track = this.session.localAudioTrack;
        const alreadyBound = this._isTrackBoundToAudioTransceiver(pc, track);
        if (!alreadyBound && typeof pc.addTrack === "function") {
            try {
                pc.addTrack(track);
            } catch (err) {
                if (!this._isTrackAlreadyAddedError(err)) throw err;
            }
        }
        const latestAudio = pc.getTransceivers?.().find((t) => t.kind === "audio");
        if (latestAudio) this._primeAudioTransceiver(latestAudio, track);
    }

    // The caller's client offered a ring and we are connected: ack it so the
    // client stops re-offering. The ios client needs an ack-for-ring here even
    // though, server-side, the peer is only being reached now. No persistent
    // guard: P fires this once per fresh ring (gated on the CALLING event), so a
    // reused leg gets a fresh ack on each new call.
    async ackConnected() {
        const callMeta = this._activeCallMeta();
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "ring", callId: callMeta.callId });
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
        // The client bundles its ICE candidates in a separate `candidates` array
        // (its answer SDP carries no a=candidate lines). They MUST be added or
        // werift never installs the TURN permission for a relay-only client's
        // relay address -> its connectivity checks are dropped -> ICE fails.
        await this.p.addIceCandidates?.(pc, payload.candidates || []);
    }

    // This endpoint's client accepted the call (answer to our ring's audio offer):
    // apply its answer and ack. Ported from AnswerCallUseCase.handleOutboundWebrtcLegAnswer.
    async applyAnswer(ctx = {}) {
        const pc = this.pc;
        if (!pc) throw new Error(`[${this.id}] cannot apply answer without a peer connection`);
        const payload = ctx.payload || {};
        this._rememberCallMeta(payload);
        // Inbound MULTI_RING candidates negotiate audio in the authenticated HTTP
        // session answer before the user picks up. Their later data-channel
        // `answer` is the verified acceptance signal, not a second SDP answer.
        if (payload.sdp) {
            await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "answer"));
            await this.p.addIceCandidates?.(pc, payload.candidates || []);
        } else if (!this.session.multiRingPreNegotiated) {
            throw new Error(`[${this.id}] call answer missing SDP`);
        }
        const callMeta = this._activeCallMeta();
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "answer", callId: callMeta.callId });
    }

    // PolySession told us the peer picked up. Flush the answer SDP we held back
    // during the ring (so the caller only now negotiates audio / shows connected),
    // then ack. If there is no held answer (e.g. ICE-restart already answered),
    // just ack.
    async answer(ctx = {}) {
        const callMeta = this._activeCallMeta();
        // Normal path: flush locally-held answer generated from our ring offer.
        // Fallback path: if this leg has no pending local answer (e.g. caller leg
        // in secnum<->secnum), forward the peer-provided answer from latest ingress
        // so the caller still receives the SDP answer signal.
        let answerSdp = this._pendingAnswerSdp;
        let answerCandidates = [];
        const ingressPayload = ctx?.event?.payload || null;
        if (!answerSdp && ingressPayload?.sdp) {
            answerSdp = ingressPayload.sdp;
            if (Array.isArray(ingressPayload.candidates)) {
                answerCandidates = ingressPayload.candidates;
            }
        }
        if (answerSdp) {
            this.signaling.send({
                msgType: "signaling",
                callId: callMeta.callId,
                payload: {
                    type: "answer",
                    from: identityLabel(this.session.callerEns),
                    to: this.session.toIdentity,
                    sessionId: this.session.sessionId,
                    sdp: answerSdp,
                    candidates: answerCandidates,
                    callId: callMeta.callId,
                },
            });
            this._pendingAnswerSdp = null;
        }
        this.signaling.send({ msgType: "call", action: "ack", ackFor: "answer", callId: callMeta.callId });
    }

    // The client asked to end (sent us its end-call reneg offer). Answer it
    // inactive (audio off, data channel/transport kept) -> the leg returns to
    // CONNECTED, reusable for a future call. Driven by PolySession's ACK_END.
    //
    // The iOS client sends a bare `call`/`end` signal (no SDP) BEFORE its end-call
    // reneg offer. That bare signal drives the leg to END_REQUESTED, so ackEnd can
    // run before any offer is available. Without an offer there is nothing to
    // answer (createAnswer would fail): just return to CONNECTED. The reneg offer
    // that follows is answered via the remote-absorb path while CONNECTED.
    async ackEnd(ctx = {}) {
        const pc = this.pc;
        const payload = ctx.payload || {};
        this._rememberCallMeta(payload);
        if (pc && payload.sdp) await this._answerEndCallOffer(pc, payload);
        return { state: LEG_STATES.CONNECTED };
    }

    // Teardown. mode "remote" => the client drove the end (completing/absorbing:
    // we apply its answer, or answer its trailing offer). Otherwise WE initiate the
    // end-call renegotiation: send an inactive offer and defer -- the leg stays
    // ENDING until the client's end-call answer ingress lands -> CONNECTED.
    // Ported from RenegotiateCallUseCase.
    async endCall(ctx = {}) {
        const pc = this.pc;
        if (!pc) return; // already gone
        const payload = ctx.payload || {};
        this._rememberCallMeta(payload);
        const callMeta = this._activeCallMeta();

        if (ctx.mode === "remote") {
            // Client drove the end. NEVER (re)initiate an end-call offer here.
            if (payload.type === "answer") {
                // The peer answered the end-call offer WE sent -> the data-only
                // renegotiation is complete (its audio is released). Now send the
                // call-level END signal: the reneg only tears down audio; the iOS
                // client ends the call (CallKit/UI) only on this `call`/`end`.
                if (payload.sdp) {
                    await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "answer"));
                }
                this.signaling.send({
                    msgType: "signaling",
                    action: "end-call",
                    callId: callMeta.callId,
                });
            } else if (payload.sdp) {
                // client sent an inactive offer -> answer it inactive (reusable).
                await this._answerEndCallOffer(pc, payload);
            }
            // bare `call`/`end` signal (no SDP): nothing to negotiate at the SDP layer.
            return;
        }

        // Initiated by us toward this leg: send an inactive end-call offer, then
        // wait for the client's end-call answer (handled as an END ingress -> the
        // leg settles CONNECTED). Stay ENDING in the meantime.
        await this._setAudioInactive(pc);
        const offer = await pc.createOffer();
        const offerSdp = normalizeEndCallOfferSdp(offer.sdp);
        await pc.setLocalDescription(new this.p.RTCSessionDescription(offerSdp, "offer"));
        this.p.logSdp?.(this.id, "END-CALL OFFER SDP", offerSdp);
        const localFrom = callMeta.localIdentity || (ctx.from ? identityLabel(ctx.from) : identityLabel(this.session.callerEns));
        const remoteTo = callMeta.remoteIdentity || identityLabel(this.session.callerEns);
        this.signaling.send({
            msgType: "signaling",
            action: "end-call",
            callId: callMeta.callId,
            payload: {
                type: "offer",
                from: localFrom,
                to: remoteTo,
                sessionId: callMeta.signalingSessionId || this.session.sessionId,
                sdp: offerSdp,
                callId: callMeta.callId,
            },
        });
        return { deferred: true };
    }

    // Answer a client's inactive end-call offer (audio off, transport kept) and
    // send the end-call answer back. Shared by ackEnd + the remote-absorb path.
    async _answerEndCallOffer(pc, payload = {}) {
        this._rememberCallMeta(payload);
        const callMeta = this._activeCallMeta();
        if (payload.sdp) {
            await pc.setRemoteDescription(new this.p.RTCSessionDescription(payload.sdp, "offer"));
        }
        await this._setAudioInactive(pc);
        const answer = await pc.createAnswer();
        const answerSdp = alignEndCallAnswerSdp(answer.sdp, payload.sdp || answer.sdp);
        await pc.setLocalDescription(new this.p.RTCSessionDescription(answerSdp, "answer"));
        this.p.logSdp?.(this.id, "END-CALL ANSWER SDP", answerSdp);
        this.signaling.send({
            msgType: "signaling",
            action: "end-call",
            callId: callMeta.callId,
            payload: {
                type: "answer",
                from: callMeta.localIdentity || identityLabel(this.session.toIdentity || this.session.callerEns),
                to: callMeta.remoteIdentity || identityLabel(this.session.callerEns),
                sessionId: callMeta.signalingSessionId || this.session.sessionId,
                sdp: answerSdp,
                callId: callMeta.callId,
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
