const { RouteStrategy } = require("./RouteStrategy");

class IvrRouteStrategy extends RouteStrategy {
    constructor({
        ivrRoutePort = null,
        startIvrSession,
        stopIvrSession,
        logger = console,
    } = {}) {
        super();
        this.ivrRoutePort = ivrRoutePort || {
            start: startIvrSession,
            stop: stopIvrSession,
        };
        this.logger = logger;
    }

    async start() {
        return "ivr";
    }

    async connect(context, event) {
        if (typeof this.ivrRoutePort.start !== "function") return "ivr";
        const destination = event.destination || context.session.routeDestination || {};
        const started = await this.ivrRoutePort.start(context.sessionId, {
            route: "ivr",
            source: event.source || "route-connect",
            target: destination.target || "",
            waitingAudioFile: destination.waitingAudioFile || null,
        });
        if (!started) throw new Error("IVR route requested but session did not enter IVR mode");
        return started;
    }

    async end(context, event) {
        if (typeof this.ivrRoutePort.stop === "function") {
            await this.ivrRoutePort.stop(context.sessionId, event.reason || "ivr-end");
        }
        return "ivr";
    }

    async cancel(context, event) {
        return this.end(context, event);
    }

    async fail(context, event) {
        return this.end(context, event);
    }
}

module.exports = {
    IvrRouteStrategy,
};
