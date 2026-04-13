"use strict";

const werift = require("werift");
const { WebSocket: WsWebSocket } = require("ws");

function applyPolyfills({ fixSdpForWerift = null, logger = console } = {}) {
    if (!globalThis.WebSocket) {
        globalThis.WebSocket = WsWebSocket;
    }

    const OrigRTCPeerConnection = werift.RTCPeerConnection;
    const origSetRemote = OrigRTCPeerConnection.prototype.setRemoteDescription;
    if (typeof fixSdpForWerift === "function") {
        OrigRTCPeerConnection.prototype.setRemoteDescription = async function (desc) {
            let sdpStr = typeof desc === "string" ? desc : (desc?.sdp || "");
            const typeStr = typeof desc === "string" ? "raw" : (desc?.type || "unknown");
            const fixedSdp = fixSdpForWerift(sdpStr);
            if (fixedSdp !== sdpStr) {
                sdpStr = fixedSdp;
                if (typeof desc !== "string" && desc?.sdp !== undefined) {
                    desc = new werift.RTCSessionDescription(sdpStr, desc.type);
                }
            }
            try {
                return await origSetRemote.call(this, desc);
            } catch (err) {
                logger.error(`[SDP-FIX] setRemoteDescription FAILED for ${typeStr}: ${err?.message}`);
                throw err;
            }
        };
    }

    const PCMA_CODEC = new werift.RTCRtpCodecParameters({
        mimeType: "audio/PCMA",
        clockRate: 8000,
        channels: 1,
        payloadType: 8,
    });
    const WrappedRTCPeerConnection = function (config = {}) {
        if (!config.codecs) config.codecs = {};
        if (!config.codecs.audio) {
            config.codecs.audio = [PCMA_CODEC];
        } else {
            const hasPCMA = config.codecs.audio.some((c) => c.mimeType?.toLowerCase() === "audio/pcma");
            if (!hasPCMA) config.codecs.audio.push(PCMA_CODEC);
        }
        return new OrigRTCPeerConnection(config);
    };
    WrappedRTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
    Object.setPrototypeOf(WrappedRTCPeerConnection, OrigRTCPeerConnection);
    globalThis.RTCPeerConnection = WrappedRTCPeerConnection;
    globalThis.RTCIceCandidate = werift.RTCIceCandidate;

    const WeriftRTCSessionDescription = werift.RTCSessionDescription;
    globalThis.RTCSessionDescription = function (arg1, arg2) {
        if (arg1 && typeof arg1 === "object" && arg1.sdp !== undefined) {
            return new WeriftRTCSessionDescription(arg1.sdp, arg1.type);
        }
        return new WeriftRTCSessionDescription(arg1, arg2);
    };

    globalThis.MediaStreamTrackEvent = class MediaStreamTrackEvent {
        constructor(type, init) {
            this.type = type;
            this.track = init && init.track ? init.track : null;
        }
    };

    const WeriftMediaStream = werift.MediaStream;
    class BrowserMediaStream {
        constructor(tracksOrStream) {
            this._tracks = [];
            this._listeners = {};
            this.id = Math.random().toString(36).substring(2);
            if (Array.isArray(tracksOrStream)) {
                for (const t of tracksOrStream) this._tracks.push(t);
            } else if (tracksOrStream instanceof BrowserMediaStream) {
                for (const t of tracksOrStream._tracks) this._tracks.push(t);
            } else if (tracksOrStream instanceof WeriftMediaStream) {
                const wTracks = tracksOrStream.getTracks ? tracksOrStream.getTracks() : [];
                for (const t of wTracks) this._tracks.push(t);
            }
        }
        getTracks() { return this._tracks.slice(); }
        getAudioTracks() { return this._tracks.filter(t => t.kind === "audio"); }
        getVideoTracks() { return this._tracks.filter(t => t.kind === "video"); }
        getTrackById(id) { return this._tracks.find(t => t.id === id) || null; }
        addTrack(track) {
            if (!this._tracks.find(t => t.id === track.id)) this._tracks.push(track);
        }
        removeTrack(track) {
            this._tracks = this._tracks.filter(t => t.id !== track.id);
        }
        clone() { return new BrowserMediaStream(this._tracks); }
        addEventListener(type, cb) {
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(cb);
        }
        removeEventListener(type, cb) {
            if (!this._listeners[type]) return;
            this._listeners[type] = this._listeners[type].filter(fn => fn !== cb);
        }
        dispatchEvent(event) {
            const cbs = this._listeners[event.type];
            if (cbs) for (const cb of cbs) cb(event);
            return true;
        }
    }
    globalThis.MediaStream = BrowserMediaStream;

    const mstProto = werift.MediaStreamTrack.prototype;
    if (!mstProto.stop) {
        mstProto.stop = function () {};
    }
    if (!mstProto.id) {
        Object.defineProperty(mstProto, "id", {
            get() {
                if (!this._polyId) this._polyId = Math.random().toString(36).substring(2);
                return this._polyId;
            },
            configurable: true,
        });
    }
    globalThis.MediaStreamTrack = werift.MediaStreamTrack;

    if (!globalThis.navigator) globalThis.navigator = {};
    if (!globalThis.navigator.mediaDevices) globalThis.navigator.mediaDevices = {};
    globalThis.navigator.mediaDevices.getUserMedia = async (constraints) => {
        const tracks = [];
        if (constraints?.audio) tracks.push(new werift.MediaStreamTrack({ kind: "audio" }));
        if (constraints?.video) tracks.push(new werift.MediaStreamTrack({ kind: "video" }));
        return new BrowserMediaStream(tracks);
    };
}

module.exports = {
    applyPolyfills,
};
