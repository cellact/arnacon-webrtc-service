const {
    createCallPairRef,
    pairKeyFromRef,
    pairKeyFromIdentities,
} = require("./CallPairRef");

class CallPairResolver {
    constructor({ polyRegistry } = {}) {
        if (!polyRegistry) throw new Error("CallPairResolver requires polyRegistry");
        this.polyRegistry = polyRegistry;
    }

    fromSession(session) {
        if (!session) return null;
        if (session.callPairRef?.caller && session.callPairRef?.callee) return session.callPairRef;
        return createCallPairRef(session.callerEns, session.toIdentity);
    }

    fromIdentities(caller, callee) {
        return createCallPairRef(caller, callee);
    }

    keyFromSession(session) {
        const ref = this.fromSession(session);
        if (!ref) return null;
        return pairKeyFromRef(ref);
    }

    keyFromIdentities(caller, callee) {
        return pairKeyFromIdentities(caller, callee);
    }

    keyFromPoly(poly) {
        if (!poly) return null;
        return pairKeyFromIdentities(poly.legs.a.endpoint, poly.legs.b.endpoint);
    }

    polyForSession(session) {
        const key = this.keyFromSession(session);
        if (!key) return null;
        return this.polyRegistry.get(key) || null;
    }

    polyForOffer(offer) {
        if (!offer) return null;
        const key = this.keyFromIdentities(offer.from, offer.to);
        if (!key) return null;
        return this.polyRegistry.get(key) || null;
    }

    refForEndpoint(poly, endpoint) {
        if (!poly || !endpoint) return null;
        const leg = poly.legByEndpoint(endpoint);
        return leg ? poly.refOf(leg) : null;
    }

    resolvePairActor(caller, callee, actorEndpoint) {
        const key = this.keyFromIdentities(caller, callee);
        if (!key) return null;
        const poly = this.polyRegistry.get(key);
        if (!poly) return null;
        const ref = this.refForEndpoint(poly, actorEndpoint);
        if (!ref) return null;
        return { key, poly, ref };
    }

    bindSessionPairRef(session, caller, callee) {
        if (!session) return null;
        session.callPairRef = createCallPairRef(caller, callee);
        return session.callPairRef;
    }
}

module.exports = {
    CallPairResolver,
};
