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
    }

    async start() {
        await super.start();
        this.ensureOutputTrack();
        this.payloadType = deriveSessionPayloadType(this.session);
    }

    getAudioTransceiver() {
        return this.peerConnection?.getTransceivers?.().find((t) => t.kind === "audio") || null;
    }

    ensureOutputTrack() {
        const audioT = this.getAudioTransceiver();
        if (!audioT) return null;
        if (!this.session.localAudioTrack) {
            if (typeof this.MediaStreamTrack !== "function") {
                throw new Error("MediaStreamTrack unavailable for WebRTC leg");
            }
            this.session.localAudioTrack = new this.MediaStreamTrack({ kind: "audio" });
            this.logger.log(`[${this.id}] WebRTC leg created localAudioTrack`);
        } else {
            this.logger.log(`[${this.id}] WebRTC leg reusing localAudioTrack`);
        }
        if (audioT.sender && typeof audioT.sender.registerTrack === "function") {
            audioT.sender.registerTrack(this.session.localAudioTrack);
        }
        audioT.setDirection("sendrecv");
        audioT.offerDirection = "sendrecv";
        return this.session.localAudioTrack;
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
            for (const receiver of this.peerConnection.getReceivers()) {
                addTrack(receiver?.track);
            }
        }
        if (this.peerConnection?.getTransceivers) {
            for (const transceiver of this.peerConnection.getTransceivers()) {
                if (transceiver?.kind !== "audio" || !transceiver.receiver?.tracks) continue;
                for (const track of transceiver.receiver.tracks) addTrack(track);
            }
        }
        for (const track of this.session.remoteTracks || []) addTrack(track);
        return out;
    }

    onRtp(handler) {
        const disposers = [];
        const subscribed = new Set();
        const subscribeTrack = (track) => {
            if (!track || track.kind !== "audio" || !track.onReceiveRtp?.subscribe || subscribed.has(track)) return;
            subscribed.add(track);
            const sub = track.onReceiveRtp.subscribe((packet) => {
                if (!this.active) return;
                this.noteInbound();
                handler(packet);
            });
            if (sub?.unSubscribe) disposers.push(() => sub.unSubscribe());
        };

        for (const track of this.getReceiverAudioTracks()) subscribeTrack(track);
        const onTrackSub = this.peerConnection?.onTrack?.subscribe?.((track) => subscribeTrack(track));
        if (onTrackSub?.unSubscribe) disposers.push(() => onTrackSub.unSubscribe());
        this.logger.log(`[${this.id}] WebRTC leg RTP input attached tracks=${subscribed.size}`);

        const dispose = () => {
            for (const fn of disposers.splice(0)) {
                try { fn(); } catch (_) {}
            }
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
    }
}

module.exports = {
    WebRtcClientLeg,
};
