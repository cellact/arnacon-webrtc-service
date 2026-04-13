"use strict";
const sdpUtils = require("./sdpUtils");

function patchRouterForDynamicSsrc(pc, logger = console) {
    const router = pc?.router;
    if (!router || router._ssrcPatchApplied) return false;
    const origRouteRtp = router.routeRtp.bind(router);
    router._rtpInCount = 0;
    router._ssrcPatchApplied = true;
    router.routeRtp = (packet) => {
        router._rtpInCount++;
        const incomingSsrc = packet.header.ssrc;
        if (router.ssrcTable && router.ssrcTable[incomingSsrc]) {
            origRouteRtp(packet);
            return;
        }
        const recvs = pc.getReceivers ? pc.getReceivers() : [];
        for (const recv of recvs) {
            const bySsrc = recv.trackBySSRC || {};
            if (bySsrc[incomingSsrc]) break;

            const tracks = recv.tracks || [];
            if (tracks.length === 1) {
                // Keep using the already-created track object so existing RTP subscriptions survive.
                const existingTrack = tracks[0];
                const oldSsrc = existingTrack.ssrc;
                if (oldSsrc !== incomingSsrc) {
                    if (router.ssrcTable) {
                        delete router.ssrcTable[oldSsrc];
                        router.ssrcTable[incomingSsrc] = recv;
                    }
                    if (recv.trackBySSRC && recv.trackBySSRC[oldSsrc] === existingTrack) {
                        delete recv.trackBySSRC[oldSsrc];
                    }
                    existingTrack.ssrc = incomingSsrc;
                    if (recv.trackBySSRC) recv.trackBySSRC[incomingSsrc] = existingTrack;
                    logger.log(`[SSRC-FIX] Rebound existing track: ssrc ${oldSsrc} -> ${incomingSsrc}`);
                }
                break;
            }

            // Legacy placeholder behavior: receivers that start with SSRC=1.
            if (tracks.length > 0 && tracks.every((t) => t.ssrc === 1)) {
                const existingTrack = recv.trackBySSRC?.[1];
                if (existingTrack) {
                    const oldSsrc = 1;
                    if (router.ssrcTable) {
                        delete router.ssrcTable[oldSsrc];
                        router.ssrcTable[incomingSsrc] = recv;
                    }
                    existingTrack.ssrc = incomingSsrc;
                    delete recv.trackBySSRC[oldSsrc];
                    recv.trackBySSRC[incomingSsrc] = existingTrack;
                    logger.log(`[SSRC-FIX] Rebound existing track: ssrc ${oldSsrc} -> ${incomingSsrc}`);
                    break;
                }
            }
        }
        origRouteRtp(packet);
    };
    logger.log("[SSRC-FIX] Router patched for late SSRC binding");
    return true;
}

function createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers,
    onDataChannelOpen,
    onDataChannelMessage,
    destroySession,
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
                destroySession(sessionId, true);
            } else if (state === "disconnected") {
                if (!s.disconnectTimer) {
                    s.disconnectTimer = setTimeout(() => {
                        s.disconnectTimer = null;
                        const current = sessions.get(sessionId);
                        if (current && current.peerConnection === pc && current.connectionState === "disconnected") {
                            destroySession(sessionId, true);
                        }
                    }, 5000);
                }
            } else if (state === "connected") {
                if (s.disconnectTimer) {
                    clearTimeout(s.disconnectTimer);
                    s.disconnectTimer = null;
                }
            }
        });
        pc.onTrack.subscribe((track) => {
            logger.log(`[${sessionId}] PC1 remote track received: ${track.kind}`);
            session.remoteTracks.push(track);
        });
        patchRouterForDynamicSsrc(pc, logger);
        session.peerConnection = pc;
        return pc;
    }

    function startMediaRelay(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        if (session._relayDisposers) {
            for (const dispose of session._relayDisposers) {
                try { dispose(); } catch (_) {}
            }
        }
        if (session._relayStatsTimer) {
            clearInterval(session._relayStatsTimer);
            session._relayStatsTimer = null;
        }
        session._relayDisposers = [];
        session.mediaRelayActive = true;
        const pc2 = session.sipPeerConnection;
        const pc1 = session.peerConnection;
        if (pc1?.router) pc1.router._rtpInCount = 0;
        let kamPipeActive = false;
        let kamSourceNotified = false;
        let clientToKam = 0;
        let kamToClient = 0;
        let kamUnsubscribe = null;

        if (pc1 && session.sipLocalAudioTrack) {
            for (const t of pc1.getTransceivers()) {
                if (t.kind === "audio" && t.receiver) {
                    for (const track of (t.receiver.tracks || [])) {
                        if (track.kind === "audio") {
                            const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
                                if (!session.mediaRelayActive) return;
                                clientToKam++;
                                session.sipLocalAudioTrack.writeRtp(rtp);
                            });
                            session._relayDisposers.push(unSubscribe);
                        }
                    }
                    break;
                }
            }
        }

        const kamHandler = (rtp) => {
            if (!session.mediaRelayActive) return;
            if (!kamSourceNotified && session.localAudioTrack) {
                kamSourceNotified = true;
                session.localAudioTrack.onSourceChanged.execute({
                    sequenceNumber: rtp.header.sequenceNumber,
                    timestamp: rtp.header.timestamp,
                });
            }
            kamToClient++;
            if (session.localAudioTrack) session.localAudioTrack.writeRtp(rtp);
        };

        const subscribeKamTrack = (track) => {
            if (!track || track.kind !== "audio" || !session.localAudioTrack || !session.mediaRelayActive) return;
            if (kamUnsubscribe) {
                try { kamUnsubscribe(); } catch (_) {}
                kamUnsubscribe = null;
            }
            const sub = track.onReceiveRtp.subscribe(kamHandler);
            kamUnsubscribe = sub?.unSubscribe || null;
            if (kamUnsubscribe) session._relayDisposers.push(kamUnsubscribe);
            kamPipeActive = true;
        };

        const wireKamToClient = () => {
            if (!session.mediaRelayActive || !pc2) return;
            const receivers = pc2.getReceivers ? pc2.getReceivers() : [];
            for (const r of receivers) {
                if (r.track?.kind === "audio") {
                    subscribeKamTrack(r.track);
                    break;
                }
            }
        };

        wireKamToClient();
        if (pc2) {
            pc2.onTrack.subscribe((track) => {
                if (track.kind === "audio") subscribeKamTrack(track);
            });
        }
        // Temporary diagnostics: verify whether RTP is flowing both directions.
        // Remove after media-path issue is resolved.
        session._relayStatsTimer = setInterval(() => {
            const pc1RtpIn = pc1?.router?._rtpInCount || 0;
            const pc2RtpIn = pc2?.router?._rtpInCount || 0;
            logger.log(
                `[${sessionId}] RTP-STATS pc1_in=${pc1RtpIn} pc2_in=${pc2RtpIn} client_to_kam=${clientToKam} kam_to_client=${kamToClient} ` +
                `pc2_present=${!!pc2} kam_pipe_active=${kamPipeActive}`
            );
        }, 2000);
        logger.log(`[${sessionId}] Media relay active`);
    }

    function stopMediaRelay(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        session.mediaRelayActive = false;
        if (session._relayDisposers) {
            for (const dispose of session._relayDisposers) {
                try { dispose(); } catch (_) {}
            }
            session._relayDisposers = [];
        }
        if (session._relayStatsTimer) {
            clearInterval(session._relayStatsTimer);
            session._relayStatsTimer = null;
        }
        logger.log(`[${sessionId}] Media relay stopped`);
    }

    return {
        createPeerConnection,
        startMediaRelay,
        stopMediaRelay,
        patchRouterForDynamicSsrc: (pc) => patchRouterForDynamicSsrc(pc, logger),
    };
}

module.exports = {
    createPeerConnectionFactory,
    fixSdpForWerift: sdpUtils.fixSdpForWerift,
    waitForIceGathering: sdpUtils.waitForIceGathering,
    formatIceCandidates: sdpUtils.formatIceCandidates,
    stripCandidatesFromSdp: sdpUtils.stripCandidatesFromSdp,
    getRelayCandidates: sdpUtils.getRelayCandidates,
    embedCandidatesInSdp: sdpUtils.embedCandidatesInSdp,
    patchInactiveToSendrecv: sdpUtils.patchInactiveToSendrecv,
    logSdp: sdpUtils.logSdp,
    addIceCandidates: sdpUtils.addIceCandidates,
};
