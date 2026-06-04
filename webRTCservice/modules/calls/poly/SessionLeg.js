// SessionLeg: the strategy interface + shared base for one side of a call (the
// server's relationship to one endpoint). Concrete transports (WebRtcLeg,
// SipLeg) plug in a CallNegotiationPort; this base owns the state machine,
// intent legality, idempotency and the observer channel to PolySession.
//
// A leg changes state from two sources:
//   1. ingress  - its own client's wire messages (offer/answer/end/...)
//   2. intents  - coordination commands issued by the PolySession (ring/end/...)
// Either way it emits a single normalized state-change event upward; it never
// calls PolySession directly (one-way coupling).

const { LEG_STATES, isValidState, isTeardown } = require("./states");
const { LEG_INTENTS, LEG_EVENTS } = require("./ports");
const { assertIntentLegal, behaviorFor } = require("./LegStateBehavior");

class SessionLeg {
    constructor({ id, kind, endpoint, negotiation, logger = console } = {}) {
        if (!id) throw new Error("SessionLeg requires id");
        if (!kind) throw new Error("SessionLeg requires kind");
        if (!negotiation) throw new Error("SessionLeg requires a CallNegotiationPort");
        this.id = id;
        this.kind = kind;
        this.endpoint = endpoint || id;
        this.negotiation = negotiation;
        this.logger = logger;
        this.state = LEG_STATES.DISCONNECTED;
        // Who initiated the action that put us in the current state ("self" | peer endpoint | null).
        this.from = null;
        this._listeners = new Set();
        this._pending = false;
        // Per-leg signaling serialization (replaces the old session.signalingQueue):
        // every transport/SDP op on THIS leg runs to completion before the next
        // starts, so an ingress offer/answer can never overlap a reconcile-driven
        // ring/end on the same peer connection.
        this._signalingChain = Promise.resolve();
    }

    // Run a transport/SDP op serialized against this leg's other ops. Failures are
    // surfaced to the caller but never break the chain for subsequent ops.
    _tx(fn) {
        const run = this._signalingChain.then(() => fn());
        this._signalingChain = run.then(() => {}, () => {});
        return run;
    }

    onStateChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit(prevState, cause) {
        const event = { leg: this, legId: this.id, kind: this.kind, prevState, state: this.state, cause };
        for (const listener of [...this._listeners]) {
            try {
                listener(event);
            } catch (err) {
                this.logger.error(`[${this.id}] leg listener error: ${err.message}`);
            }
        }
    }

    // Single writer for state. Validates, records initiator, notifies observers.
    setState(next, cause = {}) {
        if (!isValidState(next)) throw new Error(`Unknown leg state "${next}"`);
        const prev = this.state;
        if (cause.from !== undefined) this.from = cause.from;
        if (prev === next) return;
        this.state = next;
        behaviorFor(next).onEnter(this, cause);
        this.logger.log(`[${this.id}] leg ${this.kind} ${prev} -> ${next}${cause.reason ? ` (${cause.reason})` : ""}`);
        this._emit(prev, cause);
    }

    // ---- Intents issued by PolySession -------------------------------------
    // Each guards legality (throws on illegal), is idempotent against repeated
    // reconcile passes, runs the transport work, then settles the state.

    async connect(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.CONNECT);
        if (this.state === LEG_STATES.CONNECTED) return;
        this.setState(LEG_STATES.CONNECTING, { reason: "connect", from: "self" });
        const result = await this._tx(() => this.negotiation.connect({ leg: this, ...ctx }));
        // Transports that establish synchronously settle to CONNECTED now. A
        // transport that only fires an out-of-band invite (a callee FCM session
        // offer) returns { deferred: true } and stays CONNECTING until its
        // transport-open ingress (the data channel opening) arrives.
        if (!result || result.deferred !== true) {
            this.setState(LEG_STATES.CONNECTED, { reason: "connected", from: "self" });
        }
    }

    async ring(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.RING);
        if (this.state === LEG_STATES.RINGING) return; // already ringing -> idempotent
        this.setState(LEG_STATES.RINGING, { reason: "ring", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.ring({ leg: this, ...ctx }));
    }

    // Ack the caller's ring once it is connected (so its client stops re-offering).
    // No state change: a wire-level "I heard you". P decides WHEN (reconcile emits
    // it on the fresh CALLING event); the transport decides HOW.
    async ackConnected(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.ACK_CONNECTED);
        await this._tx(() => this.negotiation.ackConnected?.({ leg: this, ...ctx }));
    }

    // Tell the caller the peer is actually ringing now. webrtc => no-op; sip => 180.
    // No state change; P decides WHEN (on the peer's RINGING event).
    async ackRing(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.ACK_RING);
        await this._tx(() => this.negotiation.ackRing?.({ leg: this, ...ctx }));
    }

    async answer(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.ANSWER);
        if (this.state === LEG_STATES.IN_CALL) return;
        this.setState(LEG_STATES.ANSWERING, { reason: "answer", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.answer({ leg: this, ...ctx }));
        this.setState(LEG_STATES.IN_CALL, { reason: "answered", from: ctx.from ?? null });
    }

    async endCall(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.END);
        if (this.state === LEG_STATES.ENDED) return;
        this.setState(LEG_STATES.ENDING, { reason: ctx.reason || "end", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.endCall({ leg: this, ...ctx }));
        this.setState(LEG_STATES.ENDED, { reason: ctx.reason || "ended", from: ctx.from ?? null });
    }

    async cancel(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.CANCEL);
        if (this.state === LEG_STATES.CANCELED) return;
        this.setState(LEG_STATES.CANCELING, { reason: ctx.reason || "cancel", from: ctx.from ?? null });
        // cancel == end: a pre-answer end uses the same teardown path on the leg.
        await this._tx(() => this.negotiation.endCall({ leg: this, mode: "cancel", ...ctx }));
        this.setState(LEG_STATES.CANCELED, { reason: ctx.reason || "canceled", from: ctx.from ?? null });
    }

    async reject(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.REJECT);
        if (this.state === LEG_STATES.REJECTED) return;
        this.setState(LEG_STATES.REJECTING, { reason: ctx.reason || "reject", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.endCall({ leg: this, mode: "reject", ...ctx }));
        this.setState(LEG_STATES.REJECTED, { reason: ctx.reason || "rejected", from: ctx.from ?? null });
    }

    getMediaEndpoint() {
        return this.negotiation.getMediaEndpoint({ leg: this });
    }

    async dispose(ctx = {}) {
        await this.negotiation.dispose?.({ leg: this, ...ctx });
        this._listeners.clear();
    }

    // ---- Ingress (this endpoint's own client acted) ------------------------
    // Maps a normalized wire event to a self-driven state change. The resulting
    // emit lets PolySession coordinate the peer. Subclasses may override for
    // transport-specific events but should call super for the common ones.
    async handleIngress(event = {}) {
        switch (event.type) {
            case LEG_EVENTS.TRANSPORT_OPEN:
                if (this.state === LEG_STATES.DISCONNECTED || this.state === LEG_STATES.CONNECTING) {
                    this.setState(LEG_STATES.CONNECTED, { reason: "transport-open", from: "self" });
                }
                return;
            case LEG_EVENTS.TRANSPORT_CLOSE:
                // Transport dropped. If we are not already settled/tearing down
                // (a graceful end already ran), this is an abnormal loss -> FAILED
                // (a teardown state) so PolySession ends the peer. We never go back
                // to DISCONNECTED here: that is the initial state, and treating a
                // drop as initial would let reconcile try to re-connect a dead leg.
                if (
                    !isTeardown(this.state)
                    && this.state !== LEG_STATES.ENDED
                    && this.state !== LEG_STATES.CANCELED
                    && this.state !== LEG_STATES.REJECTED
                ) {
                    this.setState(LEG_STATES.FAILED, { reason: "transport-close", from: "self" });
                }
                return;
            case LEG_EVENTS.OFFER:
                // An offer while already in-call is an in-call renegotiation
                // (ICE restart / direction change) — apply it but DO NOT reset to
                // calling, or PolySession would re-run the whole ring/bridge flow.
                if (this.state === LEG_STATES.IN_CALL) {
                    await this._tx(() => this.negotiation.applyOffer?.({ leg: this, mode: "ice-restart", ...event }));
                    return;
                }
                // Otherwise this endpoint wants to start a call.
                await this._tx(() => this.negotiation.applyOffer?.({ leg: this, mode: "ring", ...event }));
                this.setState(LEG_STATES.CALLING, { reason: "client-offer", from: "self", payload: event.payload });
                return;
            case LEG_EVENTS.ANSWER:
                // Two different answers arrive on the SAME wire action; the leg's
                // own state disambiguates (the user's "session answer vs call
                // answer" distinction):
                //   connecting -> a session-establishment answer: the callee
                //     answered our session offer to bring its PC/DC up. We have NOT
                //     presented the call yet, so apply the remote SDP and stay put
                //     (the DC can only open after this, advancing us to connected).
                //     The session answer always lands while still connecting, so
                //     this is an unambiguous discriminator.
                //   connected/ringing/... -> a real call accept (the user picked
                //     up): apply it and settle in-call so PolySession bridges media.
                if (this.state === LEG_STATES.CONNECTING) {
                    await this._tx(() => this.negotiation.applySessionAnswer?.({ leg: this, ...event }));
                    return;
                }
                // A real accept only makes sense once the call has been presented
                // (the transport is up / we are calling or ringing). An answer in
                // any other state (e.g. still disconnected, or already ended) is
                // stray -> ignore it rather than forcing in-call.
                if (
                    this.state === LEG_STATES.CONNECTED
                    || this.state === LEG_STATES.CALLING
                    || this.state === LEG_STATES.RINGING
                    || this.state === LEG_STATES.ANSWERING
                ) {
                    await this._tx(() => this.negotiation.applyAnswer?.({ leg: this, ...event }));
                    this.setState(LEG_STATES.IN_CALL, { reason: "client-answer", from: "self", payload: event.payload });
                    return;
                }
                this.logger.log(`[${this.id}] ignoring stray answer in state ${this.state}`);
                return;
            case LEG_EVENTS.END:
            case LEG_EVENTS.END_RENEGOTIATION:
            case LEG_EVENTS.REMOTE_BYE:
                // The endpoint itself is ending: drive our own teardown to a
                // settled state. The ENDING emit lets PolySession coordinate the
                // peer in parallel.
                this.setState(LEG_STATES.ENDING, { reason: event.type, from: "self", payload: event.payload });
                await this._tx(() => this.negotiation.endCall({ leg: this, mode: "remote", ...event }));
                this.setState(LEG_STATES.ENDED, { reason: event.type, from: "self" });
                return;
            case LEG_EVENTS.CANCEL:
                this.setState(LEG_STATES.CANCELING, { reason: "client-cancel", from: "self", payload: event.payload });
                await this._tx(() => this.negotiation.endCall({ leg: this, mode: "cancel", ...event }));
                this.setState(LEG_STATES.CANCELED, { reason: "client-cancel", from: "self" });
                return;
            case LEG_EVENTS.REJECT:
                this.setState(LEG_STATES.REJECTING, { reason: "client-reject", from: "self", payload: event.payload });
                await this._tx(() => this.negotiation.endCall({ leg: this, mode: "reject", ...event }));
                this.setState(LEG_STATES.REJECTED, { reason: "client-reject", from: "self" });
                return;
            default:
                // ICE/DTMF/HOLD are transport effects with no state meaning at this layer.
                await this._tx(() => this.negotiation.handleAux?.({ leg: this, ...event }));
        }
    }
}

module.exports = {
    SessionLeg,
};
