const { MediaLeg } = require("../MediaLeg");
const {
    deriveSessionPayloadType,
} = require("../codecs/rtp");

class WebRtcClientLeg extends MediaLeg {
    constructor({
        session,
        sessionId = session?.sessionId,
        peerConnection = session?.peerConnection,
        MediaStreamTrack = globalThis.MediaStreamTrack,
        logger = console,
    } = {}) {
        super({
            id: sessionId,
            kind: "webrtc",
            payloadType: deriveSessionPayloadType(session),
            logger,
        });
        if (!session) throw new Error("WebRtcClientLeg requires session");
        if (!peerConnection) throw new Error("WebRtcClientLeg requires peerConnection");
        this.session = session;
        this.peerConnection = peerConnection;
        this.MediaStreamTrack = MediaStreamTrack;
        this.sourceNotified = false;
        this.trackUnsubscribe = null;
        this.lastTrackRtpAt = 0;
        this.routerFallbackPackets = 0;
        this.trackPackets = 0;
    }

    async start() {
        await super.start();
        this.ensureOutputTrack();
        this.payloadType = deriveSessionPayloadType(this.session);
    }

    getAudioTransceiver() {
        return this.peerConnection?.getTransceivers?.().find((t) => t.kind === "audio") || null;
    }

    ensureOutputTrack({ forceFresh = false } = {}) {
        const audioT = this.getAudioTransceiver();
        if (!audioT) return null;
        if (forceFresh || !this.session.localAudioTrack) {
            if (typeof this.MediaStreamTrack !== "function") {
                throw new Error("MediaStreamTrack unavailable for WebRTC leg");
            }
            const prev = this.session.localAudioTrack;
            this.session.localAudioTrack = new this.MediaStreamTrack({ kind: "audio" });
            if (prev && typeof prev.stop === "function") {
                try { prev.stop(); } catch (_) {}
            }
            this.logger.log(`[${this.id}] WebRTC leg created localAudioTrack`);
        } else {
            this.logger.log(`[${this.id}] WebRTC leg reusing localAudioTrack`);
        }
        if (audioT.sender && typeof audioT.sender.registerTrack === "function") {
            audioT.sender.registerTrack(this.session.localAudioTrack);
        }
        try { audioT.sender?.replaceTrack?.(this.session.localAudioTrack); } catch (_) {}
        audioT.setDirection("sendrecv");
        audioT.offerDirection = "sendrecv";
        return this.session.localAudioTrack;
    }

    getReceiverAudioTracks() {
        const out = [];
        const seen = new Set();
        const liveReceiverTracks = new Set();
        const addTrack = (track) => {
            if (!track || track.kind !== "audio" || seen.has(track)) return;
            seen.add(track);
            out.push(track);
        };

        if (this.peerConnection?.getReceivers) {
            for (const receiver of this.peerConnection.getReceivers()) {
                if (receiver?.track?.kind === "audio") liveReceiverTracks.add(receiver.track);
                addTrack(receiver?.track);
            }
        }
        if (this.peerConnection?.getTransceivers) {
            for (const transceiver of this.peerConnection.getTransceivers()) {
                if (transceiver?.kind !== "audio" || !transceiver.receiver?.tracks) continue;
                for (const track of transceiver.receiver.tracks) {
                    if (track?.kind === "audio") liveReceiverTracks.add(track);
                    addTrack(track);
                }
            }
        }
        // Prefer currently attached receiver tracks. Keep remoteTracks as fallback only.
        if (out.length === 0) {
            for (const track of this.session.remoteTracks || []) addTrack(track);
        } else if (Array.isArray(this.session.remoteTracks)) {
            this.session.remoteTracks = this.session.remoteTracks.filter((track) => liveReceiverTracks.has(track));
        }
        return out;
    }

    pickPreferredReceiverTrack(tracks = []) {
        if (!Array.isArray(tracks) || tracks.length === 0) return null;
        const remoteOrder = new Map();
        for (let i = 0; i < (this.session.remoteTracks || []).length; i += 1) {
            remoteOrder.set(this.session.remoteTracks[i], i);
        }
        const score = (track) => {
            const isLive = track?.readyState === "live" ? 1 : 0;
            const order = remoteOrder.has(track) ? remoteOrder.get(track) : -1;
            return (isLive * 1000000) + order;
        };
        let best = tracks[0];
        let bestScore = score(best);
        for (let i = 1; i < tracks.length; i += 1) {
            const candidate = tracks[i];
            const candidateScore = score(candidate);
            if (candidateScore > bestScore) {
                best = candidate;
                bestScore = candidateScore;
            }
        }
        return best;
    }

    onRtp(handler) {
        const disposers = [];
        const subscribed = new Set();
        const subscribeTrack = (track) => {
            if (!track || track.kind !== "audio" || !track.onReceiveRtp?.subscribe || subscribed.has(track)) return;
            if (this.trackUnsubscribe) {
                try { this.trackUnsubscribe(); } catch (_) {}
                this.trackUnsubscribe = null;
            }
            subscribed.add(track);
            const sub = track.onReceiveRtp.subscribe((packet) => {
                if (!this.active) return;
                this.trackPackets += 1;
                this.lastTrackRtpAt = Date.now();
                this.noteInbound();
                if (!Number.isFinite(this.payloadType)) this.payloadType = Number(packet?.header?.payloadType);
                handler(packet);
            });
            this.trackUnsubscribe = sub?.unSubscribe || null;
            if (this.trackUnsubscribe) disposers.push(this.trackUnsubscribe);
        };

        const receiverTracks = this.getReceiverAudioTracks();
        const preferredTrack = this.pickPreferredReceiverTrack(receiverTracks);
        if (preferredTrack) {
            if (receiverTracks.length > 1) {
                this.logger.warn(
                    `[${this.id}] WebRTC leg has ${receiverTracks.length} receiver audio tracks; preferring freshest live track`,
                );
            }
            subscribeTrack(preferredTrack);
            if (Array.isArray(this.session.remoteTracks) && this.session.remoteTracks.length > 1) {
                this.session.remoteTracks = this.session.remoteTracks.filter((track) => track === preferredTrack);
            }
        }
        const onTrackSub = this.peerConnection?.onTrack?.subscribe?.((track) => subscribeTrack(track));
        if (onTrackSub?.unSubscribe) disposers.push(() => onTrackSub.unSubscribe());

        const fallbackHandler = (packet) => {
            if (!this.active || !packet?.header) return;
            if (this.lastTrackRtpAt && Date.now() - this.lastTrackRtpAt < 500) return;
            this.routerFallbackPackets += 1;
            if (this.routerFallbackPackets === 1) {
                this.logger.warn(`[${this.id}] WebRTC leg RTP fallback path engaged (no recent receiver-track RTP)`);
            }
            this.noteInbound();
            if (!Number.isFinite(this.payloadType)) this.payloadType = Number(packet.header.payloadType);
            handler(packet);
        };
        if (this.peerConnection?.router?._inboundRtpSubscribers) {
            this.peerConnection.router._inboundRtpSubscribers.add(fallbackHandler);
            disposers.push(() => {
                try { this.peerConnection.router._inboundRtpSubscribers.delete(fallbackHandler); } catch (_) {}
            });
        }
        this.logger.log(`[${this.id}] WebRTC leg RTP input attached tracks=${subscribed.size} remoteTracks=${(this.session.remoteTracks || []).length}`);

        const dispose = () => {
            for (const fn of disposers.splice(0)) {
                try { fn(); } catch (_) {}
            }
            this.trackUnsubscribe = null;
            this.logger.log(
                `[${this.id}] WebRTC leg RTP input detached trackPackets=${this.trackPackets} fallbackPackets=${this.routerFallbackPackets}`,
            );
        };
        this.addDisposer(dispose);
        return dispose;
    }

    writeRtp(packet) {
        const track = this.session.localAudioTrack || this.ensureOutputTrack();
        if (!track || !packet?.header) return;
        if (!this.sourceNotified) {
            this.sourceNotified = true;
            track.onSourceChanged.execute({
                sequenceNumber: packet.header.sequenceNumber,
                timestamp: packet.header.timestamp,
            });
        }
        track.writeRtp(packet);
        this.noteOutbound();
    }

    async stop() {
        await super.stop();
        const audioT = this.getAudioTransceiver();
        if (audioT) {
            audioT.setDirection("inactive");
            if (audioT.sender && typeof audioT.sender.replaceTrack === "function") {
                try { await audioT.sender.replaceTrack(null); } catch (_) {}
            }
        }
        // Match negotiation end-call: drop the ref so the next call cannot
        // reuse a track that werift already treats as dead.
        this.session.localAudioTrack = null;
    }
}

module.exports = {
    WebRtcClientLeg,
};
