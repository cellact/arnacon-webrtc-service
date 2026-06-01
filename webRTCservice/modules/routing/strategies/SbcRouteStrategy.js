const { RouteStrategy } = require("./RouteStrategy");

class SbcRouteStrategy extends RouteStrategy {
    constructor({
        sipRoutePort = null,
        billingPort = null,
        openSipSession = null,
        closeSipSession = null,
        resolveCallerId = null,
        minuteCounter = null,
        minuteCounterPolicy = null,
        startMediaRelay = null,
        stopMediaRelay,
        finishMinuteCounter = null,
        logger = console,
    } = {}) {
        super();
        this.sipRoutePort = sipRoutePort || {
            open: openSipSession,
            close: closeSipSession,
            resolveCallerId,
            startMedia: startMediaRelay,
            stopMedia: stopMediaRelay,
        };
        this.billingPort = billingPort || {
            counter: minuteCounter,
            policy: minuteCounterPolicy,
            finish: finishMinuteCounter,
        };
        if (typeof this.sipRoutePort.stopMedia !== "function") throw new Error("SbcRouteStrategy requires stopMedia");
        this.logger = logger;
    }

    async start(context, event) {
        if (typeof this.sipRoutePort.open !== "function") return undefined;
        const { sessionId, session } = context;
        const destination = event.destination || session.routeDestination;
        const parsedFrom = event.parsedFrom || null;
        const callerIdResult = typeof this.sipRoutePort.resolveCallerId === "function"
            ? await this.sipRoutePort.resolveCallerId(parsedFrom, session.walletAddress, session.serviceId || null)
            : null;
        if (callerIdResult?.privateId && !callerIdResult?.callerId && !callerIdResult?.identity?.fromUri) {
            throw new Error("SBC privacy policy requires a masked caller ID, but none was available");
        }
        const sipFrom = event.sipFrom || callerIdResult?.callerId || parsedFrom?.full || session.callerEns;
        const sipTo = event.sipTo || destination?.number || destination?.target || destination?.to || session.toIdentity;
        const sipDirective = event.sipDirective || {
            target: destination?.target || null,
            identity: callerIdResult?.identity || null,
            privacy: callerIdResult?.privacy || null,
            headers: {
                ...(callerIdResult?.headers || {}),
                "X-Arnacon-Service-Id": session?.serviceId || "",
            },
            trace: {
                serviceId: session?.serviceId || "",
                sessionId,
                callId: session?.callId || "",
            },
            callerId: callerIdResult?.callerId || null,
            privateId: callerIdResult?.privateId || null,
        };
        const minuteCounterSettings = this.billingPort.policy
            ? this.billingPort.policy.getSettings(session.serviceId || null)
            : null;
        const minuteCounterIdentity = this.billingPort.policy
            ? this.billingPort.policy.getIdentity(parsedFrom, session)
            : (parsedFrom?.full || session.callerEns || "");
        if (this.billingPort.counter && minuteCounterSettings?.limitSeconds) {
            this.billingPort.counter.assertCanStart({
                serviceId: minuteCounterSettings.serviceId,
                identity: minuteCounterIdentity,
                limitSeconds: minuteCounterSettings.limitSeconds,
            });
        }
        await this.sipRoutePort.open(sessionId, sipFrom, sipTo, sipDirective);
        if (this.billingPort.counter && minuteCounterSettings?.limitSeconds) {
            this.billingPort.counter.start(session, {
                serviceId: minuteCounterSettings.serviceId,
                identity: minuteCounterIdentity,
                limitSeconds: minuteCounterSettings.limitSeconds,
            });
        }
        return "sbc";
    }

    async connect(context) {
        if (typeof this.sipRoutePort.startMedia === "function") {
            await Promise.resolve(this.sipRoutePort.startMedia(context.sessionId));
        }
        return "sbc";
    }

    async end(context) {
        await this.stopResources(context, { closeSipSession: this.sipRoutePort.close });
        return "sbc";
    }

    async cancel(context, event) {
        return this.end(context, event);
    }

    async fail(context, event) {
        return this.end(context, event);
    }

    async stopResources(context, { closeSipSession = null, reason = "sbc-stop" } = {}) {
        await context.resources?.sipLeg?.().close({
            closeSipSession,
            stopMediaRelay: this.sipRoutePort.stopMedia,
            finishMinuteCounter: this.billingPort.finish,
            reason,
        });
    }

    async endFromRemote(context, event) {
        await this.stopResources(context, { reason: event.reason || "remote-bye" });
        this.logger.log(`[${context.sessionId}] SBC remote end resources cleaned source=${event.source}`);
    }

    async handleDtmf(context, event) {
        const { sessionId, session } = context;
        const msg = event.payload || {};
        const rawDigit = String(msg?.digit ?? "").trim();
        if (!/^[0-9*#ABCD]$/i.test(rawDigit)) {
            throw new Error(`invalid DTMF digit "${rawDigit}"`);
        }
        const digit = rawDigit.toUpperCase();
        const rawDuration = Number(msg?.durationMs);
        const durationMs = Number.isFinite(rawDuration)
            ? Math.max(70, Math.min(6000, Math.floor(rawDuration)))
            : 160;
        if (typeof this.sipRoutePort.sendDtmf === "function") {
            await this.sipRoutePort.sendDtmf(context, { digit, durationMs });
            this.logger.log(`[${sessionId}] DTMF relayed to SIP: digit=${digit} durationMs=${durationMs}`);
            return {
                ackPayload: {
                    digit,
                    durationMs,
                    eventId: msg?.eventId || null,
                },
            };
        }
        const sipSession = context.resources?.sipLeg?.().getSession() ||
            session.sipConnection?.inviter ||
            session.sipConnection?.invitation ||
            null;
        if (!sipSession) throw new Error("no active SIP session");

        if (typeof sipSession.sendDtmf === "function") {
            await sipSession.sendDtmf(digit, { duration: durationMs });
        } else if (typeof sipSession.dtmf === "function") {
            await sipSession.dtmf(digit, { duration: durationMs });
        } else if (typeof sipSession.info === "function") {
            const infoBody = `Signal=${digit}\r\nDuration=${durationMs}\r\n`;
            let infoSent = false;
            try {
                await sipSession.info({
                    requestOptions: {
                        extraHeaders: ["Content-Type: application/dtmf-relay"],
                        body: {
                            contentType: "application/dtmf-relay",
                            content: infoBody,
                        },
                    },
                });
                infoSent = true;
            } catch (_) {}
            if (!infoSent) {
                try {
                    await sipSession.info({
                        requestOptions: {
                            extraHeaders: ["Content-Type: application/dtmf-relay"],
                            body: infoBody,
                        },
                    });
                    infoSent = true;
                } catch (_) {}
            }
            if (!infoSent) await sipSession.info(infoBody, "application/dtmf-relay");
        } else {
            throw new Error("no supported SIP DTMF method on session");
        }
        this.logger.log(`[${sessionId}] DTMF relayed to SIP: digit=${digit} durationMs=${durationMs}`);
        return {
            ackPayload: {
                digit,
                durationMs,
                eventId: msg?.eventId || null,
            },
        };
    }
}

module.exports = {
    SbcRouteStrategy,
};
