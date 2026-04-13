"use strict";

function createSipRuntime({
    sessions,
    stopMediaRelay,
    sendDataChannelMessage,
    patchRouterForDynamicSsrc,
    SessionState,
    logger = console,
}) {
    function attachSbcByeHandler(sipSession, sessionId) {
        sipSession.stateChange.addListener((state) => {
            if (state === SessionState.Terminated) {
                const s = sessions.get(sessionId);
                if (s && s.phase === "in-call") {
                    stopMediaRelay(sessionId);
                    s.sipConnection = null;
                    s.sipPeerConnection = null;
                    s.sipLocalAudioTrack = null;
                    sendDataChannelMessage(sessionId, { msgType: "call", action: "end" });
                    s.phase = "post-call";
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
