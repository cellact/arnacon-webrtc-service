const CALL_STATES = Object.freeze({
    Handshake: "handshake",
    WaitingForDataChannel: "waiting-for-dc",
    Connected: "connected",
    Ringing: "ringing",
    InCall: "in-call",
    Cancelling: "cancelling",
    Cancelled: "cancelled",
    Ending: "ending",
    PostCall: "post-call",
});

const ALLOWED_TRANSITIONS = Object.freeze({
    [CALL_STATES.Handshake]: new Set([
        CALL_STATES.WaitingForDataChannel,
        CALL_STATES.Connected,
        CALL_STATES.Cancelling,
        CALL_STATES.Cancelled,
        CALL_STATES.PostCall,
    ]),
    [CALL_STATES.WaitingForDataChannel]: new Set([
        CALL_STATES.Connected,
        CALL_STATES.Cancelling,
        CALL_STATES.Cancelled,
        CALL_STATES.PostCall,
    ]),
    [CALL_STATES.Connected]: new Set([
        CALL_STATES.Ringing,
        CALL_STATES.InCall,
        CALL_STATES.Cancelling,
        CALL_STATES.Cancelled,
        CALL_STATES.PostCall,
    ]),
    [CALL_STATES.Ringing]: new Set([
        CALL_STATES.InCall,
        CALL_STATES.Cancelling,
        CALL_STATES.Cancelled,
        CALL_STATES.PostCall,
        CALL_STATES.Connected,
    ]),
    [CALL_STATES.InCall]: new Set([
        CALL_STATES.Ending,
        CALL_STATES.PostCall,
        CALL_STATES.Cancelling,
        CALL_STATES.Cancelled,
    ]),
    [CALL_STATES.Cancelling]: new Set([
        CALL_STATES.Cancelled,
        CALL_STATES.PostCall,
    ]),
    [CALL_STATES.Cancelled]: new Set([
        CALL_STATES.PostCall,
        CALL_STATES.Connected,
    ]),
    [CALL_STATES.Ending]: new Set([
        CALL_STATES.PostCall,
    ]),
    [CALL_STATES.PostCall]: new Set([
        CALL_STATES.Connected,
        CALL_STATES.Ringing,
        CALL_STATES.Cancelled,
    ]),
});

class CallStateMachine {
    constructor({ initialState = CALL_STATES.Handshake, logger = console } = {}) {
        this.state = initialState;
        this.logger = logger;
        this.history = [{ state: initialState, at: Date.now(), reason: "initial" }];
    }

    canTransition(nextState) {
        if (this.state === nextState) return true;
        return Boolean(ALLOWED_TRANSITIONS[this.state]?.has(nextState));
    }

    transition(nextState, reason = "state-transition") {
        if (!this.canTransition(nextState)) {
            const message = `Illegal call state transition ${this.state} -> ${nextState} (${reason})`;
            this.logger.warn(message);
            throw new Error(message);
        }
        if (this.state === nextState) return this.state;
        this.state = nextState;
        this.history.push({ state: nextState, at: Date.now(), reason });
        return this.state;
    }

    isBeforeAnswer() {
        return [
            CALL_STATES.Handshake,
            CALL_STATES.WaitingForDataChannel,
            CALL_STATES.Connected,
            CALL_STATES.Ringing,
        ].includes(this.state);
    }

    isTerminal() {
        return this.state === CALL_STATES.PostCall || this.state === CALL_STATES.Cancelled;
    }
}

module.exports = {
    CALL_STATES,
    CallStateMachine,
};
