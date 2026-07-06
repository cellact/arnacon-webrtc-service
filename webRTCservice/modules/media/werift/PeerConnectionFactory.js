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
    function createPeerConnection(sessionId, target = null, options = {}) {
        const session = target || sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const pcLabel = options.label || "PC1";
        const shouldRequestDestroy = options.destroyOnTerminalState !== false;
        if (Array.isArray(session._pcInboundRtpDisposers)) {
            for (const dispose of session._pcInboundRtpDisposers.splice(0)) {
                try { dispose(); } catch (_) {}
            }
        }
        session.remoteTracks = [];
        logger.log(`[${sessionId}] ${pcLabel} media state reset before peer creation`);

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
            logger.log(`[${sessionId}] ${pcLabel} connection state: ${state}`);
            const s = sessions.get(sessionId);
            if (!s || s.destroying || session.destroying) return;
            if (session.peerConnection !== pc) return;
            s.connectionState = state;
            session.connectionState = state;
            if (shouldRequestDestroy && (state === "failed" || state === "closed")) {
                onSessionDestroyRequested(sessionId, { source: "webrtc", reason: `peer-connection-${state}`, notify: true, pc });
            } else if (state === "disconnected") {
                if (!s.disconnectTimer) {
                    s.disconnectTimer = setTimeout(() => {
                        s.disconnectTimer = null;
                        const current = sessions.get(sessionId);
                        if (shouldRequestDestroy && current && session.peerConnection === pc && session.connectionState === "disconnected") {
                            onSessionDestroyRequested(sessionId, { source: "webrtc", reason: "peer-connection-disconnected", notify: true, pc });
                        }
                    }, 5000);
                }
            } else if (state === "connected") {
                // The call is established. Record it so the ICE-level teardown
                // below knows it is allowed to act: ICE transients before this
                // point are part of setup, not a drop.
                s.everConnected = true;
                session.everConnected = true;
                if (s.disconnectTimer) {
                    clearTimeout(s.disconnectTimer);
                    s.disconnectTimer = null;
                }
                if (typeof onPeerConnected === "function") {
                    onPeerConnected(sessionId);
                }
            }
        });
        // werift only drives the aggregate connectionState at fixed lifecycle
        // points (post-DTLS connect / explicit close). A peer that vanishes
        // mid-call (app force-closed) is detected ONLY by ICE consent-freshness,
        // which surfaces on iceConnectionStateChange -> "disconnected" and never
        // touches connectionState. Without this subscription the server would log
        // nothing and leak the session. We mirror the connectionState teardown,
        // but ONLY after the PC has reached "connected" at least once: ICE is a
        // noisy, explicitly-transient layer that bounces through disconnected/
        // failed DURING setup (e.g. a callee still ringing whose transport idles),
        // and acting on those would tear down a call that hasn't connected yet.
        // Setup-phase terminal failures are already handled by connectionState.
        pc.iceConnectionStateChange.subscribe((state) => {
            logger.log(`[${sessionId}] ${pcLabel} ICE connection state: ${state}`);
            const s = sessions.get(sessionId);
            if (!s || s.destroying || session.destroying) return;
            if (session.peerConnection !== pc) return;
            s.iceConnectionState = state;
            session.iceConnectionState = state;
            if (state === "connected" || state === "completed") {
                if (s.iceDisconnectTimer) {
                    clearTimeout(s.iceDisconnectTimer);
                    s.iceDisconnectTimer = null;
                }
                return;
            }
            // Never tear down off ICE transients before the call is up.
            if (!s.everConnected) return;
            // We always report the terminal/lost transport; `destroyOnTerminalState`
            // tells the handler WHAT to do. A primary PC (caller) destroys the
            // session; a non-destroy PC (the callee leg's PC-callee) must instead
            // just mark its leg's transport closed so the next call re-invites it
            // (notification/VoIP push) rather than ringing a dead data channel.
            if (state === "failed" || state === "closed") {
                onSessionDestroyRequested(sessionId, { source: "webrtc-ice", reason: `ice-${state}`, notify: true, pc, destroyOnTerminalState: shouldRequestDestroy });
            } else if (state === "disconnected") {
                if (!shouldRequestDestroy) {
                    // Non-destroy (callee leg) PC: flip its leg to DISCONNECTED the
                    // MOMENT consent fails, no debounce. A redial must see the callee
                    // leg as DISCONNECTED so reconcile re-CONNECTs (notification/VoIP
                    // wake) it instead of ringing a data channel that is already gone.
                    // werift only emits "disconnected" after a consent check failed
                    // (not a sub-second blip), and this only closes the leg (never
                    // destroys the session), so a false positive costs one re-invite.
                    onSessionDestroyRequested(sessionId, { source: "webrtc-ice", reason: "ice-disconnected", notify: true, pc, destroyOnTerminalState: false });
                } else if (!s.iceDisconnectTimer) {
                    // Primary PC: debounce -- acting here destroys the whole session,
                    // so we must not kill a live call on a transient blip.
                    s.iceDisconnectTimer = setTimeout(() => {
                        s.iceDisconnectTimer = null;
                        const current = sessions.get(sessionId);
                        if (current && session.peerConnection === pc && session.iceConnectionState === "disconnected") {
                            onSessionDestroyRequested(sessionId, { source: "webrtc-ice", reason: "ice-disconnected", notify: true, pc, destroyOnTerminalState: true });
                        }
                    }, 5000);
                }
            }
        });
        pc.onTrack.subscribe((track) => {
            logger.log(`[${sessionId}] ${pcLabel} remote track received: ${track.kind}`);
            if (!session.remoteTracks.includes(track)) session.remoteTracks.push(track);
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
