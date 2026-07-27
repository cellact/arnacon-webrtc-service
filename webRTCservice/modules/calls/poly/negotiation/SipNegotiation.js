// Concrete CallNegotiationPort for a SIP endpoint. Wraps the SIP gateway
// (INVITE / BYE / hold / DTMF) behind the leg interface. A remote BYE arrives as
// a LEG_EVENTS.REMOTE_BYE ingress event (wired by the SIP runtime adapter) and
// flows through SessionLeg's teardown path, so PolySession coordinates the peer
// identically to a WebRTC end.

const { CallNegotiationPort, LEG_EVENTS } = require("../ports");
const { LEG_STATES } = require("../states");
const { SipLeg: MediaSipLeg } = require("../../../media/legs/SipLeg");

class SipNegotiation extends CallNegotiationPort {
    constructor({
        id,
        endpoint,
        session,
        // Number to REGISTER as when accepting an inbound (PSTN-originated) call and
        // pull back the suspended SBC INVITE. Pure context for answer()/openInbound;
        // it is NOT a direction switch -- direction is decided by which intent P
        // fires (ring => originate, answer => accept), never stored on the leg.
        phoneNumber = null,
        sip, // { openOutbound, openInbound, close, sendDtmf, setHold, resolveCallerId }
        logger = console,
    } = {}) {
        super();
        if (!session) throw new Error("SipNegotiation requires a session/transport state");
        if (!sip) throw new Error("SipNegotiation requires a sip port");
        this.id = id;
        this.endpoint = endpoint;
        this.phoneNumber = phoneNumber;
        this.session = session;
        this.sip = sip;
        this.logger = logger;
    }

    async connect() {
        // SIP registration/INVITE happens on ring()/answer(); nothing to pre-establish.
    }

    // P presents the call to the SIP side => originate: place the INVITE toward the
    // PSTN/SBC (blocks until answered). P only fires ring on a SIP leg that is the
    // CALLEE (it was DISCONNECTED and the peer is calling it); a SIP leg that is the
    // caller is seeded CALLING and is driven via answer(), never ring -- so there is
    // no stored "outbound vs inbound" to check, the intent itself is the decision.
    async ring(ctx = {}) {
        if (this.session.sipConnection) return; // already up -> idempotent
        await this.sip.openOutbound(this.session.sessionId, {
            target: this.endpoint,
            // Prefer the resolved SBC caller-id over the raw peer ref.
            from: this.session.sipFrom || ctx.from || null,
            sipDirective: this.session.sipDirective || null,
        });
    }

    // The peer picked up => accept: register as the callee number and accept the
    // resumed INVITE from Kamailio. P only fires answer on a SIP leg that is the
    // CALLER (a PSTN call dialed in and our WebRTC side just answered it).
    async answer(ctx = {}) {
        if (this.session.sipConnection) return; // idempotent
        const referTransfer = this.session.referTransfer;
        if (referTransfer?.enabled) {
            await this.sip.openOutbound(this.session.sessionId, {
                target: referTransfer.refereeEndpoint || this.endpoint,
                from: this.session.sipFrom || this.session.toIdentity || null,
                sipDirective: this.session.sipDirective || null,
            });
            return;
        }
        await this.sip.openInbound(this.session.sessionId, {
            phoneNumber: this.phoneNumber || ctx.phoneNumber || null,
        });
    }

    async applyOffer() {
        // SIP is offered via INVITE by the gateway, not by an SDP relay here.
    }

    async applyAnswer() {}

    // A SIP end is a BYE: the dialog is gone, so the leg cannot stay "connected"
    // like webrtc -> settle DISCONNECTED. A future call needs a fresh INVITE.
    async endCall() {
        if (this.session.sipConnection) {
            await this.sip.close(this.session.sessionId, { reason: "end-call" });
        }
        return { state: LEG_STATES.DISCONNECTED };
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
