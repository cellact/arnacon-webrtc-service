// WebRTC transport strategy. One peer connection + data channel toward one
// endpoint. All SDP work (ring offer, answer, end-call renegotiation, applying
// remote descriptions) lives behind the injected CallNegotiationPort, so this
// class depends only on an abstraction and is substitutable for SipLeg (LSP).

const { SessionLeg } = require("../SessionLeg");

class WebRtcLeg extends SessionLeg {
    constructor({ id, endpoint, negotiation, logger = console } = {}) {
        super({ id, kind: "webrtc", endpoint, negotiation, logger });
    }
}

module.exports = {
    WebRtcLeg,
};
