// Segregated ports (interfaces) for the PolySession layer. Each is intentionally
// narrow (ISP): collaborators depend on a tiny contract, never on a concrete
// gateway or a god-object callback bag. Concrete implementations live in the
// composition root / adapters. Calling an unimplemented method throws so a
// half-built double fails loudly instead of silently no-op'ing.

// What the PolySession may ask a leg to do. "from" travels with the intent so a
// leg knows who initiated the action (itself vs the peer) and reacts correctly.
const LEG_INTENTS = Object.freeze({
    CONNECT: "connect",
    RING: "ring",
    // Two distinct acks, both decided by PolySession (the leg only knows HOW):
    //   ACK_CONNECTED - the caller's client offered and we are now connected; ack
    //                   its ring so it stops re-offering. Fired once per fresh ring.
    //   ACK_RING      - the peer has actually started ringing. webrtc: no-op (the
    //                   caller was already acked at connect); sip: a real 180.
    ACK_CONNECTED: "ackConnected",
    ACK_RING: "ackRing",
    ANSWER: "answer",
    // Acknowledge the client's end-call request: the leg answers its end-call
    // reneg offer (audio off, transport kept) and returns to CONNECTED. P decides
    // WHEN (a leg entered END_REQUESTED); the transport decides HOW.
    ACK_END: "ackEnd",
    END: "endCall",
    CANCEL: "cancel",
    REJECT: "reject",
});

// Normalized inbound events produced by ingress adapters (wire -> event). A leg
// translates these into transport work + its own state changes.
const LEG_EVENTS = Object.freeze({
    TRANSPORT_OPEN: "transport-open",
    TRANSPORT_CLOSE: "transport-close",
    OFFER: "offer",
    ANSWER: "answer",
    ICE: "ice",
    END: "end",
    END_RENEGOTIATION: "end-renegotiation",
    REJECT: "reject",
    CANCEL: "cancel",
    DTMF: "dtmf",
    HOLD: "hold",
    REMOTE_BYE: "remote-bye",
});

function makeLegEvent(type, payload = {}, meta = {}) {
    return { type, payload, meta, at: Date.now() };
}

function notImplemented(cls, method) {
    throw new Error(`${cls} must implement ${method}()`);
}

// Builds/tears down the media graph between two media endpoints. The only bridge
// between PolySession and the (unchanged) media layer. Never reads p/s state.
class MediaControllerPort {
    // eslint-disable-next-line no-unused-vars
    async connect(endpointA, endpointB, ctx = {}) {
        notImplemented("MediaControllerPort", "connect");
    }

    // eslint-disable-next-line no-unused-vars
    async disconnect(handle) {
        notImplemented("MediaControllerPort", "disconnect");
    }
}

// Sends already-built signaling messages to one endpoint (DC, or HTTP/FCM bridge).
class SignalingTransportPort {
    // eslint-disable-next-line no-unused-vars
    send(message) {
        notImplemented("SignalingTransportPort", "send");
    }

    isOpen() {
        return false;
    }
}

// Out-of-band invite delivery (FCM/APNS) when there is no open data channel yet.
class NotificationPort {
    // eslint-disable-next-line no-unused-vars
    async notify(target, payload) {
        notImplemented("NotificationPort", "notify");
    }
}

// Transport-specific SDP/call negotiation, injected into a leg so the leg depends
// on this abstraction instead of RTCPeerConnection / SIP.js directly (DIP).
// Implementations return the next leg state so the leg stays declarative.
class CallNegotiationPort {
    // eslint-disable-next-line no-unused-vars
    async ring(ctx) { notImplemented("CallNegotiationPort", "ring"); }

    // Ack the caller's ring at connect time so its client stops re-offering
    // (P decides WHEN, the transport decides HOW). Optional: SIP has no DC ack.
    // eslint-disable-next-line no-unused-vars
    async ackConnected(ctx) { /* optional */ }

    // Signal that the peer is actually ringing now. webrtc: no-op; sip: 180.
    // Optional + idempotent.
    // eslint-disable-next-line no-unused-vars
    async ackRing(ctx) { /* optional */ }

    // eslint-disable-next-line no-unused-vars
    async answer(ctx) { notImplemented("CallNegotiationPort", "answer"); }

    // Acknowledge a client-initiated end: answer its end-call reneg offer (audio
    // off, transport kept). Optional: only the transports that can stay connected
    // after a call implement it (webrtc). Returns the resulting leg state, e.g.
    // { state: "connected" }.
    // eslint-disable-next-line no-unused-vars
    async ackEnd(ctx) { /* optional */ }

    // eslint-disable-next-line no-unused-vars
    async applyOffer(ctx) { notImplemented("CallNegotiationPort", "applyOffer"); }

    // eslint-disable-next-line no-unused-vars
    async applyAnswer(ctx) { notImplemented("CallNegotiationPort", "applyAnswer"); }

    // A transport-establishment answer (the callee answered our session offer to
    // bring up its PC/DC) -- NOT a call accept. Optional: SIP never gets one.
    // eslint-disable-next-line no-unused-vars
    async applySessionAnswer(ctx) { /* optional */ }

    // End the call toward this endpoint. Returns the resulting leg state, or
    // { deferred: true } if the leg should stay in ENDING until the client's
    // end-call answer arrives (webrtc). SIP returns { state: "disconnected" }.
    // eslint-disable-next-line no-unused-vars
    async endCall(ctx) { notImplemented("CallNegotiationPort", "endCall"); }

    // eslint-disable-next-line no-unused-vars
    getMediaEndpoint(ctx) { notImplemented("CallNegotiationPort", "getMediaEndpoint"); }

    // eslint-disable-next-line no-unused-vars
    async dispose(ctx) { /* optional */ }
}

module.exports = {
    LEG_INTENTS,
    LEG_EVENTS,
    makeLegEvent,
    MediaControllerPort,
    SignalingTransportPort,
    NotificationPort,
    CallNegotiationPort,
};
