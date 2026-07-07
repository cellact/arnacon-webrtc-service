// Ingress adapter: the single funnel that turns verified wire messages (HTTP
// /notify, data-channel signaling/call, SIP runtime events) into normalized
// LegEvents, resolves the owning PolySession + target leg via the registry, and
// delivers them. This is the thin layer the legacy SignalingPipeline /
// SignalingMessageRouter / SIP BYE handler call into.
//
// Verification (SignalingAuthVerifier, blockchain xdata/xsign) stays upstream
// and unchanged; by the time a message reaches here it is trusted.

const { LEG_EVENTS, makeLegEvent } = require("./ports");
const { isInactiveOffer } = require("./negotiation/sdp");

// Wire action -> normalized leg event type. Offers are resolved separately
// because a late inactive offer is a teardown, not a fresh ring.
const ACTION_TO_EVENT = Object.freeze({
    answer: LEG_EVENTS.ANSWER,
    "ice-batch": LEG_EVENTS.ICE,
    ice: LEG_EVENTS.ICE,
    "end-call": LEG_EVENTS.END_RENEGOTIATION,
    end: LEG_EVENTS.END,
    reject: LEG_EVENTS.REJECT,
    cancel: LEG_EVENTS.CANCEL,
    dtmf: LEG_EVENTS.DTMF,
    hold: LEG_EVENTS.HOLD,
    bye: LEG_EVENTS.REMOTE_BYE,
});

class PolyIngress {
    constructor({ registry, logger = console } = {}) {
        if (!registry) throw new Error("PolyIngress requires a PolySessionRegistry");
        this.registry = registry;
        this.logger = logger;
    }

    // Map a wire message to a normalized leg event. `action` is the wire action
    // (payload.type for signaling, msg.action for call messages, or "bye").
    toLegEvent(action, payload = {}, meta = {}) {
        if (action === "offer") {
            if (meta.forceOffer === true) {
                return makeLegEvent(LEG_EVENTS.OFFER, payload, meta);
            }
            const type = isInactiveOffer(payload.sdp) ? LEG_EVENTS.END_RENEGOTIATION : LEG_EVENTS.OFFER;
            return makeLegEvent(type, payload, meta);
        }
        const type = ACTION_TO_EVENT[action];
        if (!type) return null;
        return makeLegEvent(type, payload, meta);
    }

    // Deliver an event for a pair of parties. `parties` = { a, b, target } where
    // a/b are { endpoint, kind } and target identifies the acting leg.
    async deliver(parties, action, payload = {}, meta = {}) {
        const event = this.toLegEvent(action, payload, meta);
        if (!event) {
            this.logger.log(`[poly-ingress] ignored unsupported action "${action}"`);
            return null;
        }
        const { poly, ref } = this.registry.resolve(parties);
        await poly.onIngress(ref, event);
        return poly;
    }

    // Convenience for SIP remote BYE delivered by the SIP runtime.
    async remoteBye(parties) {
        return this.deliver(parties, "bye", {});
    }
}

module.exports = {
    PolyIngress,
    ACTION_TO_EVENT,
};
