const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { MediaGraphFactory } = require("../../media/MediaGraphFactory");
const { OpenAiRtpSession } = require("./OpenAiRtpSession");
const { OpenAiTransferController } = require("./OpenAiTransferController");
const { OpenAiAuthServer } = require("./OpenAiAuthServer");
const {
    randomToken,
    sanitizeSipUser,
    sipMessage,
    parseSipMessage,
    getStatusCode,
    getMethod,
    tagFromToHeader,
    sendUdp,
    bindSocket,
} = require("./OpenAiSipTransport");
const {
    DEFAULT_RTP_PAYLOAD_TYPE,
    buildPlainRtpSdp,
    parseSdpRemote,
    serializePlainRtp,
    deserializeRtpPacket,
} = require("./OpenAiPlainRtp");
const { CallEventSources, createRemoteByeReceivedEvent } = require("../../calls/CallEvents");

const DEFAULT_INVITE_TIMEOUT_MS = 30000;

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

function formatSipExtraHeaders(headers) {
    if (!headers || typeof headers !== "object") return [];
    const out = [];
    for (const [rawName, rawValue] of Object.entries(headers)) {
        const name = String(rawName || "").trim();
        const value = String(rawValue || "").trim();
        if (!name || !value) continue;
        if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
        out.push([name, value.replace(/[\r\n]/g, " ")]);
    }
    return out;
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
    onTransferOpenAiCall = null,
    onCallEvent = null,
    isInCall = null,
    config = {},
    logger = console,
}) {
    const activeCalls = new Map();
    const mediaGraphFactory = new MediaGraphFactory({ sessions, logger });
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
    const authPort = Number(config.authPort || 2005);
    const authBindIp = config.authBindIp || "0.0.0.0";
    const authPath = config.authPath || "/authorize-openai-call";
    const transferPath = config.transferPath || "/transfer-openai-call";
    const authUseHttps = config.authUseHttps !== false;
    const rtpSession = new OpenAiRtpSession({
        sessions,
        mediaGraphFactory,
        offeredPayloadType,
        serializePlainRtp,
        deserializeRtpPacket,
        logger,
    });
    const transferController = new OpenAiTransferController({
        activeCalls,
        sessions,
        onTransferOpenAiCall,
    });
    let authServer = null;
    let authServerController = null;

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
        await sendUdp(call.sipSocket, ack, kamailioPort, kamailioHost);
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
        await sendUdp(call.sipSocket, bye, kamailioPort, kamailioHost).catch((err) => {
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
        if (call.mediaBridge) {
            call.mediaBridge.stop().catch((err) => {
                logger.warn(`[${sessionId}] OpenAI media bridge stop failed: ${err.message}`);
            });
            call.mediaBridge = null;
        }
        if (call.sipSocket) {
            try { call.sipSocket.close(); } catch (_) {}
        }
        if (call.rtpSocket) {
            try { call.rtpSocket.close(); } catch (_) {}
        }

        const session = sessions.get(sessionId);
        if (session?.openAiSipConnection === call) {
            session.resources?.openAiLeg?.().clear({ reason: "openai-gateway-cleanup" });
        }
    }

    function terminateFromRemote(sessionId, reason) {
        const session = sessions.get(sessionId);
        if (session && typeof isInCall === "function" && isInCall(session)) {
            if (typeof onCallEvent === "function") {
                Promise.resolve(onCallEvent(sessionId, createRemoteByeReceivedEvent({
                    source: CallEventSources.OpenAi,
                    reason,
                    remoteDialogId: session.openAiSipConnection?.callId || null,
                    notifyClient: true,
                    propagateLinkedSession: true,
                }))).catch((err) => {
                    logger.warn(`[${sessionId}] OpenAI remote BYE event failed: ${err.message}`);
                });
            } else {
                if (typeof stopMediaRelay === "function") stopMediaRelay(sessionId);
                if (typeof finishMinuteCounter === "function") finishMinuteCounter(session);
                sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
            }
        }
        cleanupCall(sessionId);
    }

    async function terminateOpenAiCallFromRemote(call, reason) {
        if (typeof call?.onRemoteBye === "function") {
            try {
                await call.onRemoteBye(reason);
            } catch (err) {
                logger.warn(`[${call.sessionId}] OpenAI-SIP remote BYE handler failed: ${err.message}`);
            }
            cleanupCall(call.sessionId);
            return;
        }
        terminateFromRemote(call.sessionId, reason);
    }

    function authorizeIncomingOpenAiCall(body = {}) {
        const requestedCallId = extractCallIdFromAuthRequest(body);
        if (!requestedCallId) {
            return { allowed: false, reason: "missing SIP Call-ID" };
        }
        const openAiCallId = body.openAiCallId || body.callId || body.call_id || null;

        for (const call of activeCalls.values()) {
            if (call.callId !== requestedCallId) continue;

            const session = sessions.get(call.sessionId);
            if (!session) {
                return { allowed: false, reason: "matched OpenAI SIP call has no active WebRTC session" };
            }
            if (openAiCallId) call.openAiCallId = openAiCallId;

            return {
                allowed: true,
                reason: "matched active OpenAI SIP call",
                sessionId: call.sessionId,
                callId: call.callId,
                openAiCallId: call.openAiCallId || null,
                mode: call.mode || "default",
                phase: session.phase || null,
                established: Boolean(call.established),
            };
        }

        return { allowed: false, reason: "no active OpenAI SIP call matched SIP Call-ID" };
    }

    function transferOpenAiCall(body = {}) {
        return transferController.transfer(body);
    }

    function getAuthServerOptions() {
        if (!authUseHttps) {
            return {
                scheme: "http",
                createServer: (handler) => http.createServer(handler),
            };
        }

        try {
            const tlsOptions = config.authTlsOptions || {
                cert: config.authTlsCertPath ? fs.readFileSync(config.authTlsCertPath) : null,
                key: config.authTlsKeyPath ? fs.readFileSync(config.authTlsKeyPath) : null,
            };
            if (!tlsOptions.cert || !tlsOptions.key) {
                throw new Error("missing auth TLS cert/key");
            }
            return {
                scheme: "https",
                createServer: (handler) => https.createServer(tlsOptions, handler),
            };
        } catch (err) {
            logger.warn(`[OpenAI-SIP-Auth] HTTPS unavailable (${err.message}); falling back to HTTP`);
            return {
                scheme: "http",
                createServer: (handler) => http.createServer(handler),
            };
        }
    }

    function startAuthServer() {
        if (authServer) return authServer;

        const authServerOptions = getAuthServerOptions();
        authServerController = new OpenAiAuthServer({
            createServer: authServerOptions.createServer,
            authPath,
            transferPath,
            authPort,
            authBindIp,
            scheme: authServerOptions.scheme,
            readJsonRequest,
            sendJson,
            authorizeIncomingOpenAiCall,
            transferOpenAiCall,
            logger,
        });
        authServer = authServerController.start();
        return authServer;
    }

    function stopAuthServer() {
        if (!authServer) return;
        const controller = authServerController;
        authServer = null;
        authServerController = null;
        if (controller) controller.stop();
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
        await sendUdp(call.sipSocket, ok, kamailioPort, kamailioHost);
    }

    async function openOpenAiSipSession(sessionId, options = {}) {
        if (!kamailioHost) throw new Error("OpenAI SIP route missing kamailioHost");
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (activeCalls.has(sessionId)) throw new Error("OpenAI SIP session already active");

        const sipSocket = dgram.createSocket("udp4");
        const rtpSocket = dgram.createSocket("udp4");
        const sipAddress = await bindSocket(sipSocket, { port: 0, bindIp });
        const rtpAddress = await bindSocket(rtpSocket, { port: 0, bindIp });
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
            openAiCallId: null,
            fromHeader: `<sip:${callerUser}@${kamailioDomain}>;tag=${fromTag}`,
            toHeader: `<sip:${targetUser}@${kamailioDomain}>`,
            contactHeader: `<sip:${sipUser}@${contactHost}:${localSipPort}>`,
            established: false,
            byeSent: false,
            rtpUnsubscribe: null,
            statsTimer: null,
            mediaBridge: null,
            mode: options.mode || "default",
            mediaAdapter: options.mediaAdapter || null,
            onRemoteBye: options.onRemoteBye || null,
        };

        activeCalls.set(sessionId, call);
        session.openAiSipConnection = call;
        session.resources?.register("openAiLeg", (reason = "openai-resource-stop") => {
            logger.log(`[${sessionId}] OpenAI SIP leg resource stop reason=${reason}`);
            cleanupCall(sessionId);
        });

        const sdp = buildPlainRtpSdp({
            mediaIp,
            mediaPort: localRtpPort,
            sessionId,
            payloadType: offeredPayloadType,
        });

        const extraHeaders = formatSipExtraHeaders(options.headers);
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
            ...extraHeaders,
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
                    await terminateOpenAiCallFromRemote(call, "openai-sip-bye");
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
                    rtpSession.start(call, remoteMedia);
                    logger.log(`[${sessionId}] OpenAI-SIP call active via ${remoteMedia.ip}:${remoteMedia.port}`);
                    resolve();
                }
            });

            sipSocket.on("error", fail);
            rtpSocket.on("error", (err) => logger.warn(`[${sessionId}] OpenAI-SIP RTP socket error: ${err.message}`));
            sendUdp(sipSocket, invite, kamailioPort, kamailioHost).catch(fail);
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
        transferOpenAiCall,
        startAuthServer,
        stopAuthServer,
    };
}

class OpenAiGateway {
    constructor({ openAiSipGateway } = {}) {
        if (!openAiSipGateway) throw new Error("OpenAiGateway requires openAiSipGateway");
        this.openAiSipGateway = openAiSipGateway;
    }

    open(sessionId, options = {}) {
        return this.openAiSipGateway.openOpenAiSipSession(sessionId, options);
    }

    close(sessionId) {
        return this.openAiSipGateway.closeOpenAiSipSession(sessionId);
    }

    startAuthServer() {
        return this.openAiSipGateway.startAuthServer();
    }

    stopAuthServer() {
        return this.openAiSipGateway.stopAuthServer();
    }
}

module.exports = {
    createOpenAiSipGateway,
    OpenAiGateway,
};
