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
    const seedBySession = new Map();
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

    function getOrCreateState(sessionId) {
        const existing = playbackBySession.get(sessionId);
        if (existing) return existing;

        const seed = seedBySession.get(sessionId) || null;
        const initialSeq = Number(seed?.header?.sequenceNumber ?? Math.floor(Math.random() * 65535));
        const initialTs = Number(seed?.header?.timestamp ?? Math.floor(Math.random() * 0xffffffff));
        const initialSsrc = Number(seed?.header?.ssrc ?? Math.floor(Math.random() * 0xffffffff));
        const initialPt = Number(seed?.header?.payloadType ?? RTP_PT_PCMA);

        const created = {
            timer: null,
            stopped: false,
            tempFiles: [],
            sequenceNumber: initialSeq,
            timestamp: initialTs,
            ssrc: initialSsrc,
            payloadType: initialPt,
        };
        playbackBySession.set(sessionId, created);
        return created;
    }

    async function cleanupTempFiles(files = []) {
        await Promise.all(files.map(async (p) => {
            try { await fs.unlink(p); } catch (_) {}
        }));
    }

    async function stopSessionPlayback(sessionId, reason = "stop") {
        const state = playbackBySession.get(sessionId);
        if (!state) return;
        state.stopped = true;
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
        playbackBySession.delete(sessionId);
        await cleanupTempFiles(state.tempFiles || []);
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

        const state = getOrCreateState(sessionId);
        const { raw, tempFiles } = await textToPcmaFrames(sessionId, text);
        state.tempFiles = tempFiles;
        const frames = splitFrames(raw);
        if (!frames.length) {
            await cleanupTempFiles(tempFiles);
            return false;
        }

        let idx = 0;
        session.localAudioTrack.onSourceChanged.execute({
            sequenceNumber: state.sequenceNumber,
            timestamp: state.timestamp,
        });
        state.timer = setInterval(() => {
            if (state.stopped || (!session.mediaRelayActive && !session.ivr?.active)) return;
            if (idx >= frames.length) {
                stopSessionPlayback(sessionId, "completed").catch(() => {});
                return;
            }
            try {
                const payload = frames[idx++];
                const packet = buildPacketFromState(state, payload);
                session.localAudioTrack.writeRtp(packet);
                state.sequenceNumber = (state.sequenceNumber + 1) & 0xffff;
                state.timestamp = (state.timestamp + RTP_TS_STEP_PCMA_20MS) >>> 0;
            } catch (err) {
                logger.error(`[${sessionId}] IVR audio write failed: ${err.message}`);
                stopSessionPlayback(sessionId, "write-failed").catch(() => {});
            }
        }, 20);
        logger.log(`[${sessionId}] IVR audio playback started chars=${String(text || "").length} frames=${frames.length}`);
        return true;
    }

    function onInboundRtp(sessionId, rtp) {
        if (!rtp || !rtp.header) return;
        seedBySession.set(sessionId, rtp);
    }

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
