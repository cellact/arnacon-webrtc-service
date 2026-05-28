"use strict";
const sdpUtils = require("./sdpUtils");

const RTP_PT_PCMU = 0;
const RTP_PT_PCMA = 8;

function parsePrimaryAudioPayloadType(sdp) {
    const audioSection = String(sdp || "").match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
    const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
    const pt = Number(mLine.split(/\s+/).slice(3)[0]);
    return Number.isFinite(pt) ? pt : null;
}

function payloadTypeFromCodecPolicy(policy) {
    if (policy === "pcmu") return RTP_PT_PCMU;
    if (policy === "pcma") return RTP_PT_PCMA;
    return null;
}

function deriveClientPayloadType(session) {
    const fromPolicy = payloadTypeFromCodecPolicy(session?.mediaCodecPolicy);
    if (fromPolicy !== null) return fromPolicy;
    return parsePrimaryAudioPayloadType(session?.peerConnection?.localDescription?.sdp);
}

function deriveSipPayloadType(pc2) {
    return (
        parsePrimaryAudioPayloadType(pc2?.remoteDescription?.sdp) ??
        parsePrimaryAudioPayloadType(pc2?.localDescription?.sdp)
    );
}

function muLawToLinear(value) {
    const u = (~value) & 0xff;
    let sample = ((u & 0x0f) << 3) + 0x84;
    sample <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (0x84 - sample) : (sample - 0x84);
}

function linearToMuLaw(sample) {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) {
        exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function aLawToLinear(value) {
    const a = value ^ 0x55;
    let sample = (a & 0x0f) << 4;
    const segment = (a & 0x70) >> 4;
    if (segment === 0) {
        sample += 8;
    } else if (segment === 1) {
        sample += 0x108;
    } else {
        sample += 0x108;
        sample <<= segment - 1;
    }
    return (a & 0x80) ? sample : -sample;
}

function linearToALaw(sample) {
    const SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
    let mask;
    let pcm = sample >> 3;
    if (pcm >= 0) {
        mask = 0xd5;
    } else {
        mask = 0x55;
        pcm = -pcm - 1;
        if (pcm < 0) pcm = 0;
    }

    let segment = 0;
    while (segment < SEG_END.length && pcm > SEG_END[segment]) segment++;
    if (segment >= SEG_END.length) return 0x7f ^ mask;

    let encoded = segment << 4;
    if (segment < 2) encoded |= (pcm >> 1) & 0x0f;
    else encoded |= (pcm >> segment) & 0x0f;
    return encoded ^ mask;
}

function transcodeG711Payload(payload, fromPt, toPt) {
    if (!payload || fromPt === toPt) return payload;
    if (!((fromPt === RTP_PT_PCMU && toPt === RTP_PT_PCMA) || (fromPt === RTP_PT_PCMA && toPt === RTP_PT_PCMU))) {
        return payload;
    }

    const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const converted = Buffer.allocUnsafe(source.length);
    if (fromPt === RTP_PT_PCMU) {
        for (let i = 0; i < source.length; i++) {
            converted[i] = linearToALaw(muLawToLinear(source[i]));
        }
    } else {
        for (let i = 0; i < source.length; i++) {
            converted[i] = linearToMuLaw(aLawToLinear(source[i]));
        }
    }
    return converted;
}

function adaptG711RtpPacket(rtp, targetPayloadType) {
    if (targetPayloadType === null || targetPayloadType === undefined) return rtp;
    const sourcePayloadType = Number(rtp?.header?.payloadType);
    const targetPt = Number(targetPayloadType);
    if (!rtp || !rtp.header || !Number.isFinite(sourcePayloadType) || !Number.isFinite(targetPt)) {
        return rtp;
    }
    if (sourcePayloadType === targetPt) return rtp;

    const convertedPayload = transcodeG711Payload(rtp.payload, sourcePayloadType, targetPt);
    if (convertedPayload === rtp.payload && !(
        (sourcePayloadType === RTP_PT_PCMU && targetPt === RTP_PT_PCMA) ||
        (sourcePayloadType === RTP_PT_PCMA && targetPt === RTP_PT_PCMU)
    )) {
        return rtp;
    }

    const packet = Object.assign(Object.create(Object.getPrototypeOf(rtp)), rtp);
    packet.header = Object.assign(Object.create(Object.getPrototypeOf(rtp.header)), rtp.header);
    packet.header.payloadType = targetPt;
    packet.payload = convertedPayload;
    return packet;
}

function patchRouterForDynamicSsrc(pc, logger = console) {
    const router = pc?.router;
    if (!router || router._ssrcPatchApplied) return false;
    const origRouteRtp = router.routeRtp.bind(router);
    router._rtpInCount = 0;
    router._inboundRtpSubscribers = router._inboundRtpSubscribers || new Set();
    router._ssrcPatchApplied = true;
    router.routeRtp = (packet) => {
        router._rtpInCount++;
        const incomingSsrc = packet.header.ssrc;
        if (router.ssrcTable && router.ssrcTable[incomingSsrc]) {
            origRouteRtp(packet);
        } else {
            const recvs = pc.getReceivers ? pc.getReceivers() : [];
            for (const recv of recvs) {
                const bySsrc = recv.trackBySSRC || {};
                if (bySsrc[incomingSsrc]) break;

                const tracks = recv.tracks || [];
                if (tracks.length === 1) {
                    // Keep using the already-created track object so existing RTP subscriptions survive.
                    const existingTrack = tracks[0];
                    const oldSsrc = existingTrack.ssrc;
                    const oldNum = Number(oldSsrc);
                    const canLateBind =
                        !Number.isFinite(oldNum) ||
                        oldNum <= 0 ||
                        oldNum === 1;
                    if (!canLateBind) {
                        continue;
                    }
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
        }
        for (const fn of router._inboundRtpSubscribers || []) {
            try { fn(packet); } catch (_) {}
        }
    };
    logger.log("[SSRC-FIX] Router patched for late SSRC binding");
    return true;
}

function createPeerConnectionFactory({
    sessions,
    RTCPeerConnection,
    iceServers,
    onDataChannelOpen,
    onPeerConnected = null,
    onDataChannelMessage,
    onInboundRtp = null,
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
        const clientPayloadType = deriveClientPayloadType(session);
        let sipPayloadType = deriveSipPayloadType(pc2);
        if (pc1?.router) pc1.router._rtpInCount = 0;
        let kamPipeActive = false;
        let kamSourceNotified = false;
        let clientToKam = 0;
        let kamToClient = 0;
        let clientToKamTranscoded = 0;
        let kamToClientTranscoded = 0;
        let kamUnsubscribe = null;
        let kamTrackPackets = 0;
        let kamRouterFallbackPackets = 0;
        let lastKamTrackRtpAt = 0;

        if (pc1 && session.sipLocalAudioTrack) {
            for (const t of pc1.getTransceivers()) {
                if (t.kind === "audio" && t.receiver) {
                    for (const track of (t.receiver.tracks || [])) {
                        if (track.kind === "audio") {
                            const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
                                if (!session.mediaRelayActive) return;
                                clientToKam++;
                                const outgoing = adaptG711RtpPacket(rtp, sipPayloadType);
                                if (outgoing !== rtp) clientToKamTranscoded++;
                                session.sipLocalAudioTrack.writeRtp(outgoing);
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
            kamTrackPackets++;
            lastKamTrackRtpAt = Date.now();
            if (!Number.isFinite(sipPayloadType)) sipPayloadType = Number(rtp?.header?.payloadType);
            if (!kamSourceNotified && session.localAudioTrack) {
                kamSourceNotified = true;
                session.localAudioTrack.onSourceChanged.execute({
                    sequenceNumber: rtp.header.sequenceNumber,
                    timestamp: rtp.header.timestamp,
                });
            }
            kamToClient++;
            if (session.localAudioTrack) {
                const outgoing = adaptG711RtpPacket(rtp, clientPayloadType);
                if (outgoing !== rtp) kamToClientTranscoded++;
                session.localAudioTrack.writeRtp(outgoing);
            }
        };

        const kamRouterFallbackHandler = (rtp) => {
            if (!session.mediaRelayActive || !session.localAudioTrack || !rtp?.header) return;
            // werift can keep counting inbound RTP while a receiver track subscription
            // stops firing after late SSRC binding. Use router packets only when the
            // normal track path has gone quiet, to avoid duplicate audio.
            if (lastKamTrackRtpAt && Date.now() - lastKamTrackRtpAt < 500) return;
            if (!Number.isFinite(sipPayloadType)) sipPayloadType = Number(rtp.header.payloadType);
            if (!kamSourceNotified) {
                kamSourceNotified = true;
                session.localAudioTrack.onSourceChanged.execute({
                    sequenceNumber: rtp.header.sequenceNumber,
                    timestamp: rtp.header.timestamp,
                });
            }
            const outgoing = adaptG711RtpPacket(rtp, clientPayloadType);
            if (outgoing !== rtp) kamToClientTranscoded++;
            kamRouterFallbackPackets++;
            kamToClient++;
            session.localAudioTrack.writeRtp(outgoing);
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
            if (pc2.router?._inboundRtpSubscribers) {
                pc2.router._inboundRtpSubscribers.add(kamRouterFallbackHandler);
                session._relayDisposers.push(() => {
                    try { pc2.router._inboundRtpSubscribers.delete(kamRouterFallbackHandler); } catch (_) {}
                });
            }
        }
        // Temporary diagnostics: verify whether RTP is flowing both directions.
        // Remove after media-path issue is resolved.
        session._relayStatsTimer = setInterval(() => {
            const pc1RtpIn = pc1?.router?._rtpInCount || 0;
            const pc2RtpIn = pc2?.router?._rtpInCount || 0;
            logger.log(
                `[${sessionId}] RTP-STATS pc1_in=${pc1RtpIn} pc2_in=${pc2RtpIn} client_to_kam=${clientToKam} kam_to_client=${kamToClient} ` +
                `client_pt=${clientPayloadType ?? "?"} sip_pt=${sipPayloadType ?? "?"} ` +
                `c2k_xcode=${clientToKamTranscoded} k2c_xcode=${kamToClientTranscoded} ` +
                `kam_track=${kamTrackPackets} kam_fallback=${kamRouterFallbackPackets} ` +
                `pc2_present=${!!pc2} kam_pipe_active=${kamPipeActive}`
            );
        }, 2000);
        logger.log(
            `[${sessionId}] Media relay active ` +
            `client_pt=${clientPayloadType ?? "?"} sip_pt=${sipPayloadType ?? "?"}`
        );
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
