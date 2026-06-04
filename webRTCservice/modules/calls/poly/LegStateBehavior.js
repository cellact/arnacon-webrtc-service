// State pattern: one behavior object per leg state. It declares which intents are
// legal in that state and an optional onEnter hook. Centralizing legality here
// means concrete legs (WebRtcLeg/SipLeg) never re-implement per-state rules, and
// illegal intents throw in exactly one place (no silent no-ops).

const { LEG_STATES } = require("./states");
const { LEG_INTENTS } = require("./ports");

const I = LEG_INTENTS;

// Allowed intents per state. An intent not listed throws when attempted.
const LEGALITY = Object.freeze({
    [LEG_STATES.DISCONNECTED]: [I.CONNECT],
    // Teardown can interrupt a connect (caller cancels before the callee's PC is up).
    [LEG_STATES.CONNECTING]: [I.CONNECT, I.CANCEL, I.END],
    [LEG_STATES.CONNECTED]: [I.CONNECT, I.RING, I.END, I.CANCEL],
    [LEG_STATES.CALLING]: [I.RING, I.ACK_CONNECTED, I.ACK_RING, I.ANSWER, I.END, I.CANCEL, I.REJECT],
    [LEG_STATES.RINGING]: [I.RING, I.ACK_CONNECTED, I.ACK_RING, I.ANSWER, I.END, I.CANCEL, I.REJECT],
    [LEG_STATES.ANSWERING]: [I.ANSWER, I.END, I.CANCEL],
    [LEG_STATES.IN_CALL]: [I.END],
    [LEG_STATES.ENDING]: [I.END],
    [LEG_STATES.ENDED]: [I.CONNECT, I.RING],
    [LEG_STATES.CANCELING]: [I.CANCEL],
    [LEG_STATES.CANCELED]: [I.CONNECT, I.RING],
    [LEG_STATES.REJECTING]: [I.REJECT],
    [LEG_STATES.REJECTED]: [I.CONNECT, I.RING],
    [LEG_STATES.FAILED]: [I.CONNECT],
});

class LegStateBehavior {
    constructor(state, allowedIntents) {
        this.state = state;
        this.allowed = new Set(allowedIntents);
        Object.freeze(this);
    }

    allows(intent) {
        return this.allowed.has(intent);
    }

    // Hook for subclasses/legs that want to react on entry. Default no-op.
    onEnter() {}
}

const BEHAVIORS = Object.freeze(
    Object.fromEntries(
        Object.entries(LEGALITY).map(([state, intents]) => [state, new LegStateBehavior(state, intents)]),
    ),
);

function behaviorFor(state) {
    const behavior = BEHAVIORS[state];
    if (!behavior) throw new Error(`No LegStateBehavior for unknown state "${state}"`);
    return behavior;
}

function assertIntentLegal(state, intent) {
    if (!behaviorFor(state).allows(intent)) {
        throw new Error(`Illegal intent "${intent}" while leg state is "${state}"`);
    }
}

function isIntentLegal(state, intent) {
    return behaviorFor(state).allows(intent);
}

module.exports = {
    LegStateBehavior,
    behaviorFor,
    assertIntentLegal,
    isIntentLegal,
    LEGALITY,
};
