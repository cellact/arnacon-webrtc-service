class CallRegistry {
    constructor({ logger = console } = {}) {
        this.calls = new Map();
        this.callsByParticipant = new Map();
        this.callsBySession = new Map();
        this.linkedCalls = new Map();
        this.pendingBridgeGroups = new Map();
        this.logger = logger;
    }

    add(call) {
        this.calls.set(call.id, call);
        for (const participant of call.participants.values()) {
            this.callsByParticipant.set(participant.id, call.id);
            const sessionId = participant.runtime?.sessionId;
            if (sessionId) this.callsBySession.set(sessionId, call.id);
        }
        this.logger.log(`[${call.id}] Call registered`);
        return call;
    }

    get(callId) {
        return this.calls.get(callId) || null;
    }

    getBySession(sessionId) {
        const callId = this.callsBySession.get(sessionId);
        return callId ? this.get(callId) : null;
    }

    getByParticipant(participantId) {
        const callId = this.callsByParticipant.get(participantId);
        return callId ? this.get(callId) : null;
    }

    linkCalls(aId, bId) {
        this.linkedCalls.set(aId, bId);
        this.linkedCalls.set(bId, aId);
    }

    getLinkedCall(callId) {
        const linkedId = this.linkedCalls.get(callId);
        return linkedId ? this.get(linkedId) : null;
    }

    remove(callId) {
        const call = this.calls.get(callId);
        if (!call) return false;
        this.calls.delete(callId);
        this.linkedCalls.delete(callId);
        for (const [id, linkedId] of this.linkedCalls.entries()) {
            if (linkedId === callId) this.linkedCalls.delete(id);
        }
        for (const participant of call.participants.values()) {
            this.callsByParticipant.delete(participant.id);
            const sessionId = participant.runtime?.sessionId;
            if (sessionId) this.callsBySession.delete(sessionId);
        }
        this.logger.log(`[${callId}] Call removed`);
        return true;
    }
}

module.exports = {
    CallRegistry,
};
