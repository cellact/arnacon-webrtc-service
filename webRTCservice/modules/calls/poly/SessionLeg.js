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

const { LEG_STATES, isValidState } = require("./states");
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
        await this._tx(() => this.negotiation.connect({ leg: this, ...ctx }));
        this.setState(LEG_STATES.CONNECTED, { reason: "connected", from: "self" });
    }

    async ring(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.RING);
        if (this.state === LEG_STATES.RINGING) return; // already ringing -> idempotent
        this.setState(LEG_STATES.RINGING, { reason: "ring", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.ring({ leg: this, ...ctx }));
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
                this.setState(LEG_STATES.DISCONNECTED, { reason: "transport-close", from: "self" });
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
                // This endpoint picked up: apply its answer and settle to in-call.
                // PolySession reacts to (inCall vs ringing/calling) to bridge media.
                await this._tx(() => this.negotiation.applyAnswer?.({ leg: this, ...event }));
                this.setState(LEG_STATES.IN_CALL, { reason: "client-answer", from: "self", payload: event.payload });
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
