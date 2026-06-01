class EmailIdentity {
    constructor({ email, serviceId = null } = {}) {
        if (!email) throw new Error("EmailIdentity requires email");
        this.type = "email";
        this.email = String(email).toLowerCase();
        this.serviceId = serviceId;
    }

    label() {
        return this.email;
    }
}

module.exports = {
    EmailIdentity,
};
