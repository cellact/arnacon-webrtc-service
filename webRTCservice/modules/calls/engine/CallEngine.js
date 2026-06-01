const {
    CallEvents,
    CallEventSources,
    validateCallEvent,
} = require("../CallEvents");

class CallEngine {
    constructor({
        runtime,
        routeStrategies = null,
        handlers = {},
        logger = console,
    } = {}) {
        if (!runtime) throw new Error("CallEngine requires runtime");
        if (!routeStrategies) throw new Error("CallEngine requires route strategy handling");
        this.runtime = runtime;
        this.routeStrategies = routeStrategies;
        this.handlers = handlers;
        this.logger = logger;
    }

    async dispatch(sessionId, event = {}) {
        // Migration pattern for future call events:
        // 1. Define a strict payload in CallEvents.
        // 2. Convert the old raw handler into callEngine.dispatch().
        // 3. Move lifecycle/session writes into CallRuntime.
        // 4. Move route-specific side effects into a RouteStrategy.
        // 5. Delete the old direct mutation path before migrating the next event.
        validateCallEvent(event);
        if (event.type === CallEvents.CallOfferReceived) {
            return this.handlers.onCallOfferReceived?.(sessionId, event);
        }
        if (event.type === CallEvents.DataChannelOpened) {
            this.runtime.markConnected(sessionId, event);
            return this.handlers.onDataChannelOpened?.(sessionId, event);
        }
        if (event.type === CallEvents.CallRingRequested) {
            return this.handlers.onCallRingRequested?.(sessionId, event);
        }
        if (event.type === CallEvents.CalleeAnswered) {
            return this.handlers.onCalleeAnswered?.(sessionId, event);
        }
        if (event.type === CallEvents.RouteStartRequested) {
            return this.handleRouteStartRequested(sessionId, event);
        }
        if (event.type === CallEvents.RouteConnected) {
            return this.handleRouteConnected(sessionId, event);
        }
        if (event.type === CallEvents.CallEndRequested) {
            return this.handleCallEndRequested(sessionId, event);
        }
        if (event.type === CallEvents.CallCancelRequested) {
            return this.handleCallCancelRequested(sessionId, event);
        }
        if (event.type === CallEvents.RemoteByeReceived) {
            return this.handleRemoteByeReceived(sessionId, event);
        }
        if (event.type === CallEvents.EndRenegotiationReceived) {
            return this.handleEndRenegotiationReceived(sessionId, event);
        }
        if (event.type === CallEvents.DtmfReceived) {
            return this.handleDtmfReceived(sessionId, event);
        }
        if (event.type === CallEvents.CallFailed) {
            return this.handleCallFailed(sessionId, event);
        }
        if (event.type === CallEvents.SessionDestroyRequested) {
            return this.runtime.destroyRuntimeSession(sessionId, event);
        }
        throw new Error(`Unsupported call event: ${event.type || "unknown"}`);
    }

    getStrategy(context, event = {}) {
        const route = event.route || event.destination?.route || context.session.routeDestination?.route ||
            (event.source === CallEventSources.OpenAi ? "openai-sip" : null) ||
            (event.source === CallEventSources.Sip ? "sbc" : null);
        if (!route) return null;
        if (this.routeStrategies?.require) return this.routeStrategies.require(route);
        throw new Error(`No route strategy available for route: ${route || "unknown"}`);
    }

    async handleRemoteByeReceived(sessionId, event) {
        if (![CallEventSources.Sip, CallEventSources.OpenAi].includes(event.source)) {
            throw new Error(`REMOTE_BYE_RECEIVED unsupported source: ${event.source}`);
        }
        const started = this.runtime.markRemoteEndStarted(sessionId, event);
        if (started.duplicate) {
            this.logger.log(`[${sessionId}] Duplicate remote BYE ignored source=${event.source}`);
            return { handled: true, duplicate: true };
        }

        const strategy = this.getStrategy(started, event);
        if (strategy?.handleRemoteEnd) await strategy.handleRemoteEnd(started, event);
        else if (strategy?.endFromRemote) await strategy.endFromRemote(started, event);
        this.runtime.markRemoteEndCompleted(sessionId, event);
        this.runtime.notifyClientEnded(sessionId, event);
        this.runtime.notifyLinkedSessionEnded(sessionId, event);
        this.logger.log(`[${sessionId}] Remote BYE handled through CallEngine source=${event.source}`);
        return { handled: true, duplicate: false };
    }

    async handleRouteStartRequested(sessionId, event) {
        this.runtime.attachRoute(sessionId, event.destination);
        const context = this.runtime.requireContext(sessionId);
        const strategy = this.getStrategy(context, event);
        return strategy?.start ? strategy.start(context, event) : undefined;
    }

    async handleRouteConnected(sessionId, event) {
        const context = this.runtime.markInCall(sessionId, event);
        const strategy = this.getStrategy(context, event);
        return strategy?.connect ? strategy.connect(context, event) : undefined;
    }

    async handleCallEndRequested(sessionId, event) {
        const context = this.runtime.markPostCall(sessionId, {
            ...event,
            endCallRenegDone: false,
        });
        const strategy = this.getStrategy(context, event);
        if (event.notifyClient) this.runtime.notifyCallEnd(sessionId, event);
        this.runtime.notifyOwnedWebRtcLegsCallEnd(sessionId, event);
        if (event.propagateLinkedSession) this.runtime.propagateLinkedEvent(sessionId, event);
        if (strategy?.end) await strategy.end(context, event);
        return { handled: true };
    }

    async handleCallCancelRequested(sessionId, event) {
        const context = this.runtime.markCancelling(sessionId, event);
        this.runtime.markCancelled(sessionId, event);
        const strategy = this.getStrategy(context, event);
        if (event.notifyClient !== false) this.runtime.notifyCallEnd(sessionId, event);
        this.runtime.notifyOwnedWebRtcLegsCallEnd(sessionId, event);
        if (event.propagateLinkedSession) this.runtime.propagateLinkedEvent(sessionId, event);
        if (strategy?.cancel) await strategy.cancel(context, event);
        return { handled: true };
    }

    async handleEndRenegotiationReceived(sessionId, event) {
        const result = await this.handlers.onEndRenegotiationReceived?.(sessionId, event);
        this.runtime.markPostCall(sessionId, {
            ...event,
            reason: event.reason || "end-call-renegotiated",
            endCallRenegDone: true,
        });
        return result;
    }

    async handleCallFailed(sessionId, event) {
        const context = this.runtime.markFailed(sessionId, event);
        const strategy = this.getStrategy(context, event);
        this.runtime.notifyCallEnd(sessionId, event);
        this.runtime.notifyOwnedWebRtcLegsCallEnd(sessionId, event);
        if (strategy?.fail) await strategy.fail(context, event);
        return { handled: true };
    }

    async handleDtmfReceived(sessionId, event) {
        const context = this.runtime.requireContext(sessionId);
        const strategy = this.getStrategy(context, event);
        if (!strategy?.handleDtmf) return { handled: false };
        const result = await strategy.handleDtmf(context, event);
        this.runtime.notifyCallAck(sessionId, {
            ackFor: "dtmf",
            payload: result?.ackPayload || {},
        });
        return { handled: true };
    }
}

module.exports = {
    CallEngine,
};
