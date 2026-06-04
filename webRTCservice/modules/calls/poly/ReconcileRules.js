// Pure policy: given a snapshot of both legs' states (+ whether media is wired),
// return the ordered list of actions the PolySession should perform. No I/O, no
// transports -> trivially unit-testable. Adding a scenario = adding/adjusting a
// rule here; nothing else changes (OCP).
//
// Priority (highest first):
//   1. teardown  - any leg ending/canceling/rejecting/failed/disconnected
//   2. progress  - someone is trying to reach the other (calling/ringing/answering)
//   3. steady    - both in call (keep media) / both idle (do nothing)

const { LEG_STATES, isTeardown, needsEnding, canBeRung } = require("./states");
const { LEG_INTENTS } = require("./ports");

// Action constructors (plain data; PolySession resolves leg refs + executes).
function intent(leg, name, from = null) {
    return { kind: "intent", leg, intent: name, from };
}
function media(op) {
    return { kind: "media", op };
}

// `snapshot` = { a: {state, kind}, b: {state, kind}, mediaConnected }
function reconcile(snapshot) {
    const { a, b, mediaConnected } = snapshot;
    const actions = [];

    // ---- 1. Teardown ------------------------------------------------------
    const aTear = isTeardown(a.state);
    const bTear = isTeardown(b.state);
    if (aTear || bTear) {
        if (mediaConnected) actions.push(media("disconnect"));
        // If a leg is tearing down and the peer still holds an active call, end
        // the peer's call, attributing it to the tearing side. We don't care WHY
        // the side dropped -- the priority is to stop the peer from "being in a
        // call" with no one on the other end.
        if (aTear && needsEnding(b.state)) actions.push(intent("b", LEG_INTENTS.END, "a"));
        if (bTear && needsEnding(a.state)) actions.push(intent("a", LEG_INTENTS.END, "b"));
        return actions;
    }

    // ---- 2. Progress ------------------------------------------------------
    // Ack a client that offered/rang us (CALLING) so it stops re-offering while
    // we reach the peer. P decides WHEN (here); the leg decides HOW and is
    // idempotent, so emitting this on every pass while CALLING is safe.
    if (a.state === LEG_STATES.CALLING) actions.push(intent("a", LEG_INTENTS.ACK, "self"));
    if (b.state === LEG_STATES.CALLING) actions.push(intent("b", LEG_INTENTS.ACK, "self"));

    // One side reached in-call while the peer is still ringing/calling -> they
    // picked up: finalize the peer (send ack / apply answer) and bridge media.
    const aReaching = b.state === LEG_STATES.RINGING || b.state === LEG_STATES.CALLING;
    const bReaching = a.state === LEG_STATES.RINGING || a.state === LEG_STATES.CALLING;
    if (a.state === LEG_STATES.IN_CALL && aReaching) {
        actions.push(intent("b", LEG_INTENTS.ANSWER, "a"));
        if (!mediaConnected) actions.push(media("connect"));
        return actions;
    }
    if (b.state === LEG_STATES.IN_CALL && bReaching) {
        actions.push(intent("a", LEG_INTENTS.ANSWER, "b"));
        if (!mediaConnected) actions.push(media("connect"));
        return actions;
    }
    // One side wants a call and the other is reachable but idle -> ring it.
    if ((a.state === LEG_STATES.CALLING || a.state === LEG_STATES.RINGING) && canBeRung(b.state)) {
        actions.push(intent("b", LEG_INTENTS.RING, "a"));
        return actions;
    }
    if ((b.state === LEG_STATES.CALLING || b.state === LEG_STATES.RINGING) && canBeRung(a.state)) {
        actions.push(intent("a", LEG_INTENTS.RING, "b"));
        return actions;
    }

    // ---- 3. Steady --------------------------------------------------------
    if (a.state === LEG_STATES.IN_CALL && b.state === LEG_STATES.IN_CALL) {
        if (!mediaConnected) actions.push(media("connect"));
        return actions;
    }

    // Anything else: nothing to do. (e.g. one connected, one disconnected and idle)
    return actions;
}

module.exports = {
    reconcile,
    intent,
    media,
};
