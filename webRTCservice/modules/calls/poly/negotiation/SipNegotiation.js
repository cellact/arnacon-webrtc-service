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
        const openOutbound = async () => {
            await this.sip.openOutbound(this.session.sessionId, {
                target: this.endpoint,
                // Prefer the resolved SBC caller-id over the raw peer ref.
                from: this.session.sipFrom || ctx.from || null,
                sipDirective: this.session.sipDirective || null,
            });
        };

        await openOutbound();
        // No PC2 readiness gate here. SIP `Established` is our signal that the
        // dialog is up; ICE/DTLS on PC2 finish in parallel while the media
        // bridge attaches (same pattern the inbound path uses successfully).
        // A gate here was tearing PC2 down before werift's connectionState
        // could settle, which forced a full re-INVITE = a second ring on the
        // callee UA. See git history if reintroducing.
    }

    // The peer picked up => accept: register as the callee number and accept the
    // resumed INVITE from Kamailio. P only fires answer on a SIP leg that is the
    // CALLER (a PSTN call dialed in and our WebRTC side just answered it).
    async answer(ctx = {}) {
        if (this.session.sipConnection) return; // idempotent
        const referTransfer = this.session.referTransfer;
        if (referTransfer?.enabled && referTransfer.mode === "controller") {
            // REFER transfer controller keeps A's signaling dialog untouched and
            // handles bridge switching out-of-band; this SIP leg must not wait
            // for a suspended INVITE that does not exist in REFER orchestration.
            await referTransfer.onSipAnswer?.({
                sessionId: this.session.sessionId,
                endpoint: this.endpoint,
            });
            return;
        }
        // REFER must still be accepted via the existing inbound SIP path so we
        // do not create a fresh dialog/call-id that appears as a second call.
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
