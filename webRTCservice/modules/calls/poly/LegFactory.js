// Factory for SessionLegs. Knows how to assemble a leg of each transport kind
// with its negotiation port + media endpoint wired. PolySessionRegistry depends
// on this so it never news up transports itself.

const { WebRtcLeg } = require("./legs/WebRtcLeg");
const { SipLeg } = require("./legs/SipLeg");

class LegFactory {
    constructor({ webRtcNegotiationFactory, sipNegotiationFactory, logger = console } = {}) {
        if (!webRtcNegotiationFactory) throw new Error("LegFactory requires webRtcNegotiationFactory");
        if (!sipNegotiationFactory) throw new Error("LegFactory requires sipNegotiationFactory");
        this.webRtcNegotiationFactory = webRtcNegotiationFactory;
        this.sipNegotiationFactory = sipNegotiationFactory;
        this.logger = logger;
    }

    createWebRtc({ id, endpoint, session, transport, role = "caller", destination = null, callerSessionId = null, adoptSession = false } = {}) {
        const legId = id || endpoint;
        const negotiation = this.webRtcNegotiationFactory({
            id: legId,
            endpoint,
            session,
            transport,
            role,
            destination,
            callerSessionId,
            adoptSession,
            logger: this.logger,
        });
        return new WebRtcLeg({ id: legId, endpoint, negotiation, logger: this.logger });
    }

    createSip({ id, endpoint, session, sip, phoneNumber = null } = {}) {
        const legId = id || endpoint;
        const negotiation = this.sipNegotiationFactory({ id: legId, endpoint, session, sip, phoneNumber, logger: this.logger });
        return new SipLeg({ id: legId, endpoint, negotiation, logger: this.logger });
    }

    // kind-dispatch helper used by the registry.
    create(kind, opts) {
        if (kind === "webrtc") return this.createWebRtc(opts);
        if (kind === "sip") return this.createSip(opts);
        throw new Error(`LegFactory: unsupported leg kind "${kind}"`);
    }
}

module.exports = {
    LegFactory,
};
