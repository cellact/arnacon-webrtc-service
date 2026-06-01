class ArnaconIdentity {
    constructor({ name, walletAddress = null, serviceId = null, raw = null } = {}) {
        if (!name) throw new Error("ArnaconIdentity requires name");
        this.type = "arnacon";
        this.name = name;
        this.walletAddress = walletAddress;
        this.serviceId = serviceId;
        this.raw = raw || name;
    }

    label() {
        return this.name;
    }
}

module.exports = {
    ArnaconIdentity,
};
