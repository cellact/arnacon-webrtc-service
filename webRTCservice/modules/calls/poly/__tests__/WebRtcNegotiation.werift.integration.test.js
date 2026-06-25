const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildWeriftNegotiationHarness } = require("./helpers/weriftHarness");

const dataOnlyOfferSdp =
    "v=0\r\n" +
    "o=- 5832931903811073529 2 IN IP4 127.0.0.1\r\n" +
    "s=-\r\n" +
    "t=0 0\r\n" +
    "a=group:BUNDLE 0\r\n" +
    "a=extmap-allow-mixed\r\n" +
    "a=msid-semantic: WMS\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:57EQ\r\n" +
    "a=ice-pwd:JQGLYFDLhxBWo6r5hauNiYkM\r\n" +
    "a=ice-options:trickle renomination\r\n" +
    "a=fingerprint:sha-256 D9:5A:99:6F:F1:81:12:49:04:97:BC:76:96:D4:EE:C9:B5:27:4B:D6:8C:A4:68:8E:CF:27:D1:DC:90:96:3A:42\r\n" +
    "a=setup:actpass\r\n" +
    "a=mid:0\r\n" +
    "a=sctp-port:5000\r\n" +
    "a=max-message-size:262144\r\n";

const activeAudioOfferSdp =
    "v=0\r\n" +
    "o=- 41053953 0 IN IP4 0.0.0.0\r\n" +
    "s=-\r\n" +
    "t=0 0\r\n" +
    "a=group:BUNDLE 0 1\r\n" +
    "a=extmap-allow-mixed\r\n" +
    "a=msid-semantic:WMS *\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:d0a8\r\n" +
    "a=ice-pwd:5dc2124050d8b131def772\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 6A:1B:8B:C4:EF:AE:BF:48:9E:52:B6:B9:E7:86:5E:CC:1A:74:C6:1E:0E:5C:7C:89:66:EA:D5:D7:E7:23:FE:B7\r\n" +
    "a=setup:passive\r\n" +
    "a=mid:0\r\n" +
    "a=sctp-port:5000\r\n" +
    "a=max-message-size:65536\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:d0a8\r\n" +
    "a=ice-pwd:5dc2124050d8b131def772\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 6A:1B:8B:C4:EF:AE:BF:48:9E:52:B6:B9:E7:86:5E:CC:1A:74:C6:1E:0E:5C:7C:89:66:EA:D5:D7:E7:23:FE:B7\r\n" +
    "a=setup:passive\r\n" +
    "a=sendrecv\r\n" +
    "a=mid:1\r\n" +
    "a=rtcp:9 IN IP4 0.0.0.0\r\n" +
    "a=rtcp-mux\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n";

const inactiveEndCallOfferSdp =
    "v=0\r\n" +
    "o=- 12159584 0 IN IP4 0.0.0.0\r\n" +
    "s=-\r\n" +
    "t=0 0\r\n" +
    "a=group:BUNDLE 0 1\r\n" +
    "a=extmap-allow-mixed\r\n" +
    "a=msid-semantic:WMS *\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:5377\r\n" +
    "a=ice-pwd:ab5d1f31727880b2875978\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 6A:1B:8B:C4:EF:AE:BF:48:9E:52:B6:B9:E7:86:5E:CC:1A:74:C6:1E:0E:5C:7C:89:66:EA:D5:D7:E7:23:FE:B7\r\n" +
    "a=setup:active\r\n" +
    "a=mid:0\r\n" +
    "a=sctp-port:5000\r\n" +
    "a=max-message-size:65536\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:5377\r\n" +
    "a=ice-pwd:ab5d1f31727880b2875978\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 6A:1B:8B:C4:EF:AE:BF:48:9E:52:B6:B9:E7:86:5E:CC:1A:74:C6:1E:0E:5C:7C:89:66:EA:D5:D7:E7:23:FE:B7\r\n" +
    "a=setup:active\r\n" +
    "a=inactive\r\n" +
    "a=mid:1\r\n" +
    "a=rtcp:9 IN IP4 0.0.0.0\r\n" +
    "a=rtcp-mux\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n";

const activeAudioOfferMid2Sdp =
    "v=0\r\n" +
    "o=- 83392955 0 IN IP4 0.0.0.0\r\n" +
    "s=-\r\n" +
    "t=0 0\r\n" +
    "a=group:BUNDLE 0 2\r\n" +
    "a=extmap-allow-mixed\r\n" +
    "a=msid-semantic:WMS *\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:ddcb\r\n" +
    "a=ice-pwd:701e83d2d6de10d14b0eea\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 F8:C4:0C:11:3F:96:C8:6A:48:A6:88:42:28:86:2B:9D:77:11:E2:75:65:DE:81:F5:7E:CA:B5:AB:0A:6B:64:F1\r\n" +
    "a=setup:passive\r\n" +
    "a=mid:0\r\n" +
    "a=sctp-port:5000\r\n" +
    "a=max-message-size:65536\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=ice-ufrag:ddcb\r\n" +
    "a=ice-pwd:701e83d2d6de10d14b0eea\r\n" +
    "a=ice-options:trickle\r\n" +
    "a=fingerprint:sha-256 F8:C4:0C:11:3F:96:C8:6A:48:A6:88:42:28:86:2B:9D:77:11:E2:75:65:DE:81:F5:7E:CA:B5:AB:0A:6B:64:F1\r\n" +
    "a=setup:passive\r\n" +
    "a=sendrecv\r\n" +
    "a=mid:2\r\n" +
    "a=rtcp:9 IN IP4 0.0.0.0\r\n" +
    "a=rtcp-mux\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n";

const malformedAudioOfferSdp =
    "v=0\r\n" +
    "o=- 41053953 0 IN IP4 0.0.0.0\r\n" +
    "s=-\r\n" +
    "t=0 0\r\n" +
    "a=group:BUNDLE 0 1\r\n" +
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=mid:0\r\n" +
    "a=sctp-port:5000\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n" +
    "c=IN IP4 0.0.0.0\r\n" +
    "a=sendrecv\r\n" +
    "a=mid:1\r\n" +
    "a=rtpmap:8 PCMA/8000\r\n";

const candidateM0 = {
    sdpMLineIndex: 0,
    sdpMid: "0",
    candidate: "candidate:3054239307 1 udp 41820927 134.209.88.4 50878 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag 57EQ network-id 7 network-cost 900",
};

const candidateM1Stale = {
    sdpMLineIndex: 1,
    sdpMid: "1",
    candidate: "candidate:123456789 1 udp 41819903 10.0.0.10 20002 typ host generation 0 ufrag dead network-id 1",
};

test("WERIFT REPLAY: data-only offer with stale m-line candidate does not fail ingress", async () => {
    const harness = buildWeriftNegotiationHarness({ withAudioTrack: true, withDataChannel: true });
    try {
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: {
                    sdp: dataOnlyOfferSdp,
                    candidates: [candidateM0, candidateM1Stale],
                },
            }),
        );
        assert.match(String(harness.session.lastAnswerSdp || ""), /m=application/i);
    } finally {
        await harness.dispose();
    }
});

test("WERIFT REPLAY: baseline malformed offer reproduces werift parser rejection", async () => {
    const harness = buildWeriftNegotiationHarness({ withAudioTrack: true, withDataChannel: true });
    try {
        await assert.rejects(
            () =>
                harness.neg.applyOffer({
                    mode: "ring",
                    payload: { sdp: malformedAudioOfferSdp, candidates: [candidateM0] },
                }),
            /iceParams|media section/i,
        );
    } finally {
        await harness.dispose();
    }
});

test("WERIFT REPLAY: end-call remote offer then redial on reused session", async () => {
    const harness = buildWeriftNegotiationHarness({ withAudioTrack: true, withDataChannel: true });
    try {
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferSdp, candidates: [candidateM0] },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.endCall({
                mode: "remote",
                payload: { type: "offer", sdp: inactiveEndCallOfferSdp },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferSdp, candidates: [candidateM0] },
            }),
        );
    } finally {
        await harness.dispose();
    }
});

test("WERIFT REPLAY: ackEnd path then redial on same session", async () => {
    const harness = buildWeriftNegotiationHarness({ withAudioTrack: true, withDataChannel: true });
    try {
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferSdp, candidates: [candidateM0] },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.ackEnd({
                payload: { sdp: inactiveEndCallOfferSdp },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferSdp, candidates: [candidateM0] },
            }),
        );
    } finally {
        await harness.dispose();
    }
});

test("WERIFT REPLAY: decline/end then redial with audio mid=2 stays reusable", async () => {
    const harness = buildWeriftNegotiationHarness({ withAudioTrack: true, withDataChannel: true });
    try {
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferSdp, candidates: [candidateM0] },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.endCall({
                mode: "remote",
                payload: { type: "offer", sdp: inactiveEndCallOfferSdp },
            }),
        );
        await assert.doesNotReject(() =>
            harness.neg.applyOffer({
                mode: "ring",
                payload: { sdp: activeAudioOfferMid2Sdp, candidates: [candidateM0] },
            }),
        );
    } finally {
        await harness.dispose();
    }
});
