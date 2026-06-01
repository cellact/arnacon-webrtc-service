const { buildEndCallAnswerPayload } = require("../../participants/signaling/SignalingEnvelope");

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

function keepInactiveAudioReusable(answerSection, offerSection) {
    if (mediaKind(answerSection) !== "audio") return answerSection;
    if (!/^a=inactive/m.test(offerSection)) return answerSection;
    return answerSection.replace(/^m=audio\s+0\s+/m, "m=audio 9 ");
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

class RenegotiateCallUseCase {
    constructor({
        sessions,
        sendDataChannelMessage,
        closeSipSession,
        stopMediaRelay,
        finishMinuteCounter = null,
        logSdp,
        RTCSessionDescription,
        callRuntime = null,
    } = {}) {
        Object.assign(this, {
            sessions,
            sendDataChannelMessage,
            closeSipSession,
            stopMediaRelay,
            finishMinuteCounter,
            logSdp,
            RTCSessionDescription,
            callRuntime,
        });
    }

    async handleReofferAnswer(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection || !session.pendingReoffer) return;
        const pc = session.peerConnection;
        this.callRuntime.clearPendingReoffer(sessionId);
        this.logSdp(sessionId, "RE-OFFER ANSWER SDP (from client)", payload.sdp);
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "answer"));
    }

    async handleEndCallRenegotiation(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) return;
        const pc = session.peerConnection;
        this.logSdp(sessionId, "END-CALL OFFER SDP (from client)", payload.sdp);
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "offer"));
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.kind === "audio") {
                transceiver.setDirection("inactive");
                if (transceiver.sender && typeof transceiver.sender.replaceTrack === "function") {
                    try { await transceiver.sender.replaceTrack(null); } catch (_) {}
                }
                break;
            }
        }
        const answer = await pc.createAnswer();
        const answerSdp = alignEndCallAnswerSdp(answer.sdp, payload.sdp);
        await pc.setLocalDescription(new this.RTCSessionDescription(answerSdp, "answer"));

        if (this.callRuntime) {
            await this.callRuntime.clearSipRouteState(sessionId, { reason: "end-call-renegotiated" });
        }
        this.logSdp(sessionId, "END-CALL ANSWER SDP (to client)", answerSdp);
        this.sendDataChannelMessage(sessionId, buildEndCallAnswerPayload({
            from: session.toIdentity,
            to: session.callerEns,
            sessionId,
            sdp: answerSdp,
        }));
        this.callRuntime.markPostCall(sessionId, {
            source: "client",
            reason: "end-call-renegotiated",
            endCallRenegDone: true,
        });
    }
}

module.exports = {
    RenegotiateCallUseCase,
};
