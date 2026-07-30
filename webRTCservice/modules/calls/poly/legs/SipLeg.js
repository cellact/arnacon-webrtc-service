// SIP transport strategy. Wraps a SIP session (INVITE/BYE/hold/DTMF) behind the
// injected CallNegotiationPort. A remote BYE is delivered as an ingress event
// and maps to the same teardown path as a WebRTC end, so PolySession coordinates
// the peer identically regardless of transport.

const { SessionLeg } = require("../SessionLeg");
const { LEG_EVENTS, LEG_INTENTS } = require("../ports");
const { LEG_STATES } = require("../states");
const { assertIntentLegal } = require("../LegStateBehavior");

function getSipFullRetryAttempts() {
    return Math.max(0, Number(process.env.SIP_FULL_RETRY_ATTEMPTS || 2));
}

function getSipFullRetryDelayMs() {
    return Math.max(0, Number(process.env.SIP_FULL_RETRY_DELAY_MS || 400));
}

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
        const totalAttempts = getSipFullRetryAttempts() + 1;
        const retryDelayMs = getSipFullRetryDelayMs();
        let lastErr = null;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            try {
                await this._tx(() => this.negotiation.ring({ leg: this, ...ctx }));
                if (this.state === LEG_STATES.RINGING) {
                    this.setState(LEG_STATES.IN_CALL, { reason: "sip-answered", from: ctx.from ?? null });
                }
                return;
            } catch (err) {
                lastErr = err;
                const canRetry = err?.code === "SIP_PC2_NOT_CONNECTED" && attempt < totalAttempts;
                if (!canRetry) break;
                this.logger.warn(
                    `[${this.id}] SIP full re-invite retry ${attempt}/${totalAttempts - 1} after media transport failure`
                );
                if (this.state === LEG_STATES.RINGING) {
                    this.setState(LEG_STATES.DISCONNECTED, { reason: "sip-invite-retry-reset", from: ctx.from ?? null });
                    this.setState(LEG_STATES.RINGING, { reason: "sip-invite-retry", from: ctx.from ?? null });
                }
                if (retryDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                }
            }
        }

        // Keep SIP failed invites from being treated as answered calls.
        if (this.state === LEG_STATES.RINGING) {
            this.setState(LEG_STATES.DISCONNECTED, { reason: "sip-invite-failed", from: ctx.from ?? null });
        }
        throw lastErr || new Error("sip-invite-failed");
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
