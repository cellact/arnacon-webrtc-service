function fixSdpForWerift(sdp) {
    const sessionMatch = sdp.match(/^(c=IN IP[46] [^\r\n]+)/m);
    if (sessionMatch) {
        const cLine = sessionMatch[1];
        sdp = sdp.replace(/(m=[^\r\n]+\r?\n)(?!c=)/g, `$1${cLine}\r\n`);
    }
    sdp = sdp.replace(/^a=rtcp:\d+\r?\n/gm, "");

    let midIdx = 0;
    sdp = sdp.replace(/(m=[^\r\n]+\r?\n)([\s\S]*?)(?=m=[^\r\n]|\s*$)/g, (match, mLine, rest) => {
        if (!/^a=mid:/m.test(rest)) return `${mLine}a=mid:${midIdx++}\r\n${rest}`;
        midIdx++;
        return match;
    });

    if (/^m=audio /m.test(sdp) && !/^a=ssrc:/m.test(sdp)) {
        sdp = sdp.replace(/^(a=sendrecv)/m, "a=ssrc:1 cname:rtpengine\r\n$1");
    }
    return sdp;
}

function waitForIceGathering(pc, timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        const interval = setInterval(() => {
            if (pc.iceGatheringState === "complete") { clearInterval(interval); done(); }
        }, 100);
        pc.onIceCandidate.subscribe((c) => { if (!c) { clearInterval(interval); done(); } });
        setTimeout(() => { clearInterval(interval); done(); }, timeoutMs);
    });
}

function formatIceCandidates(session) {
    return session.iceCandidates.map(c => ({
        sdpMid: c.sdpMid != null ? String(c.sdpMid) : "0",
        sdpMLineIndex: c.sdpMLineIndex,
        candidate: c.candidate,
    }));
}

function stripCandidatesFromSdp(sdp) {
    return sdp.split("\n").filter(line => !line.trimStart().startsWith("a=candidate:")).join("\n");
}

function getRelayCandidates(candidates) {
    const relay = candidates.filter(c => c.candidate && c.candidate.includes("typ relay"));
    return relay.length > 0 ? relay : candidates;
}

function embedCandidatesInSdp(sdp, candidates) {
    if (!candidates || candidates.length === 0) return sdp;
    const bySection = {};
    for (const c of candidates) {
        const idx = c.sdpMLineIndex ?? 0;
        if (!bySection[idx]) bySection[idx] = [];
        bySection[idx].push(c.candidate.replace(/^candidate:/, ""));
    }
    const lineEnding = sdp.includes("\r\n") ? "\r\n" : "\n";
    const lines = sdp.split(lineEnding);
    const result = [];
    let sectionIdx = -1;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith("m=")) {
            if (sectionIdx >= 0 && bySection[sectionIdx]) {
                for (const c of bySection[sectionIdx]) result.push(`a=candidate:${c}`);
                result.push("a=end-of-candidates");
            }
            sectionIdx++;
        }
        if (line !== "") result.push(line);
    }
    if (sectionIdx >= 0 && bySection[sectionIdx]) {
        for (const c of bySection[sectionIdx]) result.push(`a=candidate:${c}`);
        result.push("a=end-of-candidates");
    }
    return result.join(lineEnding) + lineEnding;
}

// Also patches a=recvonly on the audio section. werift emits recvonly when the
// audio sender has no live track (e.g. after a prior end-call reneg
// replaceTrack(null) or an unresolved cancel leaving the sender dangling).
// Shipping recvonly on the accept path breaks Android which treats it as a
// stale/inactive answer and never picks up the call.
function patchInactiveToSendrecv(sdp) {
    if (/m=audio[\s\S]*?a=(inactive|recvonly)/m.test(sdp)) {
        return sdp.replace(/^(m=audio[\s\S]*?)a=(inactive|recvonly)/m, "$1a=sendrecv");
    }
    return sdp;
}

function logSdp(sessionId, label, sdp, logger = console) {
    const endLabel = label.replace(/\s*\([^)]*\)$/, "");
    logger.log(`[${sessionId}] ┌─── ${label} ───\n${sdp}\n[${sessionId}] └─── END ${endLabel} ───`);
}

async function addIceCandidates(pc, candidates, RTCIceCandidate) {
    let added = 0;
    const isMLineMismatch = (err) => {
        const msg = String(err?.message || "");
        return (
            /m[-\s]?line not found/i.test(msg) ||
            /iceParams/i.test(msg) ||
            /media section/i.test(msg) ||
            /reading 'kind'/i.test(msg)
        );
    };
    for (const c of (candidates || [])) {
        if (c && c.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(c));
                added++;
            } catch (err) {
                // Reused sessions can receive stale trickle candidates that refer to
                // an m-line no longer present in the latest negotiated SDP.
                if (!isMLineMismatch(err)) throw err;
            }
        }
    }
    return added;
}

module.exports = {
    fixSdpForWerift,
    waitForIceGathering,
    formatIceCandidates,
    stripCandidatesFromSdp,
    getRelayCandidates,
    embedCandidatesInSdp,
    patchInactiveToSendrecv,
    logSdp,
    addIceCandidates,
};
