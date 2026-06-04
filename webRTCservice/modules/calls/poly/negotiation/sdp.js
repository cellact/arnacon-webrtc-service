// Pure SDP transforms ported verbatim (behavior-preserving) from the legacy
// RenegotiateCallUseCase / SignalingMessageRouter. Kept pure + dependency-free
// so they are unit-testable and reusable by the WebRtc negotiation adapter.

function splitSdpSections(sdp) {
    const normalized = String(sdp || "").replace(/\r?\n/g, "\r\n");
    const parts = normalized.split(/\r\n(?=m=)/);
    return {
        session: parts.shift() || "",
        media: parts,
    };
}

function mediaKind(section) {
    return section.match(/^m=([^\s]+)/m)?.[1] || null;
}

function mediaMid(section) {
    return section.match(/^a=mid:([^\r\n]+)/m)?.[1] || null;
}

function replaceOrInsertMid(section, mid) {
    if (!mid) return section;
    if (/^a=mid:/m.test(section)) return section.replace(/^a=mid:[^\r\n]+/m, `a=mid:${mid}`);
    return section.replace(/^m=[^\r\n]+\r\n/, (line) => `${line}a=mid:${mid}\r\n`);
}

// An inactive audio section is kept "reusable" by advertising port 9 instead of
// 0, so a follow-up call can re-activate audio on the same session.
function keepInactiveAudioReusable(answerSection, offerSection) {
    if (mediaKind(answerSection) !== "audio") return answerSection;
    if (!/^a=inactive/m.test(offerSection)) return answerSection;
    return answerSection.replace(/^m=audio\s+0\s+/m, "m=audio 9 ");
}

function keepGeneratedInactiveAudioReusable(section) {
    if (mediaKind(section) !== "audio") return section;
    return section.replace(/^m=audio\s+0\s+/m, "m=audio 9 ");
}

function setBundleMids(sessionSection, mids) {
    if (!mids.length) return sessionSection;
    const bundle = `a=group:BUNDLE ${mids.join(" ")}`;
    if (/^a=group:BUNDLE\s+/m.test(sessionSection)) {
        return sessionSection.replace(/^a=group:BUNDLE\s+[^\r\n]+/m, bundle);
    }
    return `${sessionSection}${bundle}\r\n`;
}

function normalizeEndCallOfferSdp(offerSdp) {
    const sdp = splitSdpSections(offerSdp);
    const mids = sdp.media.map(mediaMid).filter(Boolean);
    const session = setBundleMids(sdp.session, mids);
    const media = sdp.media.map(keepGeneratedInactiveAudioReusable);
    return [session, ...media].join("\r\n").replace(/\r\n{3,}/g, "\r\n\r\n");
}

function alignEndCallAnswerSdp(answerSdp, offerSdp) {
    const offer = splitSdpSections(offerSdp);
    const answer = splitSdpSections(answerSdp);
    const offerBundle = offer.session.match(/^a=group:BUNDLE\s+([^\r\n]+)/m)?.[1] || null;
    let session = answer.session;
    if (offerBundle) {
        if (/^a=group:BUNDLE\s+/m.test(session)) {
            session = session.replace(/^a=group:BUNDLE\s+[^\r\n]+/m, `a=group:BUNDLE ${offerBundle}`);
        } else {
            session += `a=group:BUNDLE ${offerBundle}\r\n`;
        }
    }
    const media = answer.media.map((section, index) => {
        const offerSection = offer.media[index] || "";
        const mid = mediaMid(offerSection);
        return keepInactiveAudioReusable(replaceOrInsertMid(section, mid), offerSection);
    });
    return [session, ...media].join("\r\n").replace(/\r\n{3,}/g, "\r\n\r\n");
}

// True when an offer carries no active (sendrecv) audio -> it's a teardown /
// data-only renegotiation, not a fresh ring. Ported from SignalingMessageRouter,
// made section-accurate so it inspects the whole audio m-section.
function isInactiveOffer(sdp) {
    const { media } = splitSdpSections(sdp);
    const audioSection = media.find((s) => mediaKind(s) === "audio") || "";
    if (!audioSection) return true;
    return /^a=inactive/m.test(audioSection) && !/^a=sendrecv/m.test(audioSection);
}

function audioDirection(sdp) {
    return String(sdp || "").match(/m=audio[\s\S]*?a=(sendrecv|recvonly|sendonly|inactive)/m)?.[1] || null;
}

module.exports = {
    splitSdpSections,
    mediaKind,
    mediaMid,
    replaceOrInsertMid,
    keepInactiveAudioReusable,
    keepGeneratedInactiveAudioReusable,
    setBundleMids,
    normalizeEndCallOfferSdp,
    alignEndCallAnswerSdp,
    isInactiveOffer,
    audioDirection,
};
