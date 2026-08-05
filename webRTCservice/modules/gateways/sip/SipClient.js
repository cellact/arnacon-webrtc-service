const crypto = require("crypto");

function createSipClient({
    UserAgent,
    Registerer,
    Inviter,
    SessionState,
    WsWebSocket,
    kamailioWssUrl,
    kamailioDomain,
    registerExpires,
    attachSbcByeHandler,
    setupPc2,
    startMediaRelay,
    isTerminalForSipEvents = null,
    logger = console,
}) {
    // SIP.js/werift can fail answer negotiation when SBC returns a narrow codec set.
    // Normalize SIP SDP to telephony-safe codecs only for SIP legs.
    async function sipAudioCodecNormalizer(description) {
        if (!description || typeof description.sdp !== "string") return description;
        const lines = description.sdp.split("\r\n");
        const allowedPt = new Set(["8", "0", "101"]);
        const keepByPtPrefixes = ["a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"];
        const out = [];
        let inAudio = false;

        for (const line of lines) {
            if (line.startsWith("m=")) {
                inAudio = line.startsWith("m=audio ");
                if (inAudio) {
                    const parts = line.trim().split(/\s+/);
                    const header = parts.slice(0, 3);
                    const payloads = parts.slice(3).filter((pt) => allowedPt.has(pt));
                    out.push([...header, ...payloads].join(" "));
                } else {
                    out.push(line);
                }
                continue;
            }

            if (inAudio) {
                const prefix = keepByPtPrefixes.find((p) => line.startsWith(p));
                if (prefix) {
                    const rest = line.slice(prefix.length);
                    const pt = rest.split(/\s|:/)[0];
                    if (!allowedPt.has(pt)) continue;
                }
            }

            out.push(line);
        }

        description.sdp = out.join("\r\n");
        return description;
    }

    function hashIdentityForLog(value) {
        return String(value || "").trim();
    }

    function sipIdentityUri(value) {
        const normalized = String(value || "").trim();
        if (!normalized) return null;
        if (/^sip:/i.test(normalized)) return normalized;
        return `sip:${normalized}@${kamailioDomain}`;
    }

    function releaseSipSessionFields(session, sipConnection = null) {
        if (!session) return false;
        if (sipConnection && session.sipConnection !== sipConnection) return false;
        session.sipConnection = null;
        session.sipPeerConnection = null;
        session.sipLocalAudioTrack = null;
        return true;
    }

    function registerSipHandle(sessionId, session, sipConnection) {
        session.resources?.register("sipLeg", async (reason = "sip-resource-stop") => {
            await closeSipConnectionResources(sipConnection);
            releaseSipSessionFields(session, sipConnection);
            logger.log(`[${sessionId}] SIP leg released reason=${reason}`);
        });
    }

    async function openSipSession(sessionId, sessionStore, options = {}) {
        const { callerEns, calleeIdentity, sipDirective } = options;
        const session = sessionStore.get(sessionId);
        if (!session) throw new Error("Session not found");

        logger.log(
            `[${sessionId}] Opening SIP session to Kamailio from ${hashIdentityForLog(callerEns)} ` +
            `to ${hashIdentityForLog(calleeIdentity)}`,
        );
        const transportOptions = {
            server: kamailioWssUrl,
            webSocketConstruction: (url, protocols) => new WsWebSocket(url, protocols),
        };
        const fromUri =
            sipDirective?.identity?.fromUri ||
            (sipDirective?.identity?.fromUser ? `sip:${sipDirective.identity.fromUser}@${kamailioDomain}` : null) ||
            `sip:${callerEns}@${kamailioDomain}`;
        const sipUri = UserAgent.makeURI(fromUri);
        if (!sipUri) throw new Error("Invalid From URI for SIP session");
        const userAgent = new UserAgent({
            uri: sipUri,
            transportOptions,
            sessionDescriptionHandlerFactoryOptions: { iceGatheringTimeout: 5000 },
            logLevel: "error",
        });
        await userAgent.start();
        const registerer = new Registerer(userAgent, { expires: registerExpires });
        await registerer.register();

        const toUri = sipDirective?.identity?.toUri || `sip:${calleeIdentity}@${kamailioDomain}`;
        const targetUri = UserAgent.makeURI(toUri);
        if (!targetUri) throw new Error("Invalid To URI for SIP session");
        const extraHeaders = [];
        const assertedIdentity = sipIdentityUri(sipDirective?.callerId);
        if (sipDirective?.identity?.paiUri) {
            extraHeaders.push(`P-Asserted-Identity: <${sipDirective.identity.paiUri}>`);
        } else if (assertedIdentity) {
            extraHeaders.push(`P-Asserted-Identity: <${assertedIdentity}>`);
        }
        const privacyEnabled = sipDirective?.privacy?.enabled === true || Boolean(sipDirective?.privateId);
        if (privacyEnabled) {
            extraHeaders.push(`Privacy: ${sipDirective?.privacy?.value || "id"}`);
        }
        if (sipDirective?.headers && typeof sipDirective.headers === "object") {
            for (const [name, value] of Object.entries(sipDirective.headers)) {
                if (!name || value === undefined || value === null || value === "") continue;
                extraHeaders.push(`${name}: ${value}`);
            }
        }
        const inviter = new Inviter(userAgent, targetUri, {
            sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
            sessionDescriptionHandlerModifiers: [sipAudioCodecNormalizer],
            extraHeaders,
        });
        const sipConnection = { userAgent, registerer, inviter, inviteTimer: null, inviteDone: false };
        session.sipConnection = sipConnection;
        registerSipHandle(sessionId, session, sipConnection);

        const SIP_INVITE_TIMEOUT = 30000;
        try {
            await new Promise((resolve, reject) => {
                const finish = (fn, value) => {
                    if (sipConnection.inviteDone) return;
                    sipConnection.inviteDone = true;
                    if (sipConnection.inviteTimer) {
                        clearTimeout(sipConnection.inviteTimer);
                        sipConnection.inviteTimer = null;
                    }
                    fn(value);
                };
                sipConnection.rejectInviteWait = (err) => finish(reject, err);
                sipConnection.inviteTimer = setTimeout(() => {
                    if (inviter.state !== SessionState.Terminated) {
                        try {
                            Promise.resolve(inviter.cancel()).catch(() => {});
                        } catch (_) {}
                    }
                    finish(reject, new Error("SIP INVITE timed out (no answer from SBC)"));
                }, SIP_INVITE_TIMEOUT);

                inviter.stateChange.addListener((state) => {
                    logger.log(`[${sessionId}] SIP session state: ${state}`);
                    if (state === SessionState.Established) {
                        finish(resolve);
                    } else if (state === SessionState.Terminated) {
                        finish(reject, new Error("SIP call terminated before established"));
                    }
                });

                inviter.invite().catch((err) => {
                    finish(reject, err);
                });
            });
        } catch (err) {
            session.resources?.remove?.("sipLeg");
            releaseSipSessionFields(session, sipConnection);
            try { await closeSipConnectionResources(sipConnection); } catch (_) {}
            throw err;
        }

        if (isTerminalForSipEvents?.(session) || session.sipConnection !== sipConnection) {
            session.resources?.remove?.("sipLeg");
            releaseSipSessionFields(session, sipConnection);
            try { await closeSipConnectionResources(sipConnection); } catch (_) {}
            throw new Error("SIP call answered after caller ended session");
        }

        attachSbcByeHandler(inviter, sessionId);
        const sdh = inviter.sessionDescriptionHandler;
        const pc2 = sdh?.peerConnection || null;
        if (pc2) {
            setupPc2(session, pc2, sessionId);
        }
        if (isTerminalForSipEvents?.(session) || session.sipConnection !== sipConnection) {
            session.resources?.remove?.("sipLeg");
            releaseSipSessionFields(session, sipConnection);
            try { await closeSipConnectionResources(sipConnection); } catch (_) {}
            throw new Error("SIP call answered after caller ended session");
        }
        logger.log(`[${sessionId}] SIP INVITE answered — call active`);
    }

    async function openInboundSipSession(sessionId, sessionStore, options = {}) {
        const { phoneNumber } = options;
        const session = sessionStore.get(sessionId);
        if (!session) throw new Error("Session not found");

        if (session.sipConnection || session.sipPeerConnection) {
            logger.log(`[${sessionId}] openInbound preflight: closing stale SIP leg resources`);
            const staleConnection = session.sipConnection;
            if (staleConnection) {
                try { await closeSipConnectionResources(staleConnection); } catch (_) {}
            }
            session.resources?.remove?.("sipLeg");
            session.sipConnection = null;
            session.sipPeerConnection = null;
            session.sipLocalAudioTrack = null;
        }

        logger.log(
            `[${sessionId}] Opening inbound SIP session — registering as ${hashIdentityForLog(phoneNumber)}`,
        );
        const transportOptions = {
            server: kamailioWssUrl,
            webSocketConstruction: (url, protocols) => new WsWebSocket(url, protocols),
        };
        const sipUri = UserAgent.makeURI(`sip:${phoneNumber}@${kamailioDomain}`);

        const INVITE_TIMEOUT = 30000;
        let resolveInvite;
        let rejectInvite;
        const invitePromise = new Promise((resolve, reject) => {
            resolveInvite = resolve;
            rejectInvite = reject;
        });
        const inviteTimer = setTimeout(() => {
            rejectInvite(new Error("No inbound INVITE received within timeout"));
        }, INVITE_TIMEOUT);

        const userAgent = new UserAgent({
            uri: sipUri,
            transportOptions,
            sessionDescriptionHandlerFactoryOptions: { iceGatheringTimeout: 5000 },
            logLevel: "error",
            delegate: {
                onInvite: (invitation) => {
                    clearTimeout(inviteTimer);
                    logger.log(`[${sessionId}] Received inbound INVITE from Kamailio`);
                    resolveInvite(invitation);
                },
            },
        });

        await userAgent.start();
        const registerer = new Registerer(userAgent, { expires: registerExpires });
        await registerer.register();
        logger.log(
            `[${sessionId}] SIP REGISTER as ${hashIdentityForLog(phoneNumber)} successful — waiting for resumed INVITE`,
        );

        const invitation = await invitePromise;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("INVITE accept timed out")), 15000);
            invitation.stateChange.addListener((state) => {
                logger.log(`[${sessionId}] Inbound SIP state: ${state}`);
                if (state === SessionState.Established) {
                    clearTimeout(timer);
                    resolve();
                } else if (state === SessionState.Terminated) {
                    clearTimeout(timer);
                    reject(new Error("Inbound call terminated before established"));
                }
            });
            invitation.accept({
                sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
                sessionDescriptionHandlerModifiers: [sipAudioCodecNormalizer],
            }).catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const sdh = invitation.sessionDescriptionHandler;
        const pc2 = sdh?.peerConnection || null;
        if (pc2) {
            setupPc2(session, pc2, sessionId);
        }
        session.sipConnection = { userAgent, registerer, invitation };
        registerSipHandle(sessionId, session, session.sipConnection);
        attachSbcByeHandler(invitation, sessionId);
        startMediaRelay(sessionId);
        logger.log(`[${sessionId}] Inbound call active — audio flowing via SBC`);
    }

    async function closeSipConnectionResources(connection) {
        if (!connection) return;
        const { userAgent, registerer, inviter, invitation } = connection;
        if (connection.inviteTimer) {
            clearTimeout(connection.inviteTimer);
            connection.inviteTimer = null;
        }
        if (!connection.inviteDone && typeof connection.rejectInviteWait === "function") {
            connection.rejectInviteWait(new Error("SIP call cancelled before established"));
        }
        const sipSession = inviter || invitation;
        if (sipSession) {
            if (sipSession.state === SessionState.Established) {
                try { await sipSession.bye(); } catch (_) {}
            } else if (sipSession.state !== SessionState.Terminated && sipSession.state !== "Terminating") {
                try {
                    if (typeof sipSession.cancel === "function") await sipSession.cancel();
                    else if (typeof sipSession.reject === "function") await sipSession.reject();
                } catch (_) {}
            }
        }
        if (registerer) {
            try { await registerer.unregister(); } catch (_) {}
        }
        if (userAgent) {
            try { await userAgent.stop(); } catch (_) {}
        }
    }

    async function closeSipSession(sessionId, sessionStore) {
        const session = sessionStore.get(sessionId);
        if (!session || !session.sipConnection) return;
        const sipConnection = session.sipConnection;
        await closeSipConnectionResources(sipConnection);
        if (session.sipConnection !== sipConnection) return;
        session.resources?.remove?.("sipLeg");
        releaseSipSessionFields(session, sipConnection);
    }

    return {
        openSipSession,
        openInboundSipSession,
        closeSipSession,
    };
}

module.exports = {
    createSipClient,
};
