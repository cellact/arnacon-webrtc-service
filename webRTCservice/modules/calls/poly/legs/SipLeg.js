// SIP transport strategy. Wraps a SIP session (INVITE/BYE/hold/DTMF) behind the
// injected CallNegotiationPort. A remote BYE is delivered as an ingress event
// and maps to the same teardown path as a WebRTC end, so PolySession coordinates
// the peer identically regardless of transport.

const { SessionLeg } = require("../SessionLeg");
const { LEG_EVENTS, LEG_INTENTS } = require("../ports");
const { LEG_STATES } = require("../states");
const { assertIntentLegal } = require("../LegStateBehavior");

class SipLeg extends SessionLeg {
    constructor({ id, endpoint, negotiation, logger = console } = {}) {
        super({ id, kind: "sip", endpoint, negotiation, logger });
    }

    // SIP has NO transport to pre-establish and NO "connected" idle state: there is
    // no persistent peer connection between calls, each call is a fresh INVITE.
    // So a connect intent (reconcile bringing the peer up) must NOT settle on
    // CONNECTED the way a webrtc leg does -- it collapses straight into the INVITE.
    // The leg lifecycle is DISCONNECTED -> RINGING -> IN_CALL -> DISCONNECTED.
    async connect(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.CONNECT);
        return this._invite(ctx);
    }

    // P presents the call to the SIP side. Same INVITE path as connect (SIP never
    // separates "transport up" from "ring"); kept distinct so a rungable leg can
    // still be re-rung legally.
    async ring(ctx = {}) {
        assertIntentLegal(this.state, LEG_INTENTS.RING);
        return this._invite(ctx);
    }

    // The one SIP "reach the peer" action (connect/ring). The outbound INVITE is a
    // blocking handshake: negotiation.ring (openOutbound) resolves only once the SBC
    // answers (SessionState.Established), so a completed ring means the SIP side is
    // already in-call -> advance past RINGING so PolySession bridges. P only routes
    // here for a SIP leg that is the callee being dialed; a SIP-caller leg is seeded
    // CALLING and driven via answer() instead, so this path is unambiguously the
    // originate side -- no inbound/outbound role to consult.
    async _invite(ctx = {}) {
        if (this.state === LEG_STATES.RINGING || this.state === LEG_STATES.IN_CALL) return;
        this.setState(LEG_STATES.RINGING, { reason: "sip-invite", from: ctx.from ?? null });
        await this._tx(() => this.negotiation.ring({ leg: this, ...ctx }));
        if (this.state === LEG_STATES.RINGING) {
            this.setState(LEG_STATES.IN_CALL, { reason: "sip-answered", from: ctx.from ?? null });
        }
    }

    async handleIngress(event = {}) {
        // Hold/DTMF are SIP-side aux effects with no PolySession state meaning.
        if (event.type === LEG_EVENTS.HOLD || event.type === LEG_EVENTS.DTMF) {
            await this.negotiation.handleAux?.({ leg: this, ...event });
            return;
        }
        // SIP has no data-channel transport-open and no CONNECTED state, so a
        // transport-open ingress is meaningless here -> ignore it (never enter
        // CONNECTED). All other events flow through the shared base.
        if (event.type === LEG_EVENTS.TRANSPORT_OPEN) return;
        return super.handleIngress(event);
    }
}

module.exports = {
    SipLeg,
};
