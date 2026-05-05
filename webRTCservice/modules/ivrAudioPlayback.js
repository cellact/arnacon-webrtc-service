"use strict";

const { spawn, spawnSync } = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { RtpHeader, RtpPacket } = require("werift");

const FRAME_SIZE_BYTES_G711_20MS = 160;
const RTP_TS_STEP_G711_20MS = 160;
const RTP_PT_PCMU = 0;
const RTP_PT_PCMA = 8;

function payloadToCodec(payloadType) {
    if (Number(payloadType) === RTP_PT_PCMU) {
        return { payloadType: RTP_PT_PCMU, ffmpegCodec: "pcm_mulaw", ffmpegFormat: "mulaw", silenceByte: 0xff, label: "PCMU" };
    }
    return { payloadType: RTP_PT_PCMA, ffmpegCodec: "pcm_alaw", ffmpegFormat: "alaw", silenceByte: 0xd5, label: "PCMA" };
}

function createIvrAudioPlayback({
    sessions,
    logger = console,
    ttsBinary = process.env.IVR_TTS_BIN || "espeak-ng",
    ffmpegBinary = process.env.IVR_FFMPEG_BIN || "ffmpeg",
    demoAudioDir = process.env.IVR_DEMO_AUDIO_DIR || path.resolve(__dirname, "../../demoAudio"),
}) {
    const playbackBySession = new Map();
    const timelineBySession = new Map();
    const inboundTemplateBySession = new Map();
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
                const stderrTail = String(stderr || "").slice(-2000);
                reject(new Error(`${label} failed with code ${code}: ${stderrTail}`));
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

    function cloneHeaderForTemplate(header = {}) {
        return {
            ...header,
            csrc: Array.isArray(header.csrc) ? [...header.csrc] : [],
            extensions: Array.isArray(header.extensions)
                ? header.extensions.map((item) => ({
                    id: item.id,
                    payload: Buffer.isBuffer(item.payload) ? Buffer.from(item.payload) : Buffer.from(item.payload || []),
                }))
                : [],
        };
    }

    function buildPacketFromState(state, payload, templateHeader = null) {
        const baseHeader = templateHeader ? cloneHeaderForTemplate(templateHeader) : {};
        const extensions = Array.isArray(baseHeader.extensions) ? baseHeader.extensions : [];
        const csrc = Array.isArray(baseHeader.csrc) ? baseHeader.csrc : [];
        const headerProps = {
            ...baseHeader,
            version: Number.isFinite(baseHeader.version) ? baseHeader.version : 2,
            marker: false,
            padding: false,
            extension: extensions.length > 0,
            csrcLength: csrc.length,
            csrc,
            extensions,
            payloadType: state.payloadType,
            sequenceNumber: state.sequenceNumber,
            timestamp: state.timestamp,
            ssrc: state.ssrc,
        };
        if (typeof RtpHeader === "function" && typeof RtpPacket === "function") {
            return new RtpPacket(new RtpHeader(headerProps), payload);
        }
        return {
            header: headerProps,
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

    function deriveNegotiatedPayloadType(session) {
        const forced = Number(process.env.IVR_FORCE_PT || "");
        if (Number.isFinite(forced) && (forced === RTP_PT_PCMA || forced === RTP_PT_PCMU)) {
            return forced;
        }
        const sdp = String(session?.ivrLastAnswerSdp || session?.peerConnection?.localDescription?.sdp || "");
        if (!sdp) return RTP_PT_PCMA;
        const audioSection = sdp.match(/m=audio[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/m)?.[0] || "";
        if (!audioSection) return RTP_PT_PCMA;
        const mLine = audioSection.match(/^m=audio[^\r\n]*/m)?.[0] || "";
        const payloads = mLine
            .split(/\s+/)
            .slice(3)
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v));
        const first = payloads[0];
        if (first === RTP_PT_PCMU || first === RTP_PT_PCMA) return first;
        if (payloads.includes(RTP_PT_PCMU)) return RTP_PT_PCMU;
        if (payloads.includes(RTP_PT_PCMA)) return RTP_PT_PCMA;
        return RTP_PT_PCMA;
    }

    function getOrCreateTimeline(sessionId) {
        const session = sessions.get(sessionId);
        const negotiatedSsrc = deriveNegotiatedSsrc(session);
        const negotiatedPt = deriveNegotiatedPayloadType(session);
        const existing = timelineBySession.get(sessionId);
        if (existing) {
            if (Number.isFinite(negotiatedSsrc) && negotiatedSsrc > 0 && existing.ssrc !== negotiatedSsrc) {
                logger.log(`[${sessionId}] IVR RTP timeline SSRC update ${existing.ssrc} -> ${negotiatedSsrc}`);
                existing.ssrc = negotiatedSsrc >>> 0;
                existing.identityLogged = false;
            }
            if (Number.isFinite(negotiatedPt) && existing.payloadType !== negotiatedPt) {
                logger.log(`[${sessionId}] IVR RTP timeline PT update ${existing.payloadType} -> ${negotiatedPt}`);
                existing.payloadType = negotiatedPt;
                existing.identityLogged = false;
            }
            return existing;
        }

        const initialSeq = Math.floor(Math.random() * 65535);
        const initialTs = Math.floor(Math.random() * 0xffffffff);
        const initialPt = negotiatedPt;

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
            playbackStateLogged: false,
            timeline,
        };
    }

    function logNegotiatedIdentity(sessionId, timeline) {
        if (!timeline || timeline.identityLogged) return;
        const session = sessions.get(sessionId);
        const senderTrackSsrc = Number(session?.localAudioTrack?.ssrc);
        const sdpSsrc = parseAudioSsrcFromLocalDescription(session);
        const answerSdpSsrc = parseAudioSsrcFromSdp(session?.ivrLastAnswerSdp);
        const codecInfo = payloadToCodec(timeline.payloadType);
        logger.log(
            `[${sessionId}] IVR RTP identity codec=${codecInfo.label} pt=${timeline.payloadType} ssrc=${timeline.ssrc} ` +
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
            inboundTemplateBySession.delete(sessionId);
        }
        logger.log(`[${sessionId}] IVR audio stopped reason=${reason}`);
    }

    async function textToG711Frames(sessionId, text, payloadType) {
        const nonce = crypto.randomUUID();
        const wavFile = path.join(os.tmpdir(), `ivr-${sessionId}-${nonce}.wav`);
        const codec = payloadToCodec(payloadType);
        const outFile = path.join(os.tmpdir(), `ivr-${sessionId}-${nonce}.${codec.ffmpegFormat}`);

        await runProcess(
            ttsBinary,
            ["-w", wavFile, String(text || "")],
            "TTS synthesis",
        );
        await runProcess(
            ffmpegBinary,
            ["-y", "-i", wavFile, "-ar", "8000", "-ac", "1", "-c:a", codec.ffmpegCodec, "-f", codec.ffmpegFormat, outFile],
            "Audio transcode",
        );
        const raw = await fs.readFile(outFile);
        return {
            raw,
            tempFiles: [wavFile, outFile],
        };
    }

    async function mediaFileToG711Frames(sessionId, inputFilePath, payloadType) {
        const nonce = crypto.randomUUID();
        const codec = payloadToCodec(payloadType);
        const outFile = path.join(os.tmpdir(), `ivr-${sessionId}-${nonce}.${codec.ffmpegFormat}`);
        await runProcess(
            ffmpegBinary,
            ["-y", "-i", String(inputFilePath), "-ar", "8000", "-ac", "1", "-c:a", codec.ffmpegCodec, "-f", codec.ffmpegFormat, outFile],
            "Audio file transcode",
        );
        const raw = await fs.readFile(outFile);
        return {
            raw,
            tempFiles: [outFile],
        };
    }

    function resolveAudioFilePath(fileNameOrPath) {
        const raw = String(fileNameOrPath || "").trim();
        if (!raw) {
            return {
                resolvedPath: "",
                candidatePaths: [],
            };
        }

        const candidatePaths = [];
        if (path.isAbsolute(raw)) {
            candidatePaths.push(raw);
        } else {
            if (demoAudioDir) candidatePaths.push(path.join(demoAudioDir, raw));
            candidatePaths.push(path.resolve(__dirname, "../../demoAudio", raw));
            candidatePaths.push(path.resolve(process.cwd(), "demoAudio", raw));
            candidatePaths.push(path.resolve(process.cwd(), raw));
        }

        for (const candidate of candidatePaths) {
            if (fsSync.existsSync(candidate)) {
                return {
                    resolvedPath: candidate,
                    candidatePaths,
                };
            }
        }

        return {
            resolvedPath: candidatePaths[0] || "",
            candidatePaths,
        };
    }

    async function assertReadableAudioFile(sessionId, resolvedPath, candidatePaths) {
        if (!resolvedPath) {
            logger.error(`[${sessionId}] IVR audio file path resolution failed candidates=${candidatePaths.join(", ")}`);
            return false;
        }
        try {
            await fs.access(resolvedPath);
            return true;
        } catch (err) {
            logger.error(
                `[${sessionId}] IVR audio file not accessible path=${resolvedPath} err=${err.code || err.message} ` +
                `candidates=${candidatePaths.join(", ")}`
            );
            return false;
        }
    }

    function getPlaybackDiagnostics(session) {
        const audioT = session?.peerConnection?.getTransceivers?.().find((t) => t.kind === "audio");
        const direction = audioT?.direction || "n/a";
        const currentDirection = audioT?.currentDirection || "n/a";
        return {
            direction,
            currentDirection,
        };
    }

    function ensurePlaybackReady(sessionId, session, stateLabel, state) {
        const { direction, currentDirection } = getPlaybackDiagnostics(session);
        const template = inboundTemplateBySession.get(sessionId)?.header || null;
        const templateState = template ? "active" : "none";
        if (!state.playbackStateLogged) {
            state.playbackStateLogged = true;
            logger.log(
                `[${sessionId}] IVR playback state source=${stateLabel} phase=${session?.phase || "n/a"} ` +
                `audioDir=${direction} currentAudioDir=${currentDirection} inboundTemplate=${templateState}`
            );
        }
        if (session?.phase !== "in-call") {
            logger.warn(`[${sessionId}] IVR playback blocked source=${stateLabel} phase=${session?.phase || "n/a"}`);
            return {
                ready: false,
                template: null,
            };
        }
        return {
            ready: true,
            template,
        };
    }

    function splitFrames(raw, payloadType) {
        const codec = payloadToCodec(payloadType);
        const out = [];
        for (let i = 0; i < raw.length; i += FRAME_SIZE_BYTES_G711_20MS) {
            const chunk = raw.subarray(i, i + FRAME_SIZE_BYTES_G711_20MS);
            if (chunk.length < FRAME_SIZE_BYTES_G711_20MS) {
                const padded = Buffer.alloc(FRAME_SIZE_BYTES_G711_20MS, codec.silenceByte);
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
        const { raw, tempFiles } = await textToG711Frames(sessionId, text, timeline.payloadType);
        state.tempFiles = tempFiles;
        const frames = splitFrames(raw, timeline.payloadType);
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
            const playbackReady = ensurePlaybackReady(sessionId, session, "tts", state);
            if (!playbackReady.ready) return;
            if (idx >= frames.length) {
                stopSessionPlayback(sessionId, "completed").catch(() => {});
                return;
            }
            try {
                if (session.localAudioTrack && session.localAudioTrack.ssrc !== timeline.ssrc) {
                    logger.warn(
                        `[${sessionId}] IVR localAudioTrack SSRC drift detected ` +
                        `${session.localAudioTrack.ssrc} -> ${timeline.ssrc}`
                    );
                    session.localAudioTrack.ssrc = timeline.ssrc;
                }
                const payload = frames[idx++];
                const packet = buildPacketFromState(timeline, payload, playbackReady.template);
                packet.header.marker = idx === 1;
                if (state.debugPacketsLogged < 5) {
                    state.debugPacketsLogged += 1;
                    logger.log(
                        `[${sessionId}] IVR RTP packet#${state.debugPacketsLogged} ` +
                        `pt=${packet.header.payloadType} ssrc=${packet.header.ssrc} ` +
                        `seq=${packet.header.sequenceNumber} ts=${packet.header.timestamp} ` +
                        `trackSsrc=${session.localAudioTrack?.ssrc ?? "n/a"} payloadLen=${payload.length}`
                    );
                }
                session.localAudioTrack.writeRtp(packet);
                timeline.sequenceNumber = (timeline.sequenceNumber + 1) & 0xffff;
                timeline.timestamp = (timeline.timestamp + RTP_TS_STEP_G711_20MS) >>> 0;
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

    async function playFile(sessionId, fileNameOrPath, { interrupt = true } = {}) {
        validateDependencies();
        const session = sessions.get(sessionId);
        if (!session?.localAudioTrack) {
            logger.warn(`[${sessionId}] IVR audio file skipped: localAudioTrack missing`);
            return false;
        }

        const { resolvedPath, candidatePaths } = resolveAudioFilePath(fileNameOrPath);
        if (!resolvedPath) {
            logger.warn(`[${sessionId}] IVR audio file skipped: missing path`);
            return false;
        }
        const canReadFile = await assertReadableAudioFile(sessionId, resolvedPath, candidatePaths);
        if (!canReadFile) return false;

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

        let rawAndFiles;
        try {
            rawAndFiles = await mediaFileToG711Frames(sessionId, resolvedPath, timeline.payloadType);
        } catch (err) {
            playbackBySession.delete(sessionId);
            logger.error(`[${sessionId}] IVR audio file transcode failed path=${resolvedPath} err=${err.message}`);
            return false;
        }

        const { raw, tempFiles } = rawAndFiles;
        state.tempFiles = tempFiles;
        const frames = splitFrames(raw, timeline.payloadType);
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
            const playbackReady = ensurePlaybackReady(sessionId, session, "file", state);
            if (!playbackReady.ready) return;
            if (idx >= frames.length) {
                stopSessionPlayback(sessionId, "completed").catch(() => {});
                return;
            }
            try {
                if (session.localAudioTrack && session.localAudioTrack.ssrc !== timeline.ssrc) {
                    logger.warn(
                        `[${sessionId}] IVR localAudioTrack SSRC drift detected ` +
                        `${session.localAudioTrack.ssrc} -> ${timeline.ssrc}`
                    );
                    session.localAudioTrack.ssrc = timeline.ssrc;
                }
                const payload = frames[idx++];
                const packet = buildPacketFromState(timeline, payload, playbackReady.template);
                packet.header.marker = idx === 1;
                if (state.debugPacketsLogged < 5) {
                    state.debugPacketsLogged += 1;
                    logger.log(
                        `[${sessionId}] IVR FILE RTP packet#${state.debugPacketsLogged} ` +
                        `pt=${packet.header.payloadType} ssrc=${packet.header.ssrc} ` +
                        `seq=${packet.header.sequenceNumber} ts=${packet.header.timestamp} ` +
                        `trackSsrc=${session.localAudioTrack?.ssrc ?? "n/a"} payloadLen=${payload.length}`
                    );
                }
                session.localAudioTrack.writeRtp(packet);
                timeline.sequenceNumber = (timeline.sequenceNumber + 1) & 0xffff;
                timeline.timestamp = (timeline.timestamp + RTP_TS_STEP_G711_20MS) >>> 0;
            } catch (err) {
                logger.error(
                    `[${sessionId}] IVR audio file write failed: ${err.message} ` +
                    `pt=${timeline.payloadType} ssrc=${timeline.ssrc} seq=${timeline.sequenceNumber} ts=${timeline.timestamp}`
                );
                stopSessionPlayback(sessionId, "write-failed").catch(() => {});
            }
        }, 20);
        logger.log(`[${sessionId}] IVR audio file playback started file=${resolvedPath} frames=${frames.length}`);
        return true;
    }

    function onInboundRtp(sessionId, rtp) {
        if (!sessionId || !rtp?.header) return;
        inboundTemplateBySession.set(sessionId, {
            header: cloneHeaderForTemplate(rtp.header),
            updatedAt: Date.now(),
        });
    }

    async function stopAll() {
        const ids = Array.from(playbackBySession.keys());
        for (const sessionId of ids) {
            await stopSessionPlayback(sessionId, "shutdown");
        }
    }

    return {
        playText,
        playFile,
        stopSessionPlayback,
        onInboundRtp,
        stopAll,
        validateDependencies,
    };
}

module.exports = {
    createIvrAudioPlayback,
};
