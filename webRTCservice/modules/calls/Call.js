const { CALL_STATES, CallStateMachine } = require("./CallStateMachine");

class Call {
    constructor({
        id,
        caller,
        target = null,
        participants = [],
        state = CALL_STATES.Handshake,
        features = {},
        mediaGraph = null,
        metadata = {},
        logger = console,
    } = {}) {
        if (!id) throw new Error("Call requires id");
        if (!caller) throw new Error("Call requires caller participant");
        this.id = id;
        this.caller = caller;
        this.target = target;
        this.participants = new Map();
        this.stateMachine = new CallStateMachine({ initialState: state, logger });
        this.features = features;
        this.mediaGraph = mediaGraph;
        this.metadata = {
            createdAt: Date.now(),
            answeredAt: null,
            endedAt: null,
            cancellation: null,
            ...metadata,
        };
        this.logger = logger;
        this.addParticipant(caller);
        if (target) this.addParticipant(target);
        for (const participant of participants) this.addParticipant(participant);
    }

    get state() {
        return this.stateMachine.state;
    }

    addParticipant(participant) {
        this.participants.set(participant.id, participant);
        if (participant.role === "caller") this.caller = participant;
        if (participant.role === "target") this.target = participant;
        return participant;
    }

    participant(id) {
        return this.participants.get(id) || null;
    }

    transition(state, reason) {
        return this.stateMachine.transition(state, reason);
    }

    setMediaGraph(mediaGraph) {
        this.mediaGraph = mediaGraph;
        return this;
    }

    markAnswered() {
        this.metadata.answeredAt = Date.now();
        this.transition(CALL_STATES.InCall, "answered");
    }

    markEnding(reason = "end") {
        this.metadata.endedAt = Date.now();
        this.transition(CALL_STATES.Ending, reason);
    }

    markPostCall(reason = "post-call") {
        this.metadata.endedAt = this.metadata.endedAt || Date.now();
        this.transition(CALL_STATES.PostCall, reason);
    }

    markCancelling(cancellation) {
        this.metadata.cancellation = {
            at: Date.now(),
            ...cancellation,
        };
        this.transition(CALL_STATES.Cancelling, cancellation?.reason || "cancel");
    }

    markCancelled(cancellation = null) {
        if (cancellation) {
            this.metadata.cancellation = {
                at: Date.now(),
                ...cancellation,
            };
        }
        this.metadata.endedAt = Date.now();
        this.transition(CALL_STATES.Cancelled, this.metadata.cancellation?.reason || "cancelled");
    }

    health() {
        return {
            id: this.id,
            state: this.state,
            participants: [...this.participants.values()].map((p) => ({
                id: p.id,
                role: p.role,
                identity: p.identity?.label ? p.identity.label() : p.identity,
                route: p.route?.route || p.route || null,
            })),
            media: this.mediaGraph?.health ? this.mediaGraph.health() : null,
            metadata: this.metadata,
        };
    }
}

module.exports = {
    Call,
};
