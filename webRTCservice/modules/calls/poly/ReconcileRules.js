// Pure policy: given a snapshot of both legs' states (+ whether media is wired),
// return the ordered list of actions the PolySession should perform. No I/O, no
// transports -> trivially unit-testable. Adding a scenario = adding/adjusting a
// rule here; nothing else changes (OCP).
//
// Priority (highest first):
//   1. teardown  - any leg ending/canceling/rejecting/failed/disconnected
//   2. progress  - someone is trying to reach the other (calling/ringing/answering)
//   3. steady    - both in call (keep media) / both idle (do nothing)

const { LEG_STATES, isTeardown, needsEnding, canBeRung, callViable } = require("./states");

// A leg that wants a call (driving the peer toward it).
function isCaller(state) {
    return state === LEG_STATES.CALLING || state === LEG_STATES.RINGING;
}
const { LEG_INTENTS } = require("./ports");

// Action constructors (plain data; PolySession resolves leg refs + executes).
function intent(leg, name, from = null) {
    return { kind: "intent", leg, intent: name, from };
}
function media(op) {
    return { kind: "media", op };
}

// `snapshot` = { a: {state, kind}, b: {state, kind}, mediaConnected }
// `event` = the leg state-change that triggered this pass ({ state, cause, ... }),
//           used to fire one-shot reactions (e.g. ack a fresh ring).
function reconcile(snapshot, event = null) {
    const { a, b, mediaConnected } = snapshot;
    const actions = [];

    // ---- 1. Teardown / end-of-call (highest priority) ---------------------
    const teardown = [];
    // Media is up only while the full call is up. Any other shape -> drop it.
    if (mediaConnected && !(a.state === LEG_STATES.IN_CALL && b.state === LEG_STATES.IN_CALL)) {
        teardown.push(media("disconnect"));
    }
    // A client asked to end -> P acks it (the leg answers the end-call reneg and
    // returns to connected). The transport decides HOW; P decides WHEN.
    if (a.state === LEG_STATES.END_REQUESTED) teardown.push(intent("a", LEG_INTENTS.ACK_END, "self"));
    if (b.state === LEG_STATES.END_REQUESTED) teardown.push(intent("b", LEG_INTENTS.ACK_END, "self"));
    // End a leg whose call can no longer work. Two triggers, deduped:
    //   - the peer is tearing down and this leg still holds an active call
    //     (covers pre-answer cancel/reject + a mid-call drop), OR
    //   - this leg is IN_CALL but the peer is no longer call-viable (idle
    //     connected / failed / disconnected / end-requested) -- you cannot be in a
    //     call by yourself. A ringing/answering peer IS viable (pickup in flight).
    const toEnd = new Set();
    if (isTeardown(a.state) && needsEnding(b.state)) toEnd.add("b");
    if (isTeardown(b.state) && needsEnding(a.state)) toEnd.add("a");
    if (a.state === LEG_STATES.IN_CALL && !callViable(b.state)) toEnd.add("a");
    if (b.state === LEG_STATES.IN_CALL && !callViable(a.state)) toEnd.add("b");
    for (const ref of toEnd) {
        teardown.push(intent(ref, LEG_INTENTS.END, ref === "a" ? "b" : "a"));
    }
    if (teardown.length) return teardown;

    // ---- 2. Progress ------------------------------------------------------
    // Simultaneous offers (glare): both sides are actively calling each other.
    // Resolve deterministically by finalizing both legs via ANSWER intents and
    // bringing media up once. This reuses the normal answer plumbing end-to-end.
    if (a.state === LEG_STATES.CALLING && b.state === LEG_STATES.CALLING) {
        actions.push(intent("a", LEG_INTENTS.ANSWER, "b"));
        actions.push(intent("b", LEG_INTENTS.ANSWER, "a"));
        if (!mediaConnected) actions.push(media("connect"));
        return actions;
    }

    // (2a) Ack a *fresh* ring (caller's client offered -> CALLING). A leg only
    // enters CALLING from a client offer, so a CALLING-typed event marks exactly
    // one fresh ring -> ackConnected once (tells the client we heard it so it
    // stops re-offering). Later passes carry a different event, so we never
    // re-ack the same ring; no persistent guard => two rings => two acks.
    if (event && event.state === LEG_STATES.CALLING) {
        if (a.state === LEG_STATES.CALLING) actions.push(intent("a", LEG_INTENTS.ACK_CONNECTED, "self"));
        if (b.state === LEG_STATES.CALLING) actions.push(intent("b", LEG_INTENTS.ACK_CONNECTED, "self"));
    }
    // (2b) The peer just started ringing -> tell the caller (webrtc: no-op; sip:
    // a real 180). Gated on the RINGING event so it fires once per ring.
    if (event && event.state === LEG_STATES.RINGING) {
        if (a.state === LEG_STATES.RINGING && isCaller(b.state)) actions.push(intent("b", LEG_INTENTS.ACK_RING, "a"));
        if (b.state === LEG_STATES.RINGING && isCaller(a.state)) actions.push(intent("a", LEG_INTENTS.ACK_RING, "b"));
    }

    // One side reached in-call while the peer is still ringing/calling -> they
    // picked up: finalize the peer (flush its held answer) and bridge media.
    const aReaching = isCaller(b.state);
    const bReaching = isCaller(a.state);
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
    // One side wants a call and the peer is reachable. Two-phase:
    //   peer DISCONNECTED -> bring its transport up first (connect: callee FCM
    //     session offer / sip nothing-to-do). The peer stays connecting until its
    //     transport-open ingress lands, then this rule fires again to ring it.
    //   peer CONNECTED/ended/... (transport up, idle) -> present the call (ring:
    //     audio offer over its DC / sip INVITE).
    if (isCaller(a.state)) {
        if (b.state === LEG_STATES.DISCONNECTED) { actions.push(intent("b", LEG_INTENTS.CONNECT, "a")); return actions; }
        if (canBeRung(b.state)) { actions.push(intent("b", LEG_INTENTS.RING, "a")); return actions; }
    }
    if (isCaller(b.state)) {
        if (a.state === LEG_STATES.DISCONNECTED) { actions.push(intent("a", LEG_INTENTS.CONNECT, "b")); return actions; }
        if (canBeRung(a.state)) { actions.push(intent("a", LEG_INTENTS.RING, "b")); return actions; }
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
