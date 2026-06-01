class IvrIdentity {
    constructor({ target = "ivr", serviceId = null } = {}) {
        this.type = "ivr";
        this.target = target;
        this.serviceId = serviceId;
    }

    label() {
        return this.target;
    }
}

module.exports = {
    IvrIdentity,
};
