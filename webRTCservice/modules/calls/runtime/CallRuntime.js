const { CALL_STATES } = require("../CallStateMachine");
const { SessionResourceRegistry } = require("./SessionResources");

class CallRuntime {
    constructor({
        sessions,
        callRegistry,
        sendDataChannelMessage,
        enqueueSignaling,
        destroySession = null,
        teardownHandlers = [],
        logger = console,
    } = {}) {
        if (!sessions) throw new Error("CallRuntime requires sessions");
        this.sessions = sessions;
        this.callRegistry = callRegistry || null;
        this.sendDataChannelMessage = sendDataChannelMessage;
        this.enqueueSignaling = enqueueSignaling;
        this.destroySession = destroySession;
        this.teardownHandlers = teardownHandlers;
        this.logger = logger;
        this.resources = new SessionResourceRegistry({ sessions, logger });
    }

    setCallEventDispatcher(dispatcher) {
        this.callEventDispatcher = dispatcher;
    }

    requireContext(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        return {
            sessionId,
            session,
            call: this.callRegistry?.getBySession?.(sessionId) || null,
            resources: this.resources.forSession(sessionId),
        };
    }

    setLifecycleState(sessionId, state, reason = "lifecycle") {
        const context = this.requireContext(sessionId);
        const { session, call } = context;
        if (call) {
            try {
                if (state === CALL_STATES.PostCall) {
                    call.markPostCall(reason);
                } else {
                    call.transition(state, reason);
                }
            } catch (err) {
                this.logger.warn(`[${sessionId}] Call lifecycle transition failed: ${err.message}`);
            }
        }
        session.phase = state;
        return context;
    }

    setTeardownState(session, state, reason = null) {
        if (!session.lifecycle) session.lifecycle = {};
        session.lifecycle.teardown = {
            state,
            reason,
            updatedAt: Date.now(),
        };
    }

    markWaitingForDataChannel(sessionId, event = {}) {
        return this.setLifecycleState(sessionId, CALL_STATES.WaitingForDataChannel, event.reason || "waiting-for-dc");
    }

    markConnected(sessionId, event = {}) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.Connected, event.reason || "connected");
        context.session.callEndInProgress = false;
        context.session.endCallRenegDone = false;
        this.setTeardownState(context.session, "idle", event.reason || "connected");
        return context;
    }

    markRinging(sessionId, event = {}) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.Ringing, event.reason || "ringing");
        context.session.callEndInProgress = false;
        context.session.endCallRenegDone = false;
        this.setTeardownState(context.session, "idle", event.reason || "ringing");
        return context;
    }

    markInCall(sessionId, event = {}) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.InCall, event.reason || "in-call");
        context.session.callEndInProgress = false;
        context.session.endCallRenegDone = false;
        this.setTeardownState(context.session, "idle", event.reason || "in-call");
        context.call?.markAnswered?.();
        return context;
    }

    markPostCall(sessionId, event = {}) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.PostCall, event.reason || "post-call");
        context.session.callEndInProgress = true;
        if (event.endCallRenegDone !== undefined) {
            context.session.endCallRenegDone = Boolean(event.endCallRenegDone);
        }
        this.setTeardownState(
            context.session,
            event.endCallRenegDone ? "done" : "awaiting-end-renegotiation",
            event.reason || "post-call",
        );
        return context;
    }

    markCancelling(sessionId, event = {}) {
        const context = this.requireContext(sessionId);
        const cancellation = {
            source: event.source || "unknown",
            reason: event.reason || "cancel",
        };
        try { context.call?.markCancelling?.(cancellation); } catch (err) {
            this.logger.warn(`[${sessionId}] Call cancelling transition failed: ${err.message}`);
        }
        context.session.callEndInProgress = true;
        context.session.endCallRenegDone = false;
        context.session.cancelReason = cancellation.reason;
        context.session.phase = CALL_STATES.Cancelling;
        this.setTeardownState(context.session, "cancelling", cancellation.reason);
        return context;
    }

    markCancelled(sessionId, event = {}) {
        const context = this.requireContext(sessionId);
        const cancellation = {
            source: event.source || "unknown",
            reason: event.reason || "cancelled",
        };
        try { context.call?.markCancelled?.(cancellation); } catch (err) {
            this.logger.warn(`[${sessionId}] Call cancelled transition failed: ${err.message}`);
        }
        context.session.phase = CALL_STATES.PostCall;
        context.session.callEndInProgress = true;
        this.setTeardownState(context.session, "done", cancellation.reason);
        return context;
    }

    markFailed(sessionId, event = {}) {
        const context = this.markPostCall(sessionId, {
            reason: event.reason || "call-failed",
            endCallRenegDone: event.endCallRenegDone,
        });
        context.session.failure = {
            reason: event.reason || "call-failed",
            message: event.error?.message || String(event.error || ""),
            source: event.source || "unknown",
            at: Date.now(),
        };
        return context;
    }

    attachRoute(sessionId, destination) {
        const context = this.requireContext(sessionId);
        context.session.routeDestination = destination || null;
        context.session.call?.target?.setRoute?.(destination || null);
        return context;
    }

    attachPendingReoffer(sessionId, pendingReoffer) {
        const context = this.requireContext(sessionId);
        context.session.pendingReoffer = pendingReoffer || null;
        return context;
    }

    clearPendingReoffer(sessionId) {
        const context = this.requireContext(sessionId);
        context.session.pendingReoffer = null;
        return context;
    }

    resetForNewRing(sessionId, event = {}) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.Connected, event.reason || "new-ring");
        context.session.callEndInProgress = false;
        context.session.endCallRenegDone = false;
        context.session.signalingQueue = Promise.resolve();
        this.setTeardownState(context.session, "idle", event.reason || "new-ring");
        return context;
    }

    isEndRenegotiationPending(sessionOrId) {
        const session = typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
        if (!session) return false;
        return session.lifecycle?.teardown?.state === "awaiting-end-renegotiation" ||
            (session.callEndInProgress && !session.endCallRenegDone);
    }

    getSession(sessionOrId) {
        return typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
    }

    getSessionKind(sessionOrId) {
        const session = this.getSession(sessionOrId);
        if (!session) return "missing";
        if (session.openAiSalesAgent) return "openai-sales";
        if (session.ivr?.active) return "ivr";
        if (session.multiRingLeg) return "multiring-leg";
        if (session.outboundWebrtcLeg) return "gateway-outbound-leg";
        if (session.isGatewayCaller && session.inboundCall) return "gateway-inbound";
        if (session.isGatewayCaller) return "gateway";
        return "client";
    }

    isKind(sessionOrId, kind) {
        return this.getSessionKind(sessionOrId) === kind;
    }

    isRinging(sessionOrId) {
        return this.getSession(sessionOrId)?.phase === CALL_STATES.Ringing;
    }

    isInCall(sessionOrId) {
        return this.getSession(sessionOrId)?.phase === CALL_STATES.InCall;
    }

    isPostCall(sessionOrId) {
        return this.getSession(sessionOrId)?.phase === CALL_STATES.PostCall;
    }

    isTerminal(sessionOrId) {
        const session = this.getSession(sessionOrId);
        return !session || session.phase === CALL_STATES.PostCall || session.phase === CALL_STATES.Cancelled;
    }

    isTerminalForSipEvents(sessionOrId) {
        const session = this.getSession(sessionOrId);
        return !session || session.destroying || session.phase === CALL_STATES.PostCall || session.callEndInProgress === true;
    }

    shouldQueueEndCall(sessionOrId) {
        const session = this.getSession(sessionOrId);
        return Boolean(session && !this.isRinging(session) && !this.isEndRenegotiationPending(session));
    }

    shouldQueuePhase2Reoffer(sessionOrId) {
        return this.isEndRenegotiationPending(sessionOrId);
    }

    shouldAcceptOfferAsNewRing(sessionOrId) {
        return this.canAcceptNewRing(sessionOrId);
    }

    shouldApplyIceRestart(sessionOrId) {
        return this.isInCall(sessionOrId);
    }

    canAcceptNewRing(sessionOrId) {
        const session = typeof sessionOrId === "string" ? this.sessions.get(sessionOrId) : sessionOrId;
        if (!session) return false;
        return session.phase === CALL_STATES.PostCall || this.isEndRenegotiationPending(session);
    }

    notifyCallEnd(sessionId, event = {}) {
        if (typeof this.sendDataChannelMessage !== "function") return false;
        this.sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: event.action || "end",
            reason: event.reason,
            source: event.source,
        });
        return true;
    }

    notifyOwnedWebRtcLegsCallEnd(sessionId, event = {}) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        const message = JSON.stringify({
            msgType: "call",
            action: event.action || "end",
            reason: event.reason,
            source: event.source,
        });
        let sent = false;
        const notifyLeg = (leg) => {
            if (!leg?.dataChannel) {
                this.logger.warn(`[${sessionId}] Cannot send DC message to owned leg: no data channel on leg`);
                return;
            }
            if (leg.dataChannel.readyState !== "open") {
                this.logger.warn(`[${sessionId}] Cannot send DC message to owned leg: data channel not open (readyState=${leg.dataChannel.readyState})`);
                return;
            }
            try {
                const action = event.action || "end";
                this.logger.log(`[${sessionId}] DC-OUT(leg): msgType=call action=${action} phase=${leg.phase || "?"}`);
                leg.dataChannel.send(message);
                sent = true;
            } catch (err) {
                this.logger.error(`[${sessionId}] Failed to send DC message to owned leg: ${err.message}`);
            }
        };
        notifyLeg(session.outboundWebrtc);
        if (session.outboundWebrtcLegs?.values) {
            for (const leg of session.outboundWebrtcLegs.values()) notifyLeg(leg);
        }
        return sent;
    }

    notifyCallAck(sessionId, event = {}) {
        if (typeof this.sendDataChannelMessage !== "function") return false;
        this.sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "ack",
            ackFor: event.ackFor,
            ...(event.payload || {}),
        });
        return true;
    }

    propagateLinkedEvent(sessionId, event = {}) {
        return this.notifyLinkedSessionEnded(sessionId, {
            ...event,
            propagateLinkedSession: event.propagateLinkedSession !== false,
        });
    }

    async destroyRuntimeSession(sessionId, event = {}) {
        if (typeof this.destroySession !== "function") return false;
        try {
            await this.teardownRuntimeSession(sessionId, event);
        } catch (err) {
            this.logger.warn(`[${sessionId}] Runtime teardown before destroy failed: ${err.message}`);
        }
        this.destroySession(sessionId, event.notify === true);
        return true;
    }

    async teardownRuntimeSession(sessionId, event = {}) {
        const context = this.requireContext(sessionId);
        for (const handler of this.teardownHandlers) {
            if (typeof handler !== "function") continue;
            try {
                await Promise.resolve(handler(context, event));
            } catch (err) {
                this.logger.warn(`[${sessionId}] Runtime teardown handler failed: ${err.message}`);
            }
        }
        await context.resources?.stopAll?.(event.reason || "runtime-teardown");
        return context;
    }

    clearSipRouteState(sessionId, options = {}) {
        const context = this.requireContext(sessionId);
        return context.resources?.sipLeg?.().clear(options);
    }

    clearOpenAiRouteState(sessionId, options = {}) {
        const context = this.requireContext(sessionId);
        return context.resources?.openAiLeg?.().clear(options);
    }

    stopMedia(sessionId, reason = "media-stop") {
        const context = this.requireContext(sessionId);
        return context.resources?.mediaSession?.().stop(reason);
    }

    setSipHold(sessionId, enabled) {
        const context = this.requireContext(sessionId);
        context.resources?.sipLeg?.().setHold(enabled);
        return context;
    }

    markRemoteEndStarted(sessionId, event) {
        const context = this.requireContext(sessionId);
        const { session } = context;
        if (session.remoteEndInProgress || session.callEndInProgress) {
            return { ...context, duplicate: true };
        }
        session.remoteEndInProgress = true;
        session.callEndInProgress = true;
        session.endCallRenegDone = false;
        this.setTeardownState(session, "remote-ending", event.reason || "remote-bye");
        session.remoteEnd = {
            source: event.source,
            reason: event.reason,
            remoteDialogId: event.remoteDialogId || null,
            at: event.at || Date.now(),
        };
        return { ...context, duplicate: false };
    }

    markRemoteEndCompleted(sessionId, event) {
        const context = this.setLifecycleState(sessionId, CALL_STATES.PostCall, event.reason || "remote-bye");
        context.session.remoteEndCompleted = true;
        return context;
    }

    notifyClientEnded(sessionId, event) {
        if (!event.notifyClient || typeof this.sendDataChannelMessage !== "function") return false;
        this.sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "end",
            reason: event.reason || "remote-bye",
            source: event.source || "remote",
        });
        return true;
    }

    notifyLinkedSessionEnded(sessionId, event) {
        if (!event.propagateLinkedSession) return false;
        const context = this.requireContext(sessionId);
        const peerId = context.session.linkedSessionId;
        if (!peerId) return false;
        const peer = this.sessions.get(peerId);
        if (!peer || peer.callEndInProgress || peer.phase === CALL_STATES.PostCall) return false;
        if (typeof this.sendDataChannelMessage === "function") {
            this.sendDataChannelMessage(peerId, {
                msgType: "call",
                action: "end",
                reason: event.reason || "remote-bye",
                source: event.source || "remote",
            });
        }
        if (typeof this.enqueueSignaling === "function") {
            this.enqueueSignaling(peerId, "linked-remote-bye", () => {
                const linkedEvent = {
                    ...event,
                    reason: `linked-peer-remote-bye:${sessionId}`,
                    propagateLinkedSession: false,
                };
                if (typeof this.callEventDispatcher === "function") {
                    return this.callEventDispatcher(peerId, linkedEvent);
                }
                const started = this.markRemoteEndStarted(peerId, linkedEvent);
                if (!started.duplicate) this.markRemoteEndCompleted(peerId, linkedEvent);
                return started;
            });
        }
        return true;
    }
}

module.exports = {
    CallRuntime,
};
