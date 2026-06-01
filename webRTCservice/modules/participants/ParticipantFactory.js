const { Participant } = require("./Participant");
const { ArnaconIdentity } = require("./identities/ArnaconIdentity");
const { PhoneNumberIdentity } = require("./identities/PhoneNumberIdentity");
const { EmailIdentity } = require("./identities/EmailIdentity");
const { OpenAiIdentity } = require("./identities/OpenAiIdentity");
const { IvrIdentity } = require("./identities/IvrIdentity");

class ParticipantFactory {
    constructor({ parseAddress = null, logger = console } = {}) {
        this.parseAddress = parseAddress;
        this.logger = logger;
    }

    identityFromValue(value, serviceId = null, overrides = {}) {
        const parsed = this.parseAddress ? this.parseAddress(value || "", serviceId) : null;
        const type = overrides.type || parsed?.type || "arnacon";
        if (type === "email") return new EmailIdentity({ email: parsed?.value || value, serviceId });
        if (type === "raw" || type === "unknown") {
            return new PhoneNumberIdentity({ number: parsed?.value || value, raw: value, serviceId });
        }
        if (type === "openai") return new OpenAiIdentity({ name: value || "openai", serviceId, mode: overrides.mode });
        if (type === "ivr") return new IvrIdentity({ target: value || "ivr", serviceId });
        return new ArnaconIdentity({
            name: parsed?.full || parsed?.value || value,
            walletAddress: overrides.walletAddress || null,
            serviceId,
            raw: value,
        });
    }

    create({
        id,
        role,
        identity,
        identityValue = null,
        serviceId = null,
        route = null,
        signaling = null,
        media = null,
        policies = {},
        runtime = {},
    } = {}) {
        const resolvedIdentity = identity || this.identityFromValue(identityValue, serviceId);
        return new Participant({
            id,
            role,
            identity: resolvedIdentity,
            route,
            signaling,
            media,
            policies,
            runtime,
        });
    }

    fromSession(session, role = "caller") {
        if (!session?.sessionId) throw new Error("Cannot create participant from missing session");
        const identityValue = role === "caller" ? session.callerEns : session.toIdentity;
        return this.create({
            id: `${session.sessionId}:${role}`,
            role,
            identityValue,
            serviceId: session.serviceId || null,
            runtime: {
                sessionId: session.sessionId,
                session,
            },
        });
    }
}

module.exports = {
    ParticipantFactory,
};
