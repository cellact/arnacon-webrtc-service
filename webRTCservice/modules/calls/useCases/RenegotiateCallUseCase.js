const { buildEndCallAnswerPayload } = require("../../participants/signaling/SignalingEnvelope");

function identityLabel(identity) {
    if (!identity || typeof identity !== "string") return identity;
    const trimmed = identity.trim();
    const atPos = trimmed.indexOf("@");
    if (atPos > 0) return trimmed.slice(0, atPos);
    const dotPos = trimmed.indexOf(".");
    if (dotPos > 0) return trimmed.slice(0, dotPos);
    return trimmed;
}

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

    resolveRenegotiationTarget(session, payload = {}, options = {}) {
        if (options.channelRole === "callee-webrtc") return session.outboundWebrtc || session;
        if (session.outboundWebrtcLegs?.values && payload?.from) {
            const from = identityLabel(String(payload.from).toLowerCase());
            for (const leg of session.outboundWebrtcLegs.values()) {
                if (
                    identityLabel(String(leg.toIdentity || "").toLowerCase()) === from ||
                    identityLabel(String(leg.walletAddress || "").toLowerCase()) === from
                ) {
                    return leg;
                }
            }
        }
        return session;
    }

    getOppositeTarget(session, target) {
        if (target === session) return session.outboundWebrtc || null;
        return session;
    }

    sendEndCallSignaling(sessionId, session, target, payload) {
        const message = {
            msgType: "signaling",
            action: "end-call",
            payload,
        };
        if (target === session) {
            this.sendDataChannelMessage(sessionId, message);
            return true;
        }
        if (!target?.dataChannel || target.dataChannel.readyState !== "open") return false;
        target.dataChannel.send(JSON.stringify(message));
        return true;
    }

    async setAudioInactive(pc) {
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.kind !== "audio") continue;
            transceiver.setDirection("inactive");
            if (transceiver.sender && typeof transceiver.sender.replaceTrack === "function") {
                try { await transceiver.sender.replaceTrack(null); } catch (_) {}
            }
            return true;
        }
        return false;
    }

    async sendEndCallOfferToTarget(sessionId, session, target) {
        if (!target || !target.peerConnection) return false;
        if (target.endCallRenegOfferSent) return true;
        if (target !== session && (!target.dataChannel || target.dataChannel.readyState !== "open")) return false;

        const pc = target.peerConnection;
        await this.setAudioInactive(pc);
        const offer = await pc.createOffer();
        const offerSdp = normalizeEndCallOfferSdp(offer.sdp);
        await pc.setLocalDescription(new this.RTCSessionDescription(offerSdp, "offer"));
        target.endCallRenegOfferSent = true;
        const from = target === session
            ? identityLabel(session.outboundWebrtc?.toIdentity || session.toIdentity)
            : identityLabel(session.callerEns);
        const to = target === session
            ? identityLabel(session.callerEns)
            : (target.toIdentity || session.toIdentity);
        const sent = this.sendEndCallSignaling(sessionId, session, target, {
            type: "offer",
            from,
            to,
            sessionId,
            sdp: offerSdp,
        });
        if (sent) {
            this.logSdp(sessionId, target === session ? "END-CALL OFFER SDP (to caller)" : "END-CALL OFFER SDP (to callee)", offerSdp);
        }
        return sent;
    }

    async handleEndCallAnswer(sessionId, target, payload) {
        if (!target || !target.peerConnection) return { complete: true };
        this.logSdp(sessionId, "END-CALL ANSWER SDP (from client)", payload.sdp);
        await target.peerConnection.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "answer"));
        target.endCallRenegOfferSent = false;
        target.endCallRenegAnswered = true;
        return { complete: true };
    }

    async handleEndCallRenegotiation(sessionId, payload, options = {}) {
        const session = this.sessions.get(sessionId);
        if (!session) return { complete: true };
        const target = this.resolveRenegotiationTarget(session, payload, options);
        if (payload?.type === "answer") {
            return this.handleEndCallAnswer(sessionId, target, payload);
        }
        if (!target || !target.peerConnection) return { complete: true };
        const pc = target.peerConnection;
        this.logSdp(sessionId, "END-CALL OFFER SDP (from client)", payload.sdp);
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "offer"));
        await this.setAudioInactive(pc);
        const answer = await pc.createAnswer();
        const answerSdp = alignEndCallAnswerSdp(answer.sdp, payload.sdp);
        await pc.setLocalDescription(new this.RTCSessionDescription(answerSdp, "answer"));

        if (this.callRuntime && target === session) {
            await this.callRuntime.clearSipRouteState(sessionId, { reason: "end-call-renegotiated" });
        }
        this.logSdp(sessionId, "END-CALL ANSWER SDP (to client)", answerSdp);
        this.sendEndCallSignaling(sessionId, session, target, buildEndCallAnswerPayload({
            from: target === session ? identityLabel(session.toIdentity) : identityLabel(session.callerEns),
            to: target === session ? identityLabel(session.callerEns) : (target.toIdentity || session.toIdentity),
            sessionId,
            sdp: answerSdp,
        }).payload);
        const oppositeRenegStarted = await this.sendEndCallOfferToTarget(sessionId, session, this.getOppositeTarget(session, target));
        this.callRuntime.markPostCall(sessionId, {
            source: "client",
            reason: "end-call-renegotiated",
            endCallRenegDone: !oppositeRenegStarted,
        });
        return { complete: !oppositeRenegStarted };
    }
}

module.exports = {
    RenegotiateCallUseCase,
};
