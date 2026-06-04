// SIP transport strategy. Wraps a SIP session (INVITE/BYE/hold/DTMF) behind the
// injected CallNegotiationPort. A remote BYE is delivered as an ingress event
// and maps to the same teardown path as a WebRTC end, so PolySession coordinates
// the peer identically regardless of transport.

const { SessionLeg } = require("../SessionLeg");
const { LEG_EVENTS } = require("../ports");
const { LEG_STATES } = require("../states");

class SipLeg extends SessionLeg {
    constructor({ id, endpoint, negotiation, logger = console } = {}) {
        super({ id, kind: "sip", endpoint, negotiation, logger });
    }

    // SIP INVITE is a blocking handshake: the gateway's openOutbound resolves
    // only once the SBC answers (SessionState.Established). So a completed ring
    // means the SIP side is already in-call; advance past RINGING so PolySession
    // bridges media. (WebRTC, by contrast, stays RINGING until a separate answer.)
    async ring(ctx = {}) {
        await super.ring(ctx);
        // Only the outbound INVITE is a blocking handshake. An inbound gateway leg
        // is the caller side (PSTN dialing in): it stays ringing until the secnum
        // callee answers, at which point PolySession issues the ANSWER intent.
        if (this.negotiation.role !== "inbound" && this.state === LEG_STATES.RINGING) {
            this.setState(LEG_STATES.IN_CALL, { reason: "sip-answered", from: ctx.from ?? null });
        }
    }

    async handleIngress(event = {}) {
        // Hold/DTMF are SIP-side aux effects with no PolySession state meaning.
        if (event.type === LEG_EVENTS.HOLD || event.type === LEG_EVENTS.DTMF) {
            await this.negotiation.handleAux?.({ leg: this, ...event });
            return;
        }
        return super.handleIngress(event);
    }
}

module.exports = {
    SipLeg,
};
