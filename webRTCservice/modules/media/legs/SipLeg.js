const { MediaLeg } = require("../MediaLeg");
const { derivePeerConnectionPayloadType } = require("../codecs/rtp");

class SipLeg extends MediaLeg {
    constructor({
        session,
        sessionId = session?.sessionId,
        peerConnection = session?.sipPeerConnection,
        logger = console,
    } = {}) {
        super({
            id: sessionId,
            kind: "sip",
            payloadType: derivePeerConnectionPayloadType(peerConnection),
            logger,
        });
        if (!session) throw new Error("SipLeg requires session");
        if (!peerConnection) throw new Error("SipLeg requires sipPeerConnection");
        this.session = session;
        this.peerConnection = peerConnection;
        this.sourceNotified = false;
        this.lastTrackRtpAt = 0;
        this.routerFallbackPackets = 0;
        this.trackPackets = 0;
    }

    async start() {
        await super.start();
        this.payloadType = derivePeerConnectionPayloadType(this.peerConnection) ?? this.payloadType;
    }

    getOutputTrack() {
        if (this.session.sipLocalAudioTrack) return this.session.sipLocalAudioTrack;
        const audioSender = this.peerConnection?.getSenders?.().find((s) => s.track && s.track.kind === "audio");
        if (audioSender) this.session.sipLocalAudioTrack = audioSender.track;
        return this.session.sipLocalAudioTrack || null;
    }

    getReceiverAudioTracks() {
        const out = [];
        const seen = new Set();
        const addTrack = (track) => {
            if (!track || track.kind !== "audio" || seen.has(track)) return;
            seen.add(track);
            out.push(track);
        };
        if (this.peerConnection?.getReceivers) {
            for (const receiver of this.peerConnection.getReceivers()) addTrack(receiver?.track);
        }
        if (this.peerConnection?.getTransceivers) {
            for (const transceiver of this.peerConnection.getTransceivers()) {
                if (transceiver?.kind !== "audio" || !transceiver.receiver?.tracks) continue;
                for (const track of transceiver.receiver.tracks) addTrack(track);
            }
        }
        return out;
    }

    onRtp(handler) {
        const disposers = [];
        const subscribed = new Set();
        const subscribeTrack = (track) => {
            if (!track || track.kind !== "audio" || !track.onReceiveRtp?.subscribe || subscribed.has(track)) return;
            subscribed.add(track);
            this.logger.log(`[${this.id}] SIP leg subscribing receiver track ssrc=${track.ssrc ?? "unknown"}`);
            const sub = track.onReceiveRtp.subscribe((packet) => {
                if (!this.active) return;
                this.trackPackets += 1;
                this.lastTrackRtpAt = Date.now();
                this.noteInbound();
                if (!Number.isFinite(this.payloadType)) this.payloadType = Number(packet?.header?.payloadType);
                handler(packet);
            });
            const unsubscribe = sub?.unSubscribe || null;
            if (unsubscribe) disposers.push(unsubscribe);
        };

        for (const track of this.getReceiverAudioTracks()) {
            subscribeTrack(track);
        }
        const onTrackSub = this.peerConnection?.onTrack?.subscribe?.((track) => {
            if (track.kind === "audio") subscribeTrack(track);
        });
        if (onTrackSub?.unSubscribe) disposers.push(() => onTrackSub.unSubscribe());

        const fallbackHandler = (packet) => {
            if (!this.active || !packet?.header) return;
            if (this.lastTrackRtpAt && Date.now() - this.lastTrackRtpAt < 500) return;
            this.routerFallbackPackets += 1;
            if (this.routerFallbackPackets === 1) {
                this.logger.warn(`[${this.id}] SIP leg RTP fallback path engaged (no recent receiver-track RTP)`);
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

        this.logger.log(`[${this.id}] SIP leg RTP input attached tracks=${this.getReceiverAudioTracks().length}`);
        const dispose = () => {
            for (const fn of disposers.splice(0)) {
                try { fn(); } catch (_) {}
            }
            this.logger.log(
                `[${this.id}] SIP leg RTP input detached trackPackets=${this.trackPackets} fallbackPackets=${this.routerFallbackPackets}`,
            );
        };
        this.addDisposer(dispose);
        return dispose;
    }

    writeRtp(packet) {
        const track = this.getOutputTrack();
        if (!track || !packet) return;
        track.writeRtp(packet);
        this.noteOutbound();
    }

    health(now = Date.now()) {
        return {
            ...super.health(now),
            trackPackets: this.trackPackets,
            routerFallbackPackets: this.routerFallbackPackets,
        };
    }
}

module.exports = {
    SipLeg,
};
