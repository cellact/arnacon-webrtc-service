const { patchRouterForDynamicSsrc } = require("./SsrcRouterPatch");

function createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers,
    onDataChannelOpen,
    onPeerConnected = null,
    onDataChannelMessage,
    onInboundRtp = null,
    onSessionDestroyRequested,
    logger = console,
}) {
    function createPeerConnection(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Session not found");

        const pc = new RTCPeerConnection({ iceServers });
        pc.onIceCandidate.subscribe((candidate) => {
            if (candidate) session.iceCandidates.push(candidate);
        });
        pc.onDataChannel.subscribe((channel) => {
            logger.log(`[${sessionId}] Data channel received: "${channel.label}"`);
            session.dataChannel = channel;
            channel.onopen = () => onDataChannelOpen(sessionId);
            channel.onMessage.subscribe((msg) => {
                const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf-8");
                onDataChannelMessage(sessionId, raw);
            });
            channel.onclose = () => logger.log(`[${sessionId}] Data channel closed`);
        });
        pc.connectionStateChange.subscribe((state) => {
            logger.log(`[${sessionId}] PC1 connection state: ${state}`);
            const s = sessions.get(sessionId);
            if (!s || s.destroying) return;
            if (s.peerConnection !== pc) return;
            s.connectionState = state;
            if (state === "failed" || state === "closed") {
                onSessionDestroyRequested(sessionId, { source: "webrtc", reason: `peer-connection-${state}`, notify: true });
            } else if (state === "disconnected") {
                if (!s.disconnectTimer) {
                    s.disconnectTimer = setTimeout(() => {
                        s.disconnectTimer = null;
                        const current = sessions.get(sessionId);
                        if (current && current.peerConnection === pc && current.connectionState === "disconnected") {
                            onSessionDestroyRequested(sessionId, { source: "webrtc", reason: "peer-connection-disconnected", notify: true });
                        }
                    }, 5000);
                }
            } else if (state === "connected") {
                if (s.disconnectTimer) {
                    clearTimeout(s.disconnectTimer);
                    s.disconnectTimer = null;
                }
                if (typeof onPeerConnected === "function") {
                    onPeerConnected(sessionId);
                }
            }
        });
        pc.onTrack.subscribe((track) => {
            logger.log(`[${sessionId}] PC1 remote track received: ${track.kind}`);
            session.remoteTracks.push(track);
            if (track.kind === "audio" && typeof onInboundRtp === "function" && track.onReceiveRtp?.subscribe) {
                const sub = track.onReceiveRtp.subscribe((rtp) => {
                    try {
                        onInboundRtp(sessionId, rtp);
                    } catch (_) {}
                });
                if (sub?.unSubscribe) {
                    if (!session._pcInboundRtpDisposers) session._pcInboundRtpDisposers = [];
                    session._pcInboundRtpDisposers.push(sub.unSubscribe);
                }
            }
        });
        patchRouterForDynamicSsrc(pc, logger);
        session.peerConnection = pc;
        return pc;
    }

    return {
        createPeerConnection,
        patchRouterForDynamicSsrc: (pc) => patchRouterForDynamicSsrc(pc, logger),
    };
}

module.exports = {
    createPeerConnectionFactory,
};
