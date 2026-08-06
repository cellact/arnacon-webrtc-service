// PolySession: the mediator. Holds two SessionLegs, observes their state
// changes, and drives the pure reconcile policy -> executes the resulting
// actions on the legs and the media controller. It has NO call-state enum of
// its own; behavior is derived entirely from the legs' states + the rule table.
//
// Legs never talk to each other; all cross-leg coordination flows through here.

const { reconcile } = require("./ReconcileRules");
const { LEG_INTENTS } = require("./ports");
const { LEG_STATES, isActiveCall } = require("./states");
const { identityLabel } = require("../../runtime/CallPairRef");

const MAX_RECONCILE_PASSES = 50;

// Intents that drive a call toward the peer. If one of these throws (e.g. the SIP
// INVITE is rejected during `ring`), the leg can no longer carry the call -> mark
// it FAILED so reconcile ends the caller (end-call reneg). Teardown intents are
// excluded: failing a teardown into more teardown would loop.
const FAIL_ON_ERROR_INTENTS = new Set([
    LEG_INTENTS.RING,
    LEG_INTENTS.CONNECT,
    LEG_INTENTS.ANSWER,
    LEG_INTENTS.ACK_CONNECTED,
    LEG_INTENTS.ACK_RING,
]);

class PolySession {
    constructor({ id, legA, legB, mediaController, rules = reconcile, teardownHooks = [], logger = console } = {}) {
        if (!legA || !legB) throw new Error("PolySession requires two legs");
        if (!mediaController) throw new Error("PolySession requires a MediaControllerPort");
        this.id = id || `${legA.id}<->${legB.id}`;
        this.legs = { a: legA, b: legB };
        this.mediaController = mediaController;
        this.rules = rules;
        // Side-effects that must run once on teardown (e.g. minuteCounter.finish
        // billing). Kept as a list so callers compose without subclassing.
        this._teardownHooks = teardownHooks.filter((h) => typeof h === "function");
        this._teardownRan = false;
        // Call-lifecycle hooks, fired on the active<->inactive edge derived from leg
        // states (a call is "active" while either leg isActiveCall). This is the
        // single robust seam for per-call side-effects that must bracket the call
        // itself -- NOT the poly's disposal -- so they fire once per call on EVERY
        // end path (hangup either side, mid-call failure, transport drop, reject)
        // and again on a reused poly's next call. Used for minute-counter
        // start/finish so billing always stops regardless of how the call ends.
        this._onCallStart = null;
        this._onCallEnd = null;
        this._callActive = false;
        // (from, callId) that owns the current call attempt on this pair.
        // A new callId (or new from) arriving via /notify is a cold-start signal
        // from the client: the offer intake layer rotates the PolySession before
        // handing the offer to a leg. Set via markActiveCall on first ingress.
        this.activeCall = null;
        this._disposed = false;
        this.logger = logger;

        this.mediaHandle = null;
        this.lastEvent = null;
        this._dirty = false;
        this._running = false;
        this._chain = Promise.resolve();

        this._unsubscribe = [
            legA.onStateChange((e) => this._onLegChange(e)),
            legB.onStateChange((e) => this._onLegChange(e)),
        ];
    }

    _normalizeCallIdValue(value) {
        if (value === undefined || value === null || value === "") return null;
        const n = Number.parseInt(String(value), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    _normalizeFromValue(value) {
        return identityLabel(String(value || "").toLowerCase()) || null;
    }

    // Called by the offer intake layer as soon as a new call attempt is bound
    // to this PolySession. Overwrites any prior activeCall — the caller is
    // responsible for having rotated first when the (from, callId) changed.
    markActiveCall(from, callId) {
        const normFrom = this._normalizeFromValue(from);
        const normCallId = this._normalizeCallIdValue(callId);
        if (!normFrom || !normCallId) return;
        this.activeCall = { from: normFrom, callId: normCallId };
    }

    // Same call attempt? Returns true only when BOTH fields match a live
    // activeCall record. Missing/mismatched fields yield false: the caller
    // decides whether that means "rotate" or "reject".
    isSameCall(from, callId) {
        if (!this.activeCall) return false;
        const normFrom = this._normalizeFromValue(from);
        const normCallId = this._normalizeCallIdValue(callId);
        if (!normFrom || !normCallId) return false;
        return this.activeCall.from === normFrom && this.activeCall.callId === normCallId;
    }

    // Hard-rotate this PolySession: end whichever legs are still up (so SIP BYE
    // fires and Kamailio's dialog counter drops), then dispose. Idempotent.
    // Registered PolySessionRegistry deletion is the caller's job.
    async rotate(reason = "call-rotated") {
        if (this._disposed) return;
        const priorCall = this.activeCall
            ? `from=${this.activeCall.from} callId=${this.activeCall.callId}`
            : "unknown";
        this.logger.log(`[${this.id}] rotate (${reason}) prior=${priorCall}`);
        const endCallSafely = async (leg) => {
            if (!leg) return;
            if (leg.state === LEG_STATES.DISCONNECTED) return;
            if (leg._isTerminal && leg._isTerminal()) return;
            try {
                await leg.endCall({ reason });
            } catch (err) {
                this.logger.error(`[${this.id}] rotate: leg ${leg.id} endCall failed: ${err?.message || err}`);
            }
        };
        await Promise.all([endCallSafely(this.legs.a), endCallSafely(this.legs.b)]);
        try {
            await this._settle();
        } catch (_) {}
        this.activeCall = null;
        await this.dispose(reason);
    }

    refOf(leg) {
        if (leg === this.legs.a) return "a";
        if (leg === this.legs.b) return "b";
        return null;
    }

    legByEndpoint(endpoint) {
        const wanted = identityLabel(String(endpoint || "").toLowerCase());
        if (!wanted) return null;
        const aEndpoint = identityLabel(String(this.legs.a.endpoint || "").toLowerCase());
        const aId = identityLabel(String(this.legs.a.id || "").toLowerCase());
        if (aEndpoint === wanted || aId === wanted) return this.legs.a;
        const bEndpoint = identityLabel(String(this.legs.b.endpoint || "").toLowerCase());
        const bId = identityLabel(String(this.legs.b.id || "").toLowerCase());
        if (bEndpoint === wanted || bId === wanted) return this.legs.b;
        return null;
    }

    // Entry point for ingress adapters: deliver a normalized wire event to the
    // target leg. The leg updates its own state, which triggers reconciliation.
    async onIngress(legRef, event) {
        const leg = typeof legRef === "string" ? this.legs[legRef] : legRef;
        if (!leg) throw new Error(`PolySession.onIngress: unknown leg ${legRef}`);
        await leg.handleIngress(event);
        return this._settle();
    }

    _onLegChange(event) {
        this.lastEvent = event;
        this._dirty = true;
        if (this._running) return;
        this._chain = this._chain.then(() => this._drain());
    }

    // Await the current reconcile chain to quiesce (useful for tests/ingress).
    _settle() {
        if (this._dirty && !this._running) {
            this._chain = this._chain.then(() => this._drain());
        }
        return this._chain;
    }

    _snapshot() {
        return {
            a: { state: this.legs.a.state, kind: this.legs.a.kind },
            b: { state: this.legs.b.state, kind: this.legs.b.kind },
            mediaConnected: !!this.mediaHandle,
        };
    }

    async _drain() {
        if (this._running) return;
        this._running = true;
        try {
            let passes = 0;
            while (this._dirty) {
                this._dirty = false;
                if (++passes > MAX_RECONCILE_PASSES) {
                    this.logger.error(`[${this.id}] reconcile did not converge after ${MAX_RECONCILE_PASSES} passes`);
                    break;
                }
                const actions = this.rules(this._snapshot(), this.lastEvent);
                for (const action of actions) {
                    await this._execute(action);
                }
                this._recoverFailedLegs();
            }
            await this._settleCallActivity();
        } finally {
            this._running = false;
        }
    }

    // Detect the in-call edge from the quiesced leg states and fire the lifecycle
    // hooks once per transition. "In call" = BOTH legs are IN_CALL, i.e. the actual
    // answered conversation (the media-bridged window) -- ring/setup/teardown are
    // deliberately excluded. The falling edge is the reliable "conversation is over"
    // signal that fires on every end path (hangup either side, mid-call failure,
    // transport drop) while the poly itself survives for reuse.
    async _settleCallActivity() {
        const active = this.legs.a.state === LEG_STATES.IN_CALL && this.legs.b.state === LEG_STATES.IN_CALL;
        if (active === this._callActive) return;
        this._callActive = active;
        const hook = active ? this._onCallStart : this._onCallEnd;
        if (typeof hook !== "function") return;
        try {
            await hook(this);
        } catch (err) {
            this.logger.error(`[${this.id}] call-${active ? "start" : "end"} hook failed: ${err.message}`);
        }
    }

    // Inject per-call lifecycle side-effects (e.g. minuteCounter start/finish).
    // Idempotent to set; safe to (re)assign on a reused poly before its next call.
    setCallActivityHooks({ onCallStart = null, onCallEnd = null } = {}) {
        if (onCallStart !== undefined) this._onCallStart = typeof onCallStart === "function" ? onCallStart : null;
        if (onCallEnd !== undefined) this._onCallEnd = typeof onCallEnd === "function" ? onCallEnd : null;
    }

    async _execute(action) {
        if (action.kind === "media") {
            return this._executeMedia(action);
        }
        const leg = this.legs[action.leg];
        if (!leg) return;
        const fromLeg = action.from ? this.legs[action.from] : null;
        const ctx = {
            from: fromLeg ? fromLeg.endpoint : null,
            fromKind: fromLeg ? fromLeg.kind : null,
            event: this.lastEvent,
        };
        try {
            switch (action.intent) {
                case LEG_INTENTS.RING: return await leg.ring(ctx);
                case LEG_INTENTS.ACK_CONNECTED: return await leg.ackConnected(ctx);
                case LEG_INTENTS.ACK_RING: return await leg.ackRing(ctx);
                case LEG_INTENTS.ANSWER: return await leg.answer(ctx);
                case LEG_INTENTS.ACK_END: return await leg.ackEnd(ctx);
                case LEG_INTENTS.END: return await leg.endCall(ctx);
                case LEG_INTENTS.CANCEL: return await leg.cancel(ctx);
                case LEG_INTENTS.REJECT: return await leg.reject(ctx);
                case LEG_INTENTS.CONNECT: return await leg.connect(ctx);
                default:
                    this.logger.error(`[${this.id}] unknown intent ${action.intent}`);
            }
        } catch (err) {
            this.logger.error(`[${this.id}] intent ${action.intent} on leg ${leg.id} failed: ${err.message}`);
            // Architecture: any DC send that fails because the channel is missing/closed
            // is transport loss, not call failure. Drop the leg to DISCONNECTED so
            // reconcile always rebuilds the WebRTC handshake (CONNECT) before re-driving
            // RING/answer. Applies to every intent — not a RING-only special case.
            if (err?.code === "NO_OPEN_DC") {
                if (leg.state !== LEG_STATES.DISCONNECTED) {
                    leg.setState(LEG_STATES.DISCONNECTED, {
                        reason: `intent-no-open-dc:${action.intent}`,
                        from: "self",
                    });
                }
                return;
            }
            // A reaching intent failed -> the leg cannot carry the call. Fail it so
            // reconcile drives the peer into an end-call reneg (a FAILED leg is a
            // teardown trigger). Idempotent: no-op if already FAILED/torn down.
            if (FAIL_ON_ERROR_INTENTS.has(action.intent) && leg.state !== LEG_STATES.FAILED) {
                leg.setState(LEG_STATES.FAILED, { reason: `intent-failed:${action.intent}`, from: "self" });
            }
        }
        return undefined;
    }

    // Once the call is over, a leg left FAILED is stuck (FAILED is not rungable, so
    // the next call would stall) and reads as a permanent error rather than an idle
    // endpoint. Settle it back to its idle (DISCONNECTED) so it is reusable. This is
    // deliberately deferred until the peer is no longer in an active call: FAILED is
    // the teardown trigger that drives the peer's end-call reneg, so we MUST keep it
    // long enough for reconcile to end the peer first -- only then do we collapse the
    // dead leg to DISCONNECTED. (isActiveCall excludes ENDING, so a reneg still in
    // flight holds this off.) Applies to both transports: a SIP leg rebuilds its
    // INVITE per call, and a dropped webrtc leg's PC is gone + its session is being
    // destroyed, so DISCONNECTED is the correct idle resting state for both.
    _recoverFailedLegs() {
        for (const ref of ["a", "b"]) {
            const leg = this.legs[ref];
            const peer = this.legs[ref === "a" ? "b" : "a"];
            if (leg.state === LEG_STATES.FAILED && !isActiveCall(peer.state)) {
                leg.setState(LEG_STATES.DISCONNECTED, { reason: "failed-leg-recovery", from: "self" });
            }
        }
    }

    async _executeMedia(action) {
        try {
            if (action.op === "connect") {
                if (this.mediaHandle) return;
                this.mediaHandle = await this.mediaController.connect(
                    this.legs.a.getMediaEndpoint(),
                    this.legs.b.getMediaEndpoint(),
                    { id: this.id },
                );
                this.logger.log(`[${this.id}] media bridged`);
            } else if (action.op === "disconnect") {
                if (!this.mediaHandle) return;
                const handle = this.mediaHandle;
                this.mediaHandle = null;
                await this.mediaController.disconnect(handle);
                this.logger.log(`[${this.id}] media torn down`);
            }
        } catch (err) {
            this.logger.error(`[${this.id}] media ${action.op} failed: ${err.message}`);
        }
    }

    addTeardownHook(fn) {
        if (typeof fn === "function") this._teardownHooks.push(fn);
    }

    async _runTeardownHooks(reason) {
        if (this._teardownRan) return;
        this._teardownRan = true;
        for (const hook of this._teardownHooks.splice(0)) {
            try {
                await hook(reason, this);
            } catch (err) {
                this.logger.error(`[${this.id}] teardown hook failed: ${err.message}`);
            }
        }
    }

    async dispose(reason = "dispose") {
        if (this._disposed) return;
        this._disposed = true;
        for (const off of this._unsubscribe.splice(0)) {
            try { off(); } catch (_) {}
        }
        if (this.mediaHandle) {
            try { await this.mediaController.disconnect(this.mediaHandle); } catch (_) {}
            this.mediaHandle = null;
        }
        await this._runTeardownHooks(reason);
        await Promise.all([
            this.legs.a.dispose({ reason }).catch(() => {}),
            this.legs.b.dispose({ reason }).catch(() => {}),
        ]);
    }
}

module.exports = {
    PolySession,
    MAX_RECONCILE_PASSES,
};
