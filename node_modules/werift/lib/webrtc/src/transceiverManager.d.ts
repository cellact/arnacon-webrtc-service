import { Event } from "./imports/common";
import { MediaStream, type MediaStreamTrack, type RTCRtpParameters, type RTCRtpReceiveParameters, RTCRtpReceiver, RTCRtpSender, RTCRtpTransceiver, type RtpRouter, type TransceiverOptions } from "./media";
import type { RTCStats } from "./media/stats";
import { type PeerConfig } from "./peerConnection";
import { type MediaDescription } from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { Kind } from "./types/domain";
export declare class TransceiverManager {
    private readonly cname;
    private readonly config;
    private readonly router;
    private readonly transceivers;
    readonly onTransceiverAdded: Event<[RTCRtpTransceiver]>;
    readonly onRemoteTransceiverAdded: Event<[RTCRtpTransceiver]>;
    readonly onTrack: Event<[{
        track: MediaStreamTrack;
        transceiver: RTCRtpTransceiver;
        stream: MediaStream;
    }]>;
    readonly onNegotiationNeeded: Event<[]>;
    constructor(cname: string, config: Required<PeerConfig>, router: RtpRouter);
    getTransceivers(): RTCRtpTransceiver[];
    getSenders(): RTCRtpSender[];
    getReceivers(): RTCRtpReceiver[];
    getTransceiverByMLineIndex(index: number): RTCRtpTransceiver | undefined;
    pushTransceiver(t: RTCRtpTransceiver): void;
    replaceTransceiver(t: RTCRtpTransceiver, index: number): void;
    addTransceiver(trackOrKind: Kind | MediaStreamTrack, dtlsTransport?: RTCDtlsTransport, options?: Partial<TransceiverOptions>): RTCRtpTransceiver;
    addTrack(track: MediaStreamTrack, ms?: MediaStream): RTCRtpTransceiver;
    removeTrack(sender: RTCRtpSender): void;
    assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void;
    getLocalRtpParams(transceiver: RTCRtpTransceiver): RTCRtpParameters;
    getRemoteRtpParams(media: MediaDescription, transceiver: RTCRtpTransceiver): RTCRtpReceiveParameters;
    setRemoteRTP(transceiver: RTCRtpTransceiver, remoteMedia: MediaDescription, type: "offer" | "answer", mLineIndex: number): void;
    getStats(selector?: MediaStreamTrack | null): Promise<RTCStats[]>;
    /**
     * 全トランシーバーのreceiver/senderのstopを呼ぶcloseメソッド
     */
    close(): void;
}
