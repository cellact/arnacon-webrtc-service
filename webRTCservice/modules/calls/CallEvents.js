const CallEvents = Object.freeze({
    CallOfferReceived: "call-offer-received",
    DataChannelOpened: "data-channel-opened",
    CallRingRequested: "call-ring-requested",
    RouteResolved: "route-resolved",
    RouteStartRequested: "route-start-requested",
    CalleeAnswered: "callee-answered",
    RouteConnected: "route-connected",
    CallEndRequested: "call-end-requested",
    CallCancelRequested: "call-cancel-requested",
    RemoteByeReceived: "remote-bye-received",
    EndRenegotiationReceived: "end-renegotiation-received",
    DtmfReceived: "dtmf-received",
    CallFailed: "call-failed",
    SessionDestroyRequested: "session-destroy-requested",
});

const CallEventSources = Object.freeze({
    Client: "client",
    Http: "http",
    Sip: "sip",
    OpenAi: "openai",
    Ivr: "ivr",
    WebRtc: "webrtc",
    Multiring: "multiring",
    Route: "route",
    Media: "media",
    System: "system",
});

const EVENT_REQUIRED_FIELDS = Object.freeze({
    [CallEvents.CallOfferReceived]: Object.freeze(["type", "source", "payload"]),
    [CallEvents.DataChannelOpened]: Object.freeze(["type", "source"]),
    [CallEvents.CallRingRequested]: Object.freeze(["type", "source", "payload"]),
    [CallEvents.RouteResolved]: Object.freeze(["type", "source", "destination"]),
    [CallEvents.RouteStartRequested]: Object.freeze(["type", "source", "destination"]),
    [CallEvents.CalleeAnswered]: Object.freeze(["type", "source", "payload"]),
    [CallEvents.RouteConnected]: Object.freeze(["type", "source"]),
    [CallEvents.CallEndRequested]: Object.freeze(["type", "source", "reason"]),
    [CallEvents.CallCancelRequested]: Object.freeze(["type", "source", "reason"]),
    [CallEvents.RemoteByeReceived]: Object.freeze(["type", "source", "reason"]),
    [CallEvents.EndRenegotiationReceived]: Object.freeze(["type", "source", "payload"]),
    [CallEvents.DtmfReceived]: Object.freeze(["type", "source", "payload"]),
    [CallEvents.CallFailed]: Object.freeze(["type", "source", "reason", "error"]),
    [CallEvents.SessionDestroyRequested]: Object.freeze(["type", "source", "reason"]),
});

const REMOTE_BYE_REQUIRED_FIELDS = EVENT_REQUIRED_FIELDS[CallEvents.RemoteByeReceived];

function validateCallEvent(event = {}) {
    const required = EVENT_REQUIRED_FIELDS[event.type];
    if (!required) throw new Error(`Unsupported call event: ${event.type || "unknown"}`);
    for (const field of required) {
        if (event[field] === undefined || event[field] === null || event[field] === "") {
            throw new Error(`${event.type} missing required field: ${field}`);
        }
    }
    return true;
}

function createRemoteByeReceivedEvent({
    source,
    reason = "remote-bye",
    remoteDialogId = null,
    notifyClient = true,
    propagateLinkedSession = true,
    at = Date.now(),
} = {}) {
    return {
        type: CallEvents.RemoteByeReceived,
        source,
        reason,
        remoteDialogId,
        notifyClient,
        propagateLinkedSession,
        at,
    };
}

module.exports = {
    CallEvents,
    CallEventSources,
    EVENT_REQUIRED_FIELDS,
    REMOTE_BYE_REQUIRED_FIELDS,
    validateCallEvent,
    createRemoteByeReceivedEvent,
};
