class OpenAiTransferFlow {
    constructor({
        sessions,
        parseAddress,
        resolveDestination,
        closeOpenAiSipSession,
        stopMediaRelay,
        routeCall,
        closeSipSession,
        startPendingMultiBridge,
        startMediaRelay,
        sendDataChannelMessage,
        callRuntime = null,
        connectRoute = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            parseAddress,
            resolveDestination,
            closeOpenAiSipSession,
            stopMediaRelay,
            routeCall,
            closeSipSession,
            startPendingMultiBridge,
            startMediaRelay,
            sendDataChannelMessage,
            callRuntime,
            connectRoute,
            logger,
        });
    }

    normalizeTarget(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const withoutSip = raw.replace(/^sip:/i, "").split(";")[0].split("@")[0].trim();
        if (withoutSip.toLowerCase().endsWith(".global")) return withoutSip.toLowerCase();

        let number = withoutSip.replace(/[^\d+*]/g, "");
        if (number.startsWith("*")) return `*${number.slice(1).replace(/\D/g, "")}`;
        if (number.startsWith("+")) return `+${number.slice(1).replace(/\D/g, "")}`;
        number = number.replace(/\D/g, "");
        return number;
    }

    isSessionEnded(session) {
        return this.callRuntime.isTerminalForSipEvents(session);
    }

    createToken() {
        return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    }

    async request({
        sessionId,
        sipCallId = null,
        openAiCallId = null,
        target,
        label = null,
        reason = "openai-transfer-call",
    } = {}) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) {
            throw Object.assign(new Error("transfer session not found"), { statusCode: 404 });
        }
        if (session.openAiTransferInProgress) {
            throw Object.assign(new Error("transfer already in progress"), { statusCode: 409 });
        }

        const normalizedTarget = this.normalizeTarget(target);
        if (
            !normalizedTarget ||
            (
                !normalizedTarget.endsWith(".global") &&
                !/^(?:\+?\d{3,18}|\*\d{2,18})$/.test(normalizedTarget)
            )
        ) {
            throw Object.assign(new Error(`invalid transfer target: ${target}`), { statusCode: 400 });
        }

        const serviceId = session.serviceId || "secnum";
        const parsedTo = this.parseAddress(normalizedTarget, serviceId);
        const parsedFrom = this.parseAddress(session.callerEns, serviceId);
        const destination = await this.resolveDestination(parsedTo, parsedFrom, serviceId);
        if (!destination || destination.route === "reject") {
            throw Object.assign(
                new Error(destination?.reason || `transfer target rejected: ${normalizedTarget}`),
                { statusCode: 400 },
            );
        }
        if (destination.route === "openai-sip" || destination.route === "ivr") {
            throw Object.assign(
                new Error(`unsupported transfer route: ${destination.route}`),
                { statusCode: 400 },
            );
        }

        this.logger.log(
            `[${sessionId}] OpenAI transfer requested target=${normalizedTarget} ` +
            `route=${destination.route} label=${label || ""} reason=${reason} ` +
            `openAiCallId=${openAiCallId || ""} sipCallId=${sipCallId || ""}`,
        );

        session.openAiTransferInProgress = {
            id: this.createToken(),
            target: normalizedTarget,
            route: destination.route,
            label,
            reason,
            requestedAt: Date.now(),
            openAiCallId,
            sipCallId,
        };
        const transferState = session.openAiTransferInProgress;

        try {
            if (this.isSessionEnded(session)) {
                if (session.openAiTransferInProgress === transferState) {
                    session.openAiTransferInProgress = null;
                }
                this.logger.log(
                    `[${sessionId}] OpenAI transfer cancelled before dial target=${normalizedTarget} ` +
                    `route=${destination.route}`,
                );
                return {
                    status: "cancelled",
                    route: destination.route,
                    target: normalizedTarget,
                    label,
                    reason,
                };
            }
            if (this.callRuntime) this.callRuntime.markRinging(sessionId, { source: "openai", reason: "openai-transfer" });
            this.logger.log(
                `[${sessionId}] OpenAI transfer accepted target=${normalizedTarget} ` +
                `route=${destination.route}; closing OpenAI and starting destination dial`,
            );
            setImmediate(() => {
                this.runDial({
                    sessionId,
                    transferState,
                    destination,
                    parsedFrom,
                }).catch((err) => {
                    this.logger.warn(`[${sessionId}] OpenAI transfer dial worker crashed: ${err.message}`);
                });
            });
            return {
                status: "dialing",
                route: destination.route,
                target: normalizedTarget,
                label,
                reason,
            };
        } catch (err) {
            this.logger.warn(
                `[${sessionId}] OpenAI transfer failed target=${normalizedTarget} ` +
                `route=${destination.route} err=${err.message}`,
            );
            if (session.openAiTransferInProgress === transferState) {
                session.openAiTransferInProgress = null;
            }
            throw err;
        }
    }

    async runDial({
        sessionId,
        transferState,
        destination,
        parsedFrom,
    }) {
        const initialSession = this.sessions.get(sessionId);
        if (!initialSession || initialSession.openAiTransferInProgress !== transferState) return;

        try {
            await this.closeOpenAiSipSession(sessionId);
            this.stopMediaRelay(sessionId);
            if (
                this.isSessionEnded(initialSession) ||
                !initialSession.peerConnection ||
                initialSession.openAiTransferInProgress !== transferState
            ) {
                this.logger.log(
                    `[${sessionId}] OpenAI transfer cancelled before destination dial ` +
                    `target=${transferState.target} route=${destination.route}`,
                );
                return;
            }
            const routeResult = await this.routeCall(sessionId, initialSession, destination, parsedFrom);
            const session = this.sessions.get(sessionId);
            if (
                this.isSessionEnded(session) ||
                !session.peerConnection ||
                session.openAiTransferInProgress !== transferState
            ) {
                await this.closeSipSession(sessionId);
                this.stopMediaRelay(sessionId);
                this.logger.log(
                    `[${sessionId}] OpenAI transfer dial answered after caller ended; ` +
                    `torn down target=${transferState.target} route=${destination.route}`,
                );
                return;
            }

            if (this.callRuntime) this.callRuntime.markInCall(sessionId, { source: "openai", reason: "openai-transfer-connected" });
            if (destination.route === "webrtc-multiring") {
                this.startPendingMultiBridge(sessionId);
            }
            if (routeResult === "sbc") {
                if (typeof this.connectRoute === "function") {
                    await this.connectRoute(sessionId, { destination, routeResult, source: "openai-transfer" });
                } else {
                    this.startMediaRelay(sessionId);
                }
            }
            this.logger.log(
                `[${sessionId}] OpenAI transfer committed target=${transferState.target} ` +
                `route=${destination.route} routeResult=${routeResult || ""}`,
            );
        } catch (err) {
            const session = this.sessions.get(sessionId);
            this.logger.warn(
                `[${sessionId}] OpenAI transfer failed target=${transferState.target} ` +
                `route=${destination.route} err=${err.message}`,
            );
            if (session && session.openAiTransferInProgress === transferState && !this.isSessionEnded(session)) {
                if (this.callRuntime) {
                    this.callRuntime.markFailed(sessionId, { source: "openai", reason: "openai-transfer-failed", error: err });
                    this.callRuntime.notifyCallEnd(sessionId, { reason: "openai-transfer-failed" });
                } else {
                    this.sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason: "openai-transfer-failed" });
                }
            }
        } finally {
            const session = this.sessions.get(sessionId);
            if (session?.openAiTransferInProgress === transferState) {
                session.openAiTransferInProgress = null;
            }
        }
    }
}

module.exports = {
    OpenAiTransferFlow,
};
