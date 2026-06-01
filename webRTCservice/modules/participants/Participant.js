class Participant {
    constructor({
        id,
        role,
        identity,
        route = null,
        signaling = null,
        media = null,
        policies = {},
        runtime = {},
    } = {}) {
        if (!id) throw new Error("Participant requires id");
        if (!role) throw new Error("Participant requires role");
        if (!identity) throw new Error("Participant requires identity");
        this.id = id;
        this.role = role;
        this.identity = identity;
        this.route = route;
        this.signaling = signaling;
        this.media = media;
        this.policies = policies;
        this.runtime = runtime;
    }

    setRoute(route) {
        this.route = route;
        return this;
    }

    setSignaling(signaling) {
        this.signaling = signaling;
        return this;
    }

    setMedia(media) {
        this.media = media;
        return this;
    }

    updateRuntime(values = {}) {
        Object.assign(this.runtime, values);
        return this;
    }
}

module.exports = {
    Participant,
};
