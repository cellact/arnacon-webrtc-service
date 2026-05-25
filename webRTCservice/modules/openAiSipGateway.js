"use strict";

const crypto = require("crypto");
const dgram = require("dgram");
const http = require("http");
const { RtpHeader, RtpPacket } = require("werift");

const CRLF = "\r\n";
const DEFAULT_INVITE_TIMEOUT_MS = 30000;
const DEFAULT_RTP_PAYLOAD_TYPE = 0; // PCMU. OpenAI SIP ingress is stricter with mixed G.711 offers.

function randomToken(bytes = 8) {
    return crypto.randomBytes(bytes).toString("hex");
}

function sanitizeSipUser(value, fallback = "unknown") {
    const raw = String(value || "").trim();
    const user = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
    return (user.replace(/^sip:/i, "").replace(/[^A-Za-z0-9_.!~*'()+-]/g, "") || fallback);
}

function sipMessage(startLine, headers, body = "") {
    const content = String(body || "");
    const lines = [startLine];
    for (const [name, value] of headers) {
        if (value === undefined || value === null || value === "") continue;
        lines.push(`${name}: ${value}`);
    }
    lines.push(`Content-Length: ${Buffer.byteLength(content)}`);
    return `${lines.join(CRLF)}${CRLF}${CRLF}${content}`;
}

function splitSipPayload(raw) {
    const text = String(raw || "");
    const splitAt = text.indexOf(`${CRLF}${CRLF}`);
    if (splitAt < 0) return { head: text, body: "" };
    return {
        head: text.slice(0, splitAt),
        body: text.slice(splitAt + 4),
    };
}

function parseSipMessage(raw) {
    const { head, body } = splitSipPayload(raw);
    const lines = head.split(/\r\n/).filter(Boolean);
    const startLine = lines.shift() || "";
    const headers = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (!headers[name]) headers[name] = value;
        else headers[name] = `${headers[name]}, ${value}`;
    }
    return { startLine, headers, body };
}

function getStatusCode(startLine) {
    const match = String(startLine || "").match(/^SIP\/2\.0\s+(\d{3})\b/);
    return match ? Number(match[1]) : null;
}

function getMethod(startLine) {
    const match = String(startLine || "").match(/^([A-Z]+)\s+sip:/);
    return match ? match[1] : null;
}

function tagFromToHeader(value) {
    const match = String(value || "").match(/;\s*tag=([^;\s]+)/i);
    return match ? match[1] : "";
}

function parseSdpRemote(sdp) {
    const lines = String(sdp || "").split(/\r\n|\n/);
    let ip = "";
    let port = 0;
    let payloadType = DEFAULT_RTP_PAYLOAD_TYPE;

    for (const line of lines) {
        const c = line.match(/^c=IN IP4\s+(.+)$/i);
        if (c) ip = c[1].trim();

        const m = line.match(/^m=audio\s+(\d+)\s+RTP\/AVP\s+(.+)$/i);
        if (m) {
            port = Number(m[1]);
            const payloads = m[2].trim().split(/\s+/).map(Number).filter(Number.isFinite);
            if (payloads.includes(DEFAULT_RTP_PAYLOAD_TYPE)) payloadType = DEFAULT_RTP_PAYLOAD_TYPE;
            else if (payloads.length) payloadType = payloads[0];
        }
    }

    if (!ip || !port) return null;
    return { ip, port, payloadType };
}

function buildPlainRtpSdp({ mediaIp, mediaPort, sessionId, payloadType = DEFAULT_RTP_PAYLOAD_TYPE }) {
    const rtpmap = payloadType === 0 ? "PCMU/8000" : "PCMA/8000";
    return [
        "v=0",
        `o=arnacon ${Date.now()} 1 IN IP4 ${mediaIp}`,
        "s=Arnacon OpenAI SIP Bridge",
        `c=IN IP4 ${mediaIp}`,
        "t=0 0",
        `m=audio ${mediaPort} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${rtpmap}`,
        "a=ptime:20",
        "a=sendrecv",
        "",
    ].join(CRLF);
}

function cloneRtpHeaderForPlainRtp(header, payloadType) {
    return {
        ...header,
        padding: false,
        extension: false,
        extensions: [],
        extensionProfile: 0,
        csrc: [],
        csrcLength: 0,
        payloadType,
    };
}

function serializePlainRtp(packet, payloadType) {
    if (Buffer.isBuffer(packet)) return packet;
    if (!packet || !packet.header || !packet.payload) return null;

    const header = cloneRtpHeaderForPlainRtp(packet.header, payloadType);
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload || []);
    if (typeof RtpHeader === "function" && typeof RtpPacket === "function") {
        const cleanPacket = new RtpPacket(new RtpHeader(header), payload);
        if (typeof cleanPacket.serialize === "function") return cleanPacket.serialize();
    }
    if (typeof packet.serialize === "function") {
        packet.header = header;
        packet.payload = payload;
        return packet.serialize();
    }
    return null;
}

function deserializeRtpPacket(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (typeof RtpPacket?.deSerialize === "function") return RtpPacket.deSerialize(buffer);
    if (typeof RtpPacket?.deserialize === "function") return RtpPacket.deserialize(buffer);
    return null;
}

function normalizeHeaderName(name) {
    return String(name || "").trim().toLowerCase();
}

function getHeader(headers, name) {
    if (!headers || typeof headers !== "object") return "";
    const target = normalizeHeaderName(name);
    for (const [key, value] of Object.entries(headers)) {
        if (normalizeHeaderName(key) === target) return String(value || "");
    }
    return "";
}

function extractCallIdFromAuthRequest(body = {}) {
    return (
        body.sipCallId ||
        body.sip_call_id ||
        getHeader(body.sipHeaders, "call-id") ||
        getHeader(body.sip_headers, "call-id") ||
        body.callId ||
        body.call_id ||
        ""
    ).trim();
}

function readJsonRequest(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (_) {
                reject(new Error("invalid json body"));
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    });
    res.end(body);
}

function createOpenAiSipGateway({
    sessions,
    sendDataChannelMessage,
    stopMediaRelay,
    finishMinuteCounter = null,
    config = {},
    logger = console,
}) {
    const activeCalls = new Map();
    const kamailioHost = config.kamailioHost;
    const kamailioPort = Number(config.kamailioPort || 5060);
    const kamailioDomain = config.kamailioDomain || kamailioHost;
    const bindIp = config.bindIp || "0.0.0.0";
    const contactHost = config.contactHost || config.mediaIp || "127.0.0.1";
    const mediaIp = config.mediaIp || contactHost;
    const sipUser = sanitizeSipUser(config.sipUser || "openai-bridge", "openai-bridge");
    const targetUser = sanitizeSipUser(config.targetUser || "2005", "2005");
    const inviteTimeoutMs = Number(config.inviteTimeoutMs || DEFAULT_INVITE_TIMEOUT_MS);
    const offeredPayloadType = Number(config.payloadType || DEFAULT_RTP_PAYLOAD_TYPE);
    const authPort = Number(config.authPort || 2006);
    const authBindIp = config.authBindIp || "0.0.0.0";
    const authPath = config.authPath || "/authorize-openai-call";
    const authToken = config.authToken || "";
    let authServer = null;

    function sendUdp(socket, message, port = kamailioPort, host = kamailioHost) {
        return new Promise((resolve, reject) => {
            socket.send(Buffer.from(message), port, host, (err) => (err ? reject(err) : resolve()));
        });
    }

    function bindSocket(socket, port = 0) {
        return new Promise((resolve, reject) => {
            const onError = (err) => {
                socket.off("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                socket.off("error", onError);
                resolve(socket.address());
            };
            socket.once("error", onError);
            socket.once("listening", onListening);
            socket.bind(port, bindIp);
        });
    }

    async function sendAck(call) {
        call.cseq += 1;
        const ack = sipMessage(`ACK sip:${targetUser}@${kamailioDomain} SIP/2.0`, [
            ["Via", `SIP/2.0/UDP ${contactHost}:${call.localSipPort};branch=z9hG4bK${randomToken()};rport`],
            ["Max-Forwards", "70"],
            ["From", call.fromHeader],
            ["To", call.toHeader],
            ["Call-ID", call.callId],
            ["CSeq", `${call.inviteCseq} ACK`],
            ["Contact", call.contactHeader],
            ["User-Agent", "Arnacon-WebRTC-Service"],
        ]);
        await sendUdp(call.sipSocket, ack);
    }

    async function sendBye(call) {
        if (!call.established || call.byeSent) return;
        call.byeSent = true;
        call.cseq += 1;
        const bye = sipMessage(`BYE sip:${targetUser}@${kamailioDomain} SIP/2.0`, [
            ["Via", `SIP/2.0/UDP ${contactHost}:${call.localSipPort};branch=z9hG4bK${randomToken()};rport`],
            ["Max-Forwards", "70"],
            ["From", call.fromHeader],
            ["To", call.toHeader],
            ["Call-ID", call.callId],
            ["CSeq", `${call.cseq} BYE`],
            ["Contact", call.contactHeader],
            ["User-Agent", "Arnacon-WebRTC-Service"],
        ]);
        await sendUdp(call.sipSocket, bye).catch((err) => {
            logger.warn(`[${call.sessionId}] OpenAI SIP BYE send failed: ${err.message}`);
        });
    }

    function cleanupCall(sessionId) {
        const call = activeCalls.get(sessionId);
        if (!call) return;
        activeCalls.delete(sessionId);

        if (call.statsTimer) {
            clearInterval(call.statsTimer);
            call.statsTimer = null;
        }
        if (call.rtpUnsubscribe) {
            try { call.rtpUnsubscribe(); } catch (_) {}
        }
        if (call.sipSocket) {
            try { call.sipSocket.close(); } catch (_) {}
        }
        if (call.rtpSocket) {
            try { call.rtpSocket.close(); } catch (_) {}
        }

        const session = sessions.get(sessionId);
        if (session?.openAiSipConnection === call) session.openAiSipConnection = null;
    }

    function terminateFromRemote(sessionId, reason) {
        const session = sessions.get(sessionId);
        if (session && session.phase === "in-call") {
            if (typeof stopMediaRelay === "function") stopMediaRelay(sessionId);
            if (typeof finishMinuteCounter === "function") finishMinuteCounter(session);
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
            session.phase = "post-call";
        }
        cleanupCall(sessionId);
    }

    function authorizeIncomingOpenAiCall(body = {}) {
        const requestedCallId = extractCallIdFromAuthRequest(body);
        if (!requestedCallId) {
            return { allowed: false, reason: "missing SIP Call-ID" };
        }

        for (const call of activeCalls.values()) {
            if (call.callId !== requestedCallId) continue;

            const session = sessions.get(call.sessionId);
            if (!session) {
                return { allowed: false, reason: "matched OpenAI SIP call has no active WebRTC session" };
            }

            return {
                allowed: true,
                reason: "matched active OpenAI SIP call",
                sessionId: call.sessionId,
                callId: call.callId,
                phase: session.phase || null,
                established: Boolean(call.established),
            };
        }

        return { allowed: false, reason: "no active OpenAI SIP call matched SIP Call-ID" };
    }

    function startAuthServer() {
        if (authServer) return authServer;

        authServer = http.createServer(async (req, res) => {
            const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
            if (req.method === "GET" && url.pathname === "/health") {
                sendJson(res, 200, { ok: true, service: "openai-sip-auth" });
                return;
            }

            const allowedPaths = new Set([authPath, "/openai-call-auth"]);
            if (req.method !== "POST" || !allowedPaths.has(url.pathname)) {
                sendJson(res, 404, { allowed: false, reason: "not found" });
                return;
            }
            if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
                sendJson(res, 401, { allowed: false, reason: "unauthorized" });
                return;
            }

            try {
                const body = await readJsonRequest(req);
                const decision = authorizeIncomingOpenAiCall(body);
                sendJson(res, decision.allowed ? 200 : 403, decision);
            } catch (err) {
                sendJson(res, 400, { allowed: false, reason: err.message });
            }
        });

        authServer.on("error", (err) => {
            logger.error(`[OpenAI-SIP-Auth] server error: ${err.message}`);
        });
        authServer.listen(authPort, authBindIp, () => {
            logger.log(`[OpenAI-SIP-Auth] listening on ${authBindIp}:${authPort}${authPath}`);
        });
        return authServer;
    }

    function stopAuthServer() {
        if (!authServer) return;
        const server = authServer;
        authServer = null;
        server.close((err) => {
            if (err) logger.warn(`[OpenAI-SIP-Auth] close failed: ${err.message}`);
        });
    }

    async function sendSipOk(call, request) {
        const ok = sipMessage("SIP/2.0 200 OK", [
            ["Via", request.headers.via],
            ["From", request.headers.from],
            ["To", request.headers.to],
            ["Call-ID", request.headers["call-id"]],
            ["CSeq", request.headers.cseq],
            ["User-Agent", "Arnacon-WebRTC-Service"],
        ]);
        await sendUdp(call.sipSocket, ok);
    }

    function startRtpBridge(call, remoteMedia) {
        const session = sessions.get(call.sessionId);
        const pc = session?.peerConnection;
        if (!session || !pc) throw new Error("OpenAI SIP RTP bridge missing caller peer connection");

        let openAiToClient = 0;
        let clientToOpenAi = 0;
        let openAiSourceNotified = false;

        call.rtpSocket.on("message", (buffer) => {
            const packet = deserializeRtpPacket(buffer);
            if (!packet || !session.localAudioTrack) return;
            if (!openAiSourceNotified) {
                openAiSourceNotified = true;
                session.localAudioTrack.onSourceChanged.execute({
                    sequenceNumber: packet.header.sequenceNumber,
                    timestamp: packet.header.timestamp,
                });
            }
            openAiToClient += 1;
            session.localAudioTrack.writeRtp(packet);
        });

        for (const t of pc.getTransceivers()) {
            if (t.kind !== "audio" || !t.receiver) continue;
            for (const track of (t.receiver.tracks || [])) {
                if (track.kind !== "audio" || !track.onReceiveRtp?.subscribe) continue;
                const sub = track.onReceiveRtp.subscribe((rtp) => {
                    const outboundPayloadType = Number.isFinite(remoteMedia.payloadType)
                        ? remoteMedia.payloadType
                        : offeredPayloadType;
                    const raw = serializePlainRtp(rtp, outboundPayloadType);
                    if (!raw) return;
                    clientToOpenAi += 1;
                    call.rtpSocket.send(raw, remoteMedia.port, remoteMedia.ip);
                });
                call.rtpUnsubscribe = sub?.unSubscribe || null;
                break;
            }
            break;
        }

        call.statsTimer = setInterval(() => {
            logger.log(
                `[${call.sessionId}] OpenAI-SIP RTP-STATS client_to_openai=${clientToOpenAi} openai_to_client=${openAiToClient} ` +
                `remote=${remoteMedia.ip}:${remoteMedia.port} pt=${remoteMedia.payloadType}`
            );
        }, 2000);
    }

    async function openOpenAiSipSession(sessionId, options = {}) {
        if (!kamailioHost) throw new Error("OpenAI SIP route missing kamailioHost");
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (activeCalls.has(sessionId)) throw new Error("OpenAI SIP session already active");

        const sipSocket = dgram.createSocket("udp4");
        const rtpSocket = dgram.createSocket("udp4");
        const sipAddress = await bindSocket(sipSocket, 0);
        const rtpAddress = await bindSocket(rtpSocket, 0);
        const localSipPort = sipAddress.port;
        const localRtpPort = rtpAddress.port;

        const callerUser = sanitizeSipUser(options.callerEns || session.callerEns, "caller");
        const fromTag = randomToken();
        const callId = `${randomToken(12)}@${contactHost}`;
        const call = {
            sessionId,
            sipSocket,
            rtpSocket,
            localSipPort,
            localRtpPort,
            inviteCseq: 1,
            cseq: 1,
            callId,
            fromHeader: `<sip:${callerUser}@${kamailioDomain}>;tag=${fromTag}`,
            toHeader: `<sip:${targetUser}@${kamailioDomain}>`,
            contactHeader: `<sip:${sipUser}@${contactHost}:${localSipPort}>`,
            established: false,
            byeSent: false,
            rtpUnsubscribe: null,
            statsTimer: null,
        };

        activeCalls.set(sessionId, call);
        session.openAiSipConnection = call;

        const sdp = buildPlainRtpSdp({
            mediaIp,
            mediaPort: localRtpPort,
            sessionId,
            payloadType: offeredPayloadType,
        });

        const invite = sipMessage(`INVITE sip:${targetUser}@${kamailioDomain} SIP/2.0`, [
            ["Via", `SIP/2.0/UDP ${contactHost}:${localSipPort};branch=z9hG4bK${randomToken()};rport`],
            ["Max-Forwards", "70"],
            ["From", call.fromHeader],
            ["To", call.toHeader],
            ["Call-ID", call.callId],
            ["CSeq", `${call.inviteCseq} INVITE`],
            ["Contact", call.contactHeader],
            ["Allow", "INVITE, ACK, BYE, CANCEL, OPTIONS"],
            ["User-Agent", "Arnacon-WebRTC-Service"],
            ["Content-Type", "application/sdp"],
        ], sdp);

        logger.log(`[${sessionId}] OpenAI-SIP: sending clean UDP INVITE to ${kamailioHost}:${kamailioPort} as ${callerUser}`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanupCall(sessionId);
                reject(new Error("OpenAI SIP INVITE timed out"));
            }, inviteTimeoutMs);

            const fail = (err) => {
                clearTimeout(timer);
                cleanupCall(sessionId);
                reject(err);
            };

            sipSocket.on("message", async (buffer) => {
                const message = parseSipMessage(buffer.toString("utf8"));
                const status = getStatusCode(message.startLine);
                const method = getMethod(message.startLine);

                if (method === "BYE") {
                    await sendSipOk(call, message).catch(() => {});
                    terminateFromRemote(sessionId, "openai-sip-bye");
                    return;
                }

                if (!status) return;
                logger.log(`[${sessionId}] OpenAI-SIP response: ${message.startLine}`);
                if (status >= 100 && status < 200) return;
                if (status >= 300) {
                    fail(new Error(`OpenAI SIP INVITE rejected: ${message.startLine}`));
                    return;
                }
                if (status >= 200 && status < 300) {
                    if (call.established) {
                        await sendAck(call).catch(() => {});
                        return;
                    }
                    const remoteMedia = parseSdpRemote(message.body);
                    if (!remoteMedia) {
                        fail(new Error("OpenAI SIP 200 OK missing usable RTP media"));
                        return;
                    }
                    call.toHeader = message.headers.to || call.toHeader;
                    if (!tagFromToHeader(call.toHeader)) {
                        fail(new Error("OpenAI SIP 200 OK missing To tag"));
                        return;
                    }
                    call.established = true;
                    clearTimeout(timer);
                    await sendAck(call);
                    startRtpBridge(call, remoteMedia);
                    logger.log(`[${sessionId}] OpenAI-SIP call active via ${remoteMedia.ip}:${remoteMedia.port}`);
                    resolve();
                }
            });

            sipSocket.on("error", fail);
            rtpSocket.on("error", (err) => logger.warn(`[${sessionId}] OpenAI-SIP RTP socket error: ${err.message}`));
            sendUdp(sipSocket, invite).catch(fail);
        });
    }

    async function closeOpenAiSipSession(sessionId) {
        const call = activeCalls.get(sessionId);
        if (!call) return;
        if (call.statsTimer) {
            clearInterval(call.statsTimer);
            call.statsTimer = null;
        }
        await sendBye(call);
        cleanupCall(sessionId);
    }

    return {
        openOpenAiSipSession,
        closeOpenAiSipSession,
        authorizeIncomingOpenAiCall,
        startAuthServer,
        stopAuthServer,
    };
}

module.exports = {
    createOpenAiSipGateway,
};
