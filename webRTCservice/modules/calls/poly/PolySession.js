// PolySession: the mediator. Holds two SessionLegs, observes their state
// changes, and drives the pure reconcile policy -> executes the resulting
// actions on the legs and the media controller. It has NO call-state enum of
// its own; behavior is derived entirely from the legs' states + the rule table.
//
// Legs never talk to each other; all cross-leg coordination flows through here.

const { reconcile } = require("./ReconcileRules");
const { LEG_INTENTS } = require("./ports");

const MAX_RECONCILE_PASSES = 50;

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

    refOf(leg) {
        if (leg === this.legs.a) return "a";
        if (leg === this.legs.b) return "b";
        return null;
    }

    legByEndpoint(endpoint) {
        if (this.legs.a.endpoint === endpoint || this.legs.a.id === endpoint) return this.legs.a;
        if (this.legs.b.endpoint === endpoint || this.legs.b.id === endpoint) return this.legs.b;
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
            }
        } finally {
            this._running = false;
        }
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
                case LEG_INTENTS.END: return await leg.endCall(ctx);
                case LEG_INTENTS.CANCEL: return await leg.cancel(ctx);
                case LEG_INTENTS.REJECT: return await leg.reject(ctx);
                case LEG_INTENTS.CONNECT: return await leg.connect(ctx);
                default:
                    this.logger.error(`[${this.id}] unknown intent ${action.intent}`);
            }
        } catch (err) {
            this.logger.error(`[${this.id}] intent ${action.intent} on leg ${leg.id} failed: ${err.message}`);
        }
        return undefined;
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
