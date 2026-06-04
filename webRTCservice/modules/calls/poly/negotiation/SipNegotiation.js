// Concrete CallNegotiationPort for a SIP endpoint. Wraps the SIP gateway
// (INVITE / BYE / hold / DTMF) behind the leg interface. A remote BYE arrives as
// a LEG_EVENTS.REMOTE_BYE ingress event (wired by the SIP runtime adapter) and
// flows through SessionLeg's teardown path, so PolySession coordinates the peer
// identically to a WebRTC end.

const { CallNegotiationPort, LEG_EVENTS } = require("../ports");
const { SipLeg: MediaSipLeg } = require("../../../media/legs/SipLeg");

class SipNegotiation extends CallNegotiationPort {
    constructor({
        id,
        endpoint,
        session,
        role = "outbound", // "outbound": secnum->sip INVITE; "inbound": sip->secnum gateway
        phoneNumber = null, // inbound role: number to REGISTER as and await the resumed INVITE
        sip, // { openOutbound, openInbound, close, sendDtmf, setHold, resolveCallerId }
        logger = console,
    } = {}) {
        super();
        if (!session) throw new Error("SipNegotiation requires a session/transport state");
        if (!sip) throw new Error("SipNegotiation requires a sip port");
        this.id = id;
        this.endpoint = endpoint;
        this.role = role;
        this.phoneNumber = phoneNumber;
        this.session = session;
        this.sip = sip;
        this.logger = logger;
    }

    async connect() {
        // SIP registration/INVITE happens on ring()/answer(); nothing to pre-establish.
    }

    // PolySession asks the SIP side to start.
    //   outbound: place the INVITE toward the PSTN/SBC (blocks until answered).
    //   inbound : nothing to do on ring -- the PSTN is the caller; we wait for the
    //             secnum callee to pick up, then answer() registers + accepts.
    async ring(ctx = {}) {
        if (this.role === "inbound") return;
        if (this.session.sipConnection) return; // already up -> idempotent
        await this.sip.openOutbound(this.session.sessionId, {
            target: this.endpoint,
            // Prefer the resolved SBC caller-id over the raw peer ref.
            from: this.session.sipFrom || ctx.from || null,
            sipDirective: this.session.sipDirective || null,
        });
    }

    // Peer picked up.
    //   outbound: media flows once the INVITE is answered; nothing more here.
    //   inbound : register as the callee number and accept the resumed INVITE
    //             from Kamailio (porting openInboundSipSession trigger).
    async answer(ctx = {}) {
        if (this.role !== "inbound") return;
        if (this.session.sipConnection) return; // idempotent
        await this.sip.openInbound(this.session.sessionId, {
            phoneNumber: this.phoneNumber || ctx.phoneNumber || null,
        });
    }

    async applyOffer() {
        // SIP is offered via INVITE by the gateway, not by an SDP relay here.
    }

    async applyAnswer() {}

    async endCall() {
        if (!this.session.sipConnection) return;
        await this.sip.close(this.session.sessionId, { reason: "end-call" });
    }

    async handleAux(ctx = {}) {
        if (ctx.type === LEG_EVENTS.DTMF) {
            await this.sip.sendDtmf?.(this.session.sessionId, ctx.payload?.digit ?? ctx.payload);
            return;
        }
        if (ctx.type === LEG_EVENTS.HOLD) {
            await this.sip.setHold?.(this.session.sessionId, !!ctx.payload?.enabled);
        }
    }

    getMediaEndpoint() {
        return new MediaSipLeg({
            session: this.session,
            sessionId: this.session.sessionId || this.id,
            peerConnection: this.session.sipPeerConnection,
            logger: this.logger,
        });
    }

    async dispose() {
        if (this.session.sipConnection) {
            try { await this.sip.close(this.session.sessionId, { reason: "dispose" }); } catch (_) {}
        }
    }
}

module.exports = {
    SipNegotiation,
};
