"use strict";

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
    logger = console,
}) {
    async function openSipSession(sessionId, sessionStore, options = {}) {
        const { callerEns, calleeIdentity } = options;
        const session = sessionStore.get(sessionId);
        if (!session) throw new Error("Session not found");

        logger.log(`[${sessionId}] Opening SIP session to Kamailio for ${calleeIdentity}`);
        const transportOptions = {
            server: kamailioWssUrl,
            webSocketConstruction: (url, protocols) => new WsWebSocket(url, protocols),
        };
        const sipUri = UserAgent.makeURI(`sip:${callerEns}@${kamailioDomain}`);
        const userAgent = new UserAgent({
            uri: sipUri,
            transportOptions,
            sessionDescriptionHandlerFactoryOptions: { iceGatheringTimeout: 5000 },
            logLevel: "error",
        });
        await userAgent.start();
        const registerer = new Registerer(userAgent, { expires: registerExpires });
        await registerer.register();

        const targetUri = UserAgent.makeURI(`sip:${calleeIdentity}@${kamailioDomain}`);
        const inviter = new Inviter(userAgent, targetUri, {
            sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
        });

        const SIP_INVITE_TIMEOUT = 30000;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                try { inviter.cancel(); } catch (_) {}
                reject(new Error("SIP INVITE timed out (no answer from SBC)"));
            }, SIP_INVITE_TIMEOUT);

            inviter.stateChange.addListener((state) => {
                logger.log(`[${sessionId}] SIP session state: ${state}`);
                if (state === SessionState.Established) {
                    clearTimeout(timer);
                    resolve();
                } else if (state === SessionState.Terminated) {
                    clearTimeout(timer);
                    reject(new Error("SIP call terminated before established"));
                }
            });

            inviter.invite().catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        attachSbcByeHandler(inviter, sessionId);
        const sdh = inviter.sessionDescriptionHandler;
        const pc2 = sdh?.peerConnection || null;
        if (pc2) {
            setupPc2(session, pc2, sessionId);
        }
        session.sipConnection = { userAgent, registerer, inviter };
        logger.log(`[${sessionId}] SIP INVITE answered — call active`);
    }

    async function openInboundSipSession(sessionId, sessionStore, options = {}) {
        const { phoneNumber } = options;
        const session = sessionStore.get(sessionId);
        if (!session) throw new Error("Session not found");

        logger.log(`[${sessionId}] Opening inbound SIP session — registering as ${phoneNumber}`);
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
        logger.log(`[${sessionId}] SIP REGISTER as ${phoneNumber} successful — waiting for resumed INVITE`);

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
        attachSbcByeHandler(invitation, sessionId);
        startMediaRelay(sessionId);
        logger.log(`[${sessionId}] Inbound call active — audio flowing via SBC`);
    }

    async function closeSipSession(sessionId, sessionStore) {
        const session = sessionStore.get(sessionId);
        if (!session || !session.sipConnection) return;
        const { userAgent, registerer, inviter, invitation } = session.sipConnection;
        const sipSession = inviter || invitation;
        if (sipSession && sipSession.state === SessionState.Established) {
            try { await sipSession.bye(); } catch (_) {}
        }
        if (registerer) {
            try { await registerer.unregister(); } catch (_) {}
        }
        if (userAgent) {
            try { await userAgent.stop(); } catch (_) {}
        }
        session.sipConnection = null;
        session.sipPeerConnection = null;
        session.sipLocalAudioTrack = null;
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
