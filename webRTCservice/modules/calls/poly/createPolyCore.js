// Composition helper for the PolySession orchestration core. Given the
// transport primitives + gateways that already exist in the composition root
// (webRTCmanager.js), this assembles the whole new core and returns the registry
// + ingress funnel. This is the single seam the composition root wires to; all
// concrete dependencies are injected here (DI), nothing reaches for globals.

const { MediaController } = require("./MediaController");
const { LegFactory } = require("./LegFactory");
const { PolySessionRegistry } = require("./PolySessionRegistry");
const { PolyIngress } = require("./PolyIngress");
const { WebRtcNegotiation } = require("./negotiation/WebRtcNegotiation");
const { SipNegotiation } = require("./negotiation/SipNegotiation");

// `deps`:
//   mediaGraphFactory          - existing MediaGraphFactory
//   sessions                   - SessionStore (to look up per-leg transport state)
//   webrtcPrimitives           - { RTCSessionDescription, MediaStreamTrack, createAnswerSdp,
//                                  waitForIceGathering, formatIceCandidates, getRelayCandidates,
//                                  embedCandidatesInSdp, patchInactiveToSendrecv,
//                                  ensureLocalAudioTrack, logSdp }
//   makeSignalingTransport(ctx)- builds a SignalingTransportPort for a leg's data channel
//   sipPort                    - { openOutbound, openInbound, close, sendDtmf, setHold }
//   outboundInvite(ctx)        - async ({ callerSessionId, destination }) -> legSession
//                                (delegates the proven WebRtcOutboundLegFactory + FCM invite;
//                                 only needed for secnum->secnum callee legs)
//   logger
function createPolyCore(deps = {}) {
    const {
        mediaGraphFactory,
        webrtcPrimitives,
        makeSignalingTransport,
        sipPort,
        outboundInvite = null,
        makeTeardownHooks = null, // ({ key, a, b }) -> [fn(reason, poly)] e.g. minuteCounter.finish
        logger = console,
    } = deps;

    if (!mediaGraphFactory) throw new Error("createPolyCore requires mediaGraphFactory");
    if (!webrtcPrimitives) throw new Error("createPolyCore requires webrtcPrimitives");
    if (typeof makeSignalingTransport !== "function") {
        throw new Error("createPolyCore requires makeSignalingTransport(ctx)");
    }

    const mediaController = new MediaController({ mediaGraphFactory, logger });

    const webRtcNegotiationFactory = ({ id, endpoint, session, role = "caller", destination = null, callerSessionId = null, adoptSession = false }) => {
        let inviteCallee = null;
        if (role === "callee") {
            inviteCallee = adoptSession
                // Inbound (sip->secnum): the FCM session offer was already sent
                // out-of-band by the inbound flow. connect() must NOT re-invite --
                // just adopt the existing PC1 session and stay deferred (CONNECTING)
                // until its data channel opens, so the client's session answer is
                // applied as a session answer, not a premature pickup.
                ? async () => session
                : (typeof outboundInvite === "function"
                    ? async ({ destination: d } = {}) => outboundInvite({ callerSessionId, destination: d || destination })
                    : null);
        }
        return new WebRtcNegotiation({
            id,
            endpoint,
            session,
            role,
            destination,
            inviteCallee,
            signaling: makeSignalingTransport({ id, endpoint, session, callerSessionId }),
            primitives: webrtcPrimitives,
            MediaStreamTrack: webrtcPrimitives.MediaStreamTrack,
            logger,
        });
    };

    const sipNegotiationFactory = ({ id, endpoint, session, phoneNumber = null }) => new SipNegotiation({
        id,
        endpoint,
        session,
        phoneNumber,
        sip: sipPort,
        logger,
    });

    const legFactory = new LegFactory({ webRtcNegotiationFactory, sipNegotiationFactory, logger });
    const registry = new PolySessionRegistry({ legFactory, mediaController, makeTeardownHooks, logger });
    const ingress = new PolyIngress({ registry, logger });

    return { mediaController, legFactory, registry, ingress };
}

module.exports = {
    createPolyCore,
};
