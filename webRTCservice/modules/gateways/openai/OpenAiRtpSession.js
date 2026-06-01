class OpenAiRtpSession {
    constructor({
        sessions,
        mediaGraphFactory,
        offeredPayloadType,
        serializePlainRtp,
        deserializeRtpPacket,
        logger = console,
    }) {
        Object.assign(this, {
            sessions,
            mediaGraphFactory,
            offeredPayloadType,
            serializePlainRtp,
            deserializeRtpPacket,
            logger,
        });
    }

    start(call, remoteMedia) {
        const session = this.sessions.get(call.sessionId);
        const openAiLeg = this.mediaGraphFactory.createOpenAiLeg({
            call,
            remoteMedia,
            offeredPayloadType: this.offeredPayloadType,
            serializePlainRtp: this.serializePlainRtp,
            deserializeRtpPacket: this.deserializeRtpPacket,
            logger: this.logger,
        });
        let targetLeg;
        if (call.mediaAdapter) {
            targetLeg = this.mediaGraphFactory.createAdapterLeg({
                id: `${call.sessionId}:target`,
                kind: call.mode === "sales-agent" ? "sales-target" : "adapter",
                adapter: call.mediaAdapter,
                remoteMedia,
                logger: this.logger,
            });
        } else {
            const pc = session?.peerConnection;
            if (!session || !pc) throw new Error("OpenAI SIP RTP bridge missing caller peer connection");
            targetLeg = this.mediaGraphFactory.createWebRtcLeg(session);
        }
        this.mediaGraphFactory.openAiToTarget({
            id: call.sessionId,
            openAiLeg,
            targetLeg,
            sessions: session ? [session] : [],
        }).then((graph) => {
            call.mediaBridge = graph.bridge;
        }).catch((err) => {
            this.logger.error(`[${call.sessionId}] OpenAI media bridge failed: ${err.message}`);
        });
    }
}

module.exports = {
    OpenAiRtpSession,
};
