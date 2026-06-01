const { buildEndCallAnswerPayload } = require("../../participants/signaling/SignalingEnvelope");

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
        await pc.setLocalDescription(answer);
        const answerSdp = answer.sdp;

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
