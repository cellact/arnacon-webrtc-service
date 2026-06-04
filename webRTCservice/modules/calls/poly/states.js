// SessionLeg state vocabulary (flat, explicit). A leg owns its own state; the
// PolySession only reads it. "Everything that isn't disconnected/connecting is
// connected" -- so we never add redundant connected-while-X states.

const LEG_STATES = Object.freeze({
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    CALLING: "calling",
    RINGING: "ringing",
    ANSWERING: "answering",
    IN_CALL: "inCall",
    ENDING: "ending",
    ENDED: "ended",
    CANCELING: "canceling",
    CANCELED: "canceled",
    REJECTING: "rejecting",
    REJECTED: "rejected",
    FAILED: "failed",
});

const ALL_STATES = Object.freeze(Object.values(LEG_STATES));

// Teardown intent is in flight or the transport dropped: highest priority for p.
// NOTE: DISCONNECTED is the *initial* (never-connected) state, NOT a teardown --
// otherwise a fresh callee leg (which starts disconnected) would be mistaken for a
// drop and PolySession would end the caller instead of connecting the callee. An
// actual mid-call transport loss escalates to FAILED (see SessionLeg TRANSPORT_CLOSE).
const TEARDOWN_STATES = Object.freeze(new Set([
    LEG_STATES.ENDING,
    LEG_STATES.CANCELING,
    LEG_STATES.REJECTING,
    LEG_STATES.FAILED,
]));

// A call worth tearing down exists on this leg.
const ACTIVE_CALL_STATES = Object.freeze(new Set([
    LEG_STATES.CALLING,
    LEG_STATES.RINGING,
    LEG_STATES.ANSWERING,
    LEG_STATES.IN_CALL,
    LEG_STATES.ENDING,
]));

// Transport is up and there is no active call attempt -> can be rung again.
const RUNGABLE_STATES = Object.freeze(new Set([
    LEG_STATES.CONNECTED,
    LEG_STATES.ENDED,
    LEG_STATES.CANCELED,
    LEG_STATES.REJECTED,
]));

const PROGRESS_STATES = Object.freeze(new Set([
    LEG_STATES.CALLING,
    LEG_STATES.RINGING,
    LEG_STATES.ANSWERING,
]));

function isValidState(state) {
    return ALL_STATES.includes(state);
}

function isTeardown(state) {
    return TEARDOWN_STATES.has(state);
}

function isActiveCall(state) {
    return ACTIVE_CALL_STATES.has(state);
}

// A peer worth ending: it holds a live call AND isn't already tearing down.
function needsEnding(state) {
    return ACTIVE_CALL_STATES.has(state) && !TEARDOWN_STATES.has(state);
}

function canBeRung(state) {
    return RUNGABLE_STATES.has(state);
}

function isProgress(state) {
    return PROGRESS_STATES.has(state);
}

// Transport is usable for signaling (not still negotiating / not gone).
function hasLiveTransport(state) {
    return state !== LEG_STATES.DISCONNECTED && state !== LEG_STATES.CONNECTING;
}

module.exports = {
    LEG_STATES,
    ALL_STATES,
    TEARDOWN_STATES,
    ACTIVE_CALL_STATES,
    RUNGABLE_STATES,
    PROGRESS_STATES,
    isValidState,
    isTeardown,
    isActiveCall,
    needsEnding,
    canBeRung,
    isProgress,
    hasLiveTransport,
};
