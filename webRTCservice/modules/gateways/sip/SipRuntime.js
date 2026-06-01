const { CallEventSources, createRemoteByeReceivedEvent } = require("../../calls/CallEvents");

function createSipRuntime({
    sessions,
    patchRouterForDynamicSsrc,
    SessionState,
    onCallEvent = null,
    isInCall = null,
    logger = console,
}) {
    function attachSbcByeHandler(sipSession, sessionId) {
        sipSession.stateChange.addListener((state) => {
            if (state === SessionState.Terminated) {
                const s = sessions.get(sessionId);
                if (s && typeof isInCall === "function" && isInCall(s)) {
                    if (typeof onCallEvent !== "function") {
                        logger.error(`[${sessionId}] SIP remote BYE ignored: onCallEvent is not configured`);
                        return;
                    }
                    Promise.resolve(onCallEvent(sessionId, createRemoteByeReceivedEvent({
                        source: CallEventSources.Sip,
                        reason: "remote-bye",
                        remoteDialogId: sipSession.id || null,
                        notifyClient: true,
                        propagateLinkedSession: true,
                    }))).catch((err) => {
                        logger.error(`[${sessionId}] SIP remote BYE event failed: ${err.message}`);
                    });
                }
            }
        });
    }

    function setupPc2(session, pc2, sessionId) {
        session.sipPeerConnection = pc2;
        const senders = pc2.getSenders();
        const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
        if (audioSender) session.sipLocalAudioTrack = audioSender.track;
        patchRouterForDynamicSsrc(pc2);

        if (pc2.iceConnectionStateChange?.subscribe) {
            pc2.iceConnectionStateChange.subscribe((state) => logger.log(`[${sessionId}] PC2 iceConnectionState → ${state}`));
        } else if (pc2.onIceConnectionStateChange?.subscribe) {
            pc2.onIceConnectionStateChange.subscribe((state) => logger.log(`[${sessionId}] PC2 iceConnectionState → ${state}`));
        }
        if (pc2.connectionStateChange?.subscribe) {
            pc2.connectionStateChange.subscribe((state) => logger.log(`[${sessionId}] PC2 connectionState → ${state}`));
        } else if (pc2.onConnectionStateChange?.subscribe) {
            pc2.onConnectionStateChange.subscribe((state) => logger.log(`[${sessionId}] PC2 connectionState → ${state}`));
        }
    }

    return {
        attachSbcByeHandler,
        setupPc2,
    };
}

module.exports = {
    createSipRuntime,
};
