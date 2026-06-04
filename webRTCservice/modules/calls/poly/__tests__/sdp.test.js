const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
    normalizeEndCallOfferSdp,
    alignEndCallAnswerSdp,
    isInactiveOffer,
    audioDirection,
} = require("../negotiation/sdp");

test("inactive audio stays reusable: m=audio 0 -> m=audio 9 in generated offer", () => {
    const offer = "v=0\r\na=group:BUNDLE 0\r\nm=audio 0 UDP/TLS/RTP/SAVPF\r\na=mid:0\r\na=inactive\r\n";
    const out = normalizeEndCallOfferSdp(offer);
    assert.match(out, /m=audio 9 /);
    assert.doesNotMatch(out, /m=audio 0 /);
});

test("end-call answer aligns bundle + mid from the offer, keeps inactive audio reusable", () => {
    const offer = "v=0\r\na=group:BUNDLE 1\r\nm=audio 0 UDP\r\na=mid:1\r\na=inactive\r\n";
    const answer = "v=0\r\nm=audio 0 UDP\r\na=mid:9\r\na=inactive\r\n";
    const out = alignEndCallAnswerSdp(answer, offer);
    assert.match(out, /a=group:BUNDLE 1/);
    assert.match(out, /a=mid:1/);
    assert.match(out, /m=audio 9 /);
});

test("isInactiveOffer: inactive audio is true, sendrecv is false, no audio is true", () => {
    assert.equal(isInactiveOffer("v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=inactive\r\n"), true);
    assert.equal(isInactiveOffer("v=0\r\nm=audio 9 UDP\r\na=mid:0\r\na=sendrecv\r\n"), false);
    assert.equal(isInactiveOffer("v=0\r\nm=application 9 DTLS\r\n"), true);
});

test("audioDirection extracts the audio media direction", () => {
    assert.equal(audioDirection("m=audio 9 UDP\r\na=sendrecv\r\n"), "sendrecv");
    assert.equal(audioDirection("m=audio 9 UDP\r\na=inactive\r\n"), "inactive");
    assert.equal(audioDirection("m=application 9 DTLS\r\n"), null);
});
