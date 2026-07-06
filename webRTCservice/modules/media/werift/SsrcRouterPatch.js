function patchRouterForDynamicSsrc(pc, logger = console) {
    const router = pc?.router;
    if (!router || router._ssrcPatchApplied) return false;
    const origRouteRtp = router.routeRtp.bind(router);
    const rebindTrack = ({ recv, existingTrack, oldSsrc, incomingSsrc, reason }) => {
        if (router.ssrcTable) {
            delete router.ssrcTable[oldSsrc];
            router.ssrcTable[incomingSsrc] = recv;
        }
        if (recv.trackBySSRC && recv.trackBySSRC[oldSsrc] === existingTrack) {
            delete recv.trackBySSRC[oldSsrc];
        }
        existingTrack.ssrc = incomingSsrc;
        if (recv.trackBySSRC) recv.trackBySSRC[incomingSsrc] = existingTrack;
        logger.log(`[SSRC-FIX] Rebound existing track: ssrc ${oldSsrc} -> ${incomingSsrc} (${reason})`);
    };
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
                    const existingTrack = tracks[0];
                    const oldSsrc = existingTrack.ssrc;
                    const oldNum = Number(oldSsrc);
                    const looksLikePlaceholder =
                        !Number.isFinite(oldNum) ||
                        oldNum <= 0 ||
                        oldNum === 1;
                    if (oldSsrc !== incomingSsrc) {
                        rebindTrack({
                            recv,
                            existingTrack,
                            oldSsrc,
                            incomingSsrc,
                            reason: looksLikePlaceholder ? "placeholder" : "single-track",
                        });
                    }
                    break;
                }

                if (tracks.length > 0 && tracks.every((t) => t.ssrc === 1)) {
                    const existingTrack = recv.trackBySSRC?.[1];
                    if (existingTrack) {
                        rebindTrack({
                            recv,
                            existingTrack,
                            oldSsrc: 1,
                            incomingSsrc,
                            reason: "all-placeholder",
                        });
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

module.exports = {
    patchRouterForDynamicSsrc,
};
