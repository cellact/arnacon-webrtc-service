const RTP_PT_PCMU = 0;
const RTP_PT_PCMA = 8;

function muLawToLinear(value) {
    const u = (~value) & 0xff;
    let sample = ((u & 0x0f) << 3) + 0x84;
    sample <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (0x84 - sample) : (sample - 0x84);
}

function linearToMuLaw(sample) {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) {
        exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function aLawToLinear(value) {
    const a = value ^ 0x55;
    let sample = (a & 0x0f) << 4;
    const segment = (a & 0x70) >> 4;
    if (segment === 0) {
        sample += 8;
    } else if (segment === 1) {
        sample += 0x108;
    } else {
        sample += 0x108;
        sample <<= segment - 1;
    }
    return (a & 0x80) ? sample : -sample;
}

function linearToALaw(sample) {
    const SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
    let mask;
    let pcm = sample >> 3;
    if (pcm >= 0) {
        mask = 0xd5;
    } else {
        mask = 0x55;
        pcm = -pcm - 1;
        if (pcm < 0) pcm = 0;
    }

    let segment = 0;
    while (segment < SEG_END.length && pcm > SEG_END[segment]) segment++;
    if (segment >= SEG_END.length) return 0x7f ^ mask;

    let encoded = segment << 4;
    if (segment < 2) encoded |= (pcm >> 1) & 0x0f;
    else encoded |= (pcm >> segment) & 0x0f;
    return encoded ^ mask;
}

function transcodeG711Payload(payload, fromPt, toPt) {
    if (!payload || fromPt === toPt) return payload;
    if (!((fromPt === RTP_PT_PCMU && toPt === RTP_PT_PCMA) || (fromPt === RTP_PT_PCMA && toPt === RTP_PT_PCMU))) {
        return payload;
    }

    const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const converted = Buffer.allocUnsafe(source.length);
    if (fromPt === RTP_PT_PCMU) {
        for (let i = 0; i < source.length; i++) {
            converted[i] = linearToALaw(muLawToLinear(source[i]));
        }
    } else {
        for (let i = 0; i < source.length; i++) {
            converted[i] = linearToMuLaw(aLawToLinear(source[i]));
        }
    }
    return converted;
}

module.exports = {
    RTP_PT_PCMU,
    RTP_PT_PCMA,
    muLawToLinear,
    linearToMuLaw,
    aLawToLinear,
    linearToALaw,
    transcodeG711Payload,
};
