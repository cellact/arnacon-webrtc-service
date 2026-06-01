const { SignalingMessageRouter } = require("./SignalingMessageRouter");

function createSignalingHandlers({
    sessions,
    handleEndCallRenegotiation,
    handleReofferAnswer,
    handleInboundCalleeAnswer,
    handleOutboundWebrtcLegAnswer = null,
    handleIceRestart,
    handleRing,
    handleCallEnd,
    handleCallDtmf = null,
    handleCallHold = null,
    handleDataMessage,
    resetPostCallForNewRing = null,
    isEndRenegotiationPending = null,
    canAcceptNewRing = null,
    isRinging = null,
    isInCall = null,
    getSessionKind = null,
    logger = console,
}) {
    function enqueueSignaling(sessionId, label, fn) {
        const s = sessions.get(sessionId);
        if (!s) {
            logger.error(`[${sessionId}] enqueueSignaling(${label}): no session`);
            return;
        }
        s.signalingQueue = s.signalingQueue.then(async () => {
            logger.log(`[${sessionId}] SIG-Q start: ${label}`);
            try {
                await fn();
            } catch (err) {
                logger.error(`[${sessionId}] SIG-Q error (${label}): ${err.message}`);
            }
            logger.log(`[${sessionId}] SIG-Q done: ${label}`);
        });
    }

    const router = new SignalingMessageRouter({
        sessions,
        enqueueSignaling,
        handleEndCallRenegotiation,
        handleReofferAnswer,
        handleInboundCalleeAnswer,
        handleOutboundWebrtcLegAnswer,
        handleIceRestart,
        handleRing,
        handleCallEnd,
        handleCallDtmf,
        handleCallHold,
        handleDataMessage,
        resetPostCallForNewRing,
        isEndRenegotiationPending,
        canAcceptNewRing,
        isRinging,
        isInCall,
        getSessionKind,
        logger,
    });

    return {
        enqueueSignaling,
        onDataChannelMessage: (...args) => router.onDataChannelMessage(...args),
    };
}

module.exports = {
    createSignalingHandlers,
};
//