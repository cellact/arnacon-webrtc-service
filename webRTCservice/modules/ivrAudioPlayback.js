"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const FRAME_SIZE_BYTES_PCMA_20MS = 160;
const RTP_TS_STEP_PCMA_20MS = 160;
const RTP_PT_PCMA = 8;

function createIvrAudioPlayback({
    sessions,
    logger = console,
    ttsBinary = process.env.IVR_TTS_BIN || "espeak-ng",
    ffmpegBinary = process.env.IVR_FFMPEG_BIN || "ffmpeg",
}) {
    const playbackBySession = new Map();
    const timelineBySession = new Map();
    let dependencyCheckDone = false;

    function runProcess(bin, args, label) {
        return new Promise((resolve, reject) => {
            const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
            let stderr = "";
            proc.stderr?.on("data", (chunk) => {
                stderr += chunk.toString("utf8");
            });
            proc.on("error", reject);
            proc.on("close", (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`${label} failed with code ${code}: ${stderr.slice(0, 400)}`));
            });
        });
    }

    function validateDependencies() {
        if (dependencyCheckDone) return;
        dependencyCheckDone = true;

        const ttsCheck = spawnSync(ttsBinary, ["--version"], { stdio: "pipe" });
        if (ttsCheck.status !== 0) {
            logger.error(`[IVR-AUDIO] Missing/invalid TTS binary: ${ttsBinary}`);
        } else {
            logger.log(`[IVR-AUDIO] TTS binary OK: ${ttsBinary}`);
        }

        const ffmpegCheck = spawnSync(ffmpegBinary, ["-version"], { stdio: "pipe" });
        if (ffmpegCheck.status !== 0) {
            logger.error(`[IVR-AUDIO] Missing/invalid ffmpeg binary: ${ffmpegBinary}`);
        } else {
            logger.log(`[IVR-AUDIO] ffmpeg binary OK: ${ffmpegBinary}`);
        }
    }

    function buildPacketFromState(state, payload) {
        return {
            header: {
                version: 2,
                marker: false,
                padding: false,
                extension: false,
                csrcLength: 0,
                csrc: [],
                extensions: [],
                payloadType: state.payloadType,
                sequenceNumber: state.sequenceNumber,
                timestamp: state.timestamp,
                ssrc: state.ssrc,
            },
            payload,
        };
    }

    function parseAudioSsrcFromLocalDescription(session) {
        const sdp = String(session?.peerConnection?.localDescription?.sdp || "");
        if (!sdp) return null;
        const audioMatch = sdp.match(/m=audio[\s\S]*?(?=\r?\nm=|$)/m);
        if (!audioMatch) return null;
        const ssrcMatch = audioMatch[0].match(/a=ssrc:(\d+)/);
        if (!ssrcMatch) return null;
        const parsed = Number(ssrcMatch[1]);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed >>> 0;
    }

    function parseAudioSsrcFromSdp(sdpText) {
        const sdp = String(sdpText || "");
        if (!sdp) return null;
        const ssrcMatch = sdp.match(/a=ssrc:(\d+)/);
        if (!ssrcMatch) return null;
        const parsed = Number(ssrcMatch[1]);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed >>> 0;
    }

    function deriveNegotiatedSsrc(session) {
        const fromSession = Number(session?.ivrNegotiatedSsrc);
        if (Number.isFinite(fromSession) && fromSession > 0) return fromSession >>> 0;
        const fromLastAnswerSdp = parseAudioSsrcFromSdp(session?.ivrLastAnswerSdp);
        if (Number.isFinite(fromLastAnswerSdp) && fromLastAnswerSdp > 0) return fromLastAnswerSdp >>> 0;
        const senderSsrc = Number(session?.localAudioTrack?.ssrc);
        if (Number.isFinite(senderSsrc) && senderSsrc > 0) return senderSsrc >>> 0;
        const fromSdp = parseAudioSsrcFromLocalDescription(session);
        if (Number.isFinite(fromSdp) && fromSdp > 0) return fromSdp >>> 0;
        return Math.floor(Math.random() * 0xffffffff);
    }

    function getOrCreateTimeline(sessionId) {
        const session = sessions.get(sessionId);
        const negotiatedSsrc = deriveNegotiatedSsrc(session);
        const existing = timelineBySession.get(sessionId);
        if (existing) {
            if (Number.isFinite(negotiatedSsrc) && negotiatedSsrc > 0 && existing.ssrc !== negotiatedSsrc) {
                logger.log(`[${sessionId}] IVR RTP timeline SSRC update ${existing.ssrc} -> ${negotiatedSsrc}`);
                existing.ssrc = negotiatedSsrc >>> 0;
                existing.identityLogged = false;
            }
            return existing;
        }

        const initialSeq = Math.floor(Math.random() * 65535);
        const initialTs = Math.floor(Math.random() * 0xffffffff);
        // Injected IVR audio is encoded as PCMA (A-law), so force PT=8.
        // Do not inherit inbound caller PT (often Opus/111), which causes silent playback.
        const initialPt = RTP_PT_PCMA;

        const timeline = {
            sequenceNumber: initialSeq,
            timestamp: initialTs,
            ssrc: negotiatedSsrc,
            payloadType: initialPt,
            identityLogged: false,
        };
        timelineBySession.set(sessionId, timeline);
        return timeline;
    }

    function buildPlaybackState(timeline) {
        return {
            timer: null,
            stopped: false,
            tempFiles: [],
            debugPacketsLogged: 0,
            timeline,
        };
    }

    function logNegotiatedIdentity(sessionId, timeline) {
        if (!timeline || timeline.identityLogged) return;
        const session = sessions.get(sessionId);
        const senderTrackSsrc = Number(session?.localAudioTrack?.ssrc);
        const sdpSsrc = parseAudioSsrcFromLocalDescription(session);
        const answerSdpSsrc = parseAudioSsrcFromSdp(session?.ivrLastAnswerSdp);
        logger.log(
            `[${sessionId}] IVR RTP identity pt=${timeline.payloadType} ssrc=${timeline.ssrc} ` +
            `trackSsrc=${Number.isFinite(senderTrackSsrc) ? senderTrackSsrc : "n/a"} ` +
            `sdpSsrc=${Number.isFinite(sdpSsrc) ? sdpSsrc : "n/a"} ` +
            `answerSdpSsrc=${Number.isFinite(answerSdpSsrc) ? answerSdpSsrc : "n/a"}`
        );
        timeline.identityLogged = true;
    }

    async function cleanupTempFiles(files = []) {
        await Promise.all(files.map(async (p) => {
            try { await fs.unlink(p); } catch (_) {}
        }));
    }

    async function stopSessionPlayback(sessionId, reason = "stop") {
        const state = playbackBySession.get(sessionId);
        if (state) {
            state.stopped = true;
            if (state.timer) {
                clearInterval(state.timer);
                state.timer = null;
            }
            playbackBySession.delete(sessionId);
            await cleanupTempFiles(state.tempFiles || []);
        }
        const shouldClearTimeline =
            reason === "session-destroyed" ||
            reason === "client-initiated" ||
            reason === "shutdown" ||
            String(reason || "").startsWith("ivr-stop:");
        if (shouldClearTimeline) {
            timelineBySession.delete(sessionId);
        }
        logger.log(`[${sessionId}] IVR audio stopped reason=${reason}`);
    }

    async function textToPcmaFrames(sessionId, text) {
        const nonce = crypto.randomUUID();
        const wavFile = path.join(os.tmpdir(), `ivr-${sessionId}-${nonce}.wav`);
        const alawFile = path.join(os.tmpdir(), `ivr-${sessionId}-${nonce}.alaw`);

        await runProcess(
            ttsBinary,
            ["-w", wavFile, String(text || "")],
            "TTS synthesis",
        );
        await runProcess(
            ffmpegBinary,
            ["-y", "-i", wavFile, "-ar", "8000", "-ac", "1", "-c:a", "pcm_alaw", "-f", "alaw", alawFile],
            "Audio transcode",
        );
        const raw = await fs.readFile(alawFile);
        return {
            raw,
            tempFiles: [wavFile, alawFile],
        };
    }

    function splitFrames(raw) {
        const out = [];
        for (let i = 0; i < raw.length; i += FRAME_SIZE_BYTES_PCMA_20MS) {
            const chunk = raw.subarray(i, i + FRAME_SIZE_BYTES_PCMA_20MS);
            if (chunk.length < FRAME_SIZE_BYTES_PCMA_20MS) {
                const padded = Buffer.alloc(FRAME_SIZE_BYTES_PCMA_20MS, 0xd5);
                chunk.copy(padded);
                out.push(padded);
            } else {
                out.push(chunk);
            }
        }
        return out;
    }

    async function playText(sessionId, text, { interrupt = true } = {}) {
        validateDependencies();
        const session = sessions.get(sessionId);
        if (!session?.localAudioTrack) {
            logger.warn(`[${sessionId}] IVR audio skipped: localAudioTrack missing`);
            return false;
        }

        if (interrupt) {
            await stopSessionPlayback(sessionId, "interrupt");
        }

        const timeline = getOrCreateTimeline(sessionId);
        logNegotiatedIdentity(sessionId, timeline);
        try {
            if (session.localAudioTrack) {
                session.localAudioTrack.ssrc = timeline.ssrc;
            }
        } catch (_) {}
        const state = buildPlaybackState(timeline);
        playbackBySession.set(sessionId, state);
        const { raw, tempFiles } = await textToPcmaFrames(sessionId, text);
        state.tempFiles = tempFiles;
        const frames = splitFrames(raw);
        if (!frames.length) {
            await cleanupTempFiles(tempFiles);
            return false;
        }

        let idx = 0;
        session.localAudioTrack.onSourceChanged.execute({
            sequenceNumber: timeline.sequenceNumber,
            timestamp: timeline.timestamp,
        });
        state.timer = setInterval(() => {
            if (state.stopped || (!session.mediaRelayActive && !session.ivr?.active)) return;
            if (idx >= frames.length) {
                stopSessionPlayback(sessionId, "completed").catch(() => {});
                return;
            }
            try {
                const payload = frames[idx++];
                const packet = buildPacketFromState(timeline, payload);
                packet.header.marker = idx === 1;
                if (state.debugPacketsLogged < 5) {
                    state.debugPacketsLogged += 1;
                    logger.log(
                        `[${sessionId}] IVR RTP packet#${state.debugPacketsLogged} ` +
                        `pt=${packet.header.payloadType} ssrc=${packet.header.ssrc} ` +
                        `seq=${packet.header.sequenceNumber} ts=${packet.header.timestamp} payloadLen=${payload.length}`
                    );
                }
                session.localAudioTrack.writeRtp(packet);
                timeline.sequenceNumber = (timeline.sequenceNumber + 1) & 0xffff;
                timeline.timestamp = (timeline.timestamp + RTP_TS_STEP_PCMA_20MS) >>> 0;
            } catch (err) {
                logger.error(
                    `[${sessionId}] IVR audio write failed: ${err.message} ` +
                    `pt=${timeline.payloadType} ssrc=${timeline.ssrc} seq=${timeline.sequenceNumber} ts=${timeline.timestamp}`
                );
                stopSessionPlayback(sessionId, "write-failed").catch(() => {});
            }
        }, 20);
        logger.log(`[${sessionId}] IVR audio playback started chars=${String(text || "").length} frames=${frames.length}`);
        return true;
    }

    function onInboundRtp() {}

    async function stopAll() {
        const ids = Array.from(playbackBySession.keys());
        for (const sessionId of ids) {
            await stopSessionPlayback(sessionId, "shutdown");
        }
    }

    return {
        playText,
        stopSessionPlayback,
        onInboundRtp,
        stopAll,
        validateDependencies,
    };
}

module.exports = {
    createIvrAudioPlayback,
};
