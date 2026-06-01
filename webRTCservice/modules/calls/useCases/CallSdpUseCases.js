const { WebRtcClientLeg } = require("../../media/legs/WebRtcClientLeg");

class CallSdpUseCases {
    constructor({
        sessions,
        MediaStreamTrack,
        patchInactiveToSendrecv,
        logSdp,
        enqueueSignaling,
        sendDataChannelMessage,
        callRuntime = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            MediaStreamTrack,
            patchInactiveToSendrecv,
            logSdp,
            enqueueSignaling,
            sendDataChannelMessage,
            callRuntime,
            logger,
        });
    }

    ensureLocalAudioTrack(session, pc, sessionId) {
        const leg = new WebRtcClientLeg({
            session,
            sessionId,
            peerConnection: pc,
            MediaStreamTrack: this.MediaStreamTrack,
            logger: this.logger,
        });
        leg.ensureOutputTrack();
        return leg.getAudioTransceiver();
    }

    async createAnswerSdp(pc, sessionId, label) {
        const answer = await pc.createAnswer();
        let answerSdp = answer.sdp;
        const before = answerSdp;
        answerSdp = this.patchInactiveToSendrecv(answerSdp);
        if (answerSdp !== before) {
            this.logger.log(`[${sessionId}] Patched ${label}: inactive → sendrecv`);
            answer.sdp = answerSdp;
        }
        await pc.setLocalDescription(answer);
        const dir = answerSdp.match(/a=(sendrecv|recvonly|sendonly|inactive)/)?.[1] || "unknown";
        this.logger.log(`[${sessionId}] ${label} created (len=${answerSdp.length}, dir=${dir})`);
        this.logSdp(sessionId, label, answerSdp);
        return answerSdp;
    }

    sendSignalingOffer(sessionId, sdp) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            payload: {
                type: "offer",
                from: session.toIdentity,
                to: session.callerEns,
                sessionId,
                sdp,
            },
        });
    }

    schedulePhase2Reoffer(sessionId, pendingReoffer) {
        setTimeout(() => {
            this.enqueueSignaling(sessionId, "phase2-reoffer", async () => {
                const session = this.sessions.get(sessionId);
                if (!session || !session.peerConnection || !this.callRuntime?.isInCall(session)) return;
                const pc = session.peerConnection;
                const audioTransceiver = pc.getTransceivers().find((t) => t.kind === "audio");
                if (audioTransceiver) {
                    audioTransceiver.setDirection("sendrecv");
                    audioTransceiver.offerDirection = "sendrecv";
                }
                const serverOffer = await pc.createOffer();
                await pc.setLocalDescription(serverOffer);
                this.logSdp(sessionId, "PHASE 2 RE-OFFER SDP", serverOffer.sdp);
                this.sendSignalingOffer(sessionId, serverOffer.sdp);
                if (this.callRuntime) this.callRuntime.attachPendingReoffer(sessionId, pendingReoffer);
            });
        }, 1000);
    }
}

module.exports = {
    CallSdpUseCases,
};
