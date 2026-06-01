const { Call } = require("./Call");
const { ParticipantFactory } = require("../participants/ParticipantFactory");

class CallFactory {
    constructor({
        participantFactory = null,
        parseAddress = null,
        logger = console,
    } = {}) {
        this.participantFactory = participantFactory || new ParticipantFactory({ parseAddress, logger });
        this.logger = logger;
    }

    create({ id, caller, target = null, participants = [], state, features, mediaGraph, metadata } = {}) {
        return new Call({
            id,
            caller,
            target,
            participants,
            state,
            features,
            mediaGraph,
            metadata,
            logger: this.logger,
        });
    }

    fromSession(session) {
        const caller = this.participantFactory.fromSession(session, "caller");
        const target = session.toIdentity
            ? this.participantFactory.fromSession(session, "target")
            : null;
        return this.create({
            id: session.callId || session.sessionId,
            caller,
            target,
            state: session.phase,
            metadata: {
                sessionId: session.sessionId,
                createdAt: session.createdAt,
            },
        });
    }
}

module.exports = {
    CallFactory,
};
