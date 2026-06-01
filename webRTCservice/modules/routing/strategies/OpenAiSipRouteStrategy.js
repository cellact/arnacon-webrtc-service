const { RouteStrategy } = require("./RouteStrategy");

class OpenAiSipRouteStrategy extends RouteStrategy {
    constructor({
        openAiRoutePort = null,
        billingPort = null,
        openOpenAiSipSession,
        closeOpenAiSipSession,
        resolveCallerId = null,
        stopMediaRelay = null,
        finishMinuteCounter = null,
        logger = console,
    } = {}) {
        super();
        this.openAiRoutePort = openAiRoutePort || {
            open: openOpenAiSipSession,
            close: closeOpenAiSipSession,
            resolveCallerId,
            stopMedia: stopMediaRelay,
        };
        this.billingPort = billingPort || {
            finish: finishMinuteCounter,
        };
        this.logger = logger;
    }

    async start(context, event) {
        if (typeof this.openAiRoutePort.open !== "function") return undefined;
        const { sessionId, session } = context;
        const destination = event.destination || session.routeDestination;
        const callerIdResult = typeof this.openAiRoutePort.resolveCallerId === "function"
            ? await this.openAiRoutePort.resolveCallerId(event.parsedFrom || null, session.walletAddress, session.serviceId || null)
            : null;
        await this.openAiRoutePort.open(sessionId, {
            callerEns: event.callerEns || callerIdResult?.callerId || session.callerEns,
            callerId: callerIdResult?.callerId || null,
            destination,
            parsedFrom: event.parsedFrom || null,
        });
        return "openai-sip";
    }

    async connect() {
        return "openai-sip";
    }

    async end(context) {
        await context.resources?.openAiLeg?.().close({
            closeOpenAiSipSession: this.openAiRoutePort.close,
            stopMediaRelay: this.openAiRoutePort.stopMedia,
            finishMinuteCounter: this.billingPort.finish,
            reason: "openai-sip-end",
        });
        return "openai-sip";
    }

    async cancel(context, event) {
        return this.end(context, event);
    }

    async fail(context, event) {
        return this.end(context, event);
    }

    async endFromRemote(context) {
        await context.resources?.openAiLeg?.().clear({
            stopMediaRelay: this.openAiRoutePort.stopMedia,
            finishMinuteCounter: this.billingPort.finish,
            reason: "openai-sip-remote-end",
        });
        return "openai-sip";
    }
}

module.exports = {
    OpenAiSipRouteStrategy,
};
