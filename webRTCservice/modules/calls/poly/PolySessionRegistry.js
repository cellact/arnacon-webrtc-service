// Finder + lifecycle for PolySessions. Every ingress request is resolved here to
// (PolySession, targetLegRef). Keyed by a stable identity pair so HTTP, data
// channel and SIP messages for the same two parties land on one PolySession.
// Replaces the old linkedSessionId / bridgedWith / pendingBridges pairing.

const { PolySession } = require("./PolySession");
const {
    identityLabel,
    pairKeyFromIdentities,
} = require("../../runtime/CallPairRef");

function pairKey(a, b) {
    return pairKeyFromIdentities(a, b);
}

class PolySessionRegistry {
    constructor({ legFactory, mediaController, makeTeardownHooks = null, logger = console } = {}) {
        if (!legFactory) throw new Error("PolySessionRegistry requires legFactory");
        if (!mediaController) throw new Error("PolySessionRegistry requires mediaController");
        this.legFactory = legFactory;
        this.mediaController = mediaController;
        // Optional: ({ key, a, b }) -> [fn(reason, poly)] e.g. minuteCounter.finish.
        this.makeTeardownHooks = typeof makeTeardownHooks === "function" ? makeTeardownHooks : null;
        this.logger = logger;
        this.byKey = new Map(); // pairKey -> PolySession
        this.byEndpoint = new Map(); // endpoint label -> pairKey
    }

    get(key) {
        return this.byKey.get(key) || null;
    }

    // Lookup the PolySession by either party's identity (label-normalized).
    getByEndpoint(endpoint) {
        if (!endpoint) return null;
        const key = this.byEndpoint.get(identityLabel(String(endpoint).toLowerCase()));
        return key ? (this.byKey.get(key) || null) : null;
    }

    // All PolySessions that currently include this endpoint.
    listByEndpoint(endpoint) {
        if (!endpoint) return [];
        const wanted = identityLabel(String(endpoint).toLowerCase());
        if (!wanted) return [];
        const matches = [];
        for (const poly of this.byKey.values()) {
            if (!poly) continue;
            if (poly.legByEndpoint(wanted)) matches.push(poly);
        }
        return matches;
    }

    keyForPair(a, b) {
        return pairKeyFromIdentities(a, b);
    }

    // Resolve (or create) the PolySession for a pair and return which leg the
    // request targets. `specA`/`specB` describe each leg: { endpoint, kind, ... }.
    resolve({ a, b, target } = {}) {
        if (!a?.endpoint || !b?.endpoint) {
            throw new Error("PolySessionRegistry.resolve requires both leg endpoints");
        }
        const key = pairKeyFromIdentities(a.endpoint, b.endpoint);
        let poly = this.byKey.get(key);
        if (!poly) {
            poly = this._create(key, a, b);
        }
        const targetEndpoint = target === "b" ? b.endpoint : target === "a" ? a.endpoint : (target || a.endpoint);
        const leg = poly.legByEndpoint(targetEndpoint);
        if (!leg) {
            throw new Error(`PolySessionRegistry.resolve target endpoint not found in pair ${key}: ${targetEndpoint}`);
        }
        return { poly, leg, ref: poly.refOf(leg), key };
    }

    _create(key, a, b) {
        const legA = this.legFactory.create(a.kind || "webrtc", a);
        const legB = this.legFactory.create(b.kind || "webrtc", b);
        const teardownHooks = this.makeTeardownHooks ? (this.makeTeardownHooks({ key, a, b }) || []) : [];
        const poly = new PolySession({
            id: key,
            legA,
            legB,
            mediaController: this.mediaController,
            teardownHooks,
            logger: this.logger,
        });
        this.byKey.set(key, poly);
        this.byEndpoint.set(identityLabel(String(a.endpoint).toLowerCase()), key);
        this.byEndpoint.set(identityLabel(String(b.endpoint).toLowerCase()), key);
        this.logger.log(`[poly] created PolySession ${key} (${legA.kind}:${a.endpoint} <-> ${legB.kind}:${b.endpoint})`);
        return poly;
    }

    async destroy(key, reason = "destroy") {
        const poly = this.byKey.get(key);
        if (!poly) return;
        this.byKey.delete(key);
        for (const [endpoint, k] of [...this.byEndpoint.entries()]) {
            if (k === key) this.byEndpoint.delete(endpoint);
        }
        await poly.dispose(reason);
    }
}

module.exports = {
    PolySessionRegistry,
    identityLabel,
    pairKey,
};
