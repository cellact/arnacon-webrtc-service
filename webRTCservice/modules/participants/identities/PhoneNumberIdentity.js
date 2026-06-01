class PhoneNumberIdentity {
    constructor({ number, raw = null, serviceId = null } = {}) {
        if (!number) throw new Error("PhoneNumberIdentity requires number");
        this.type = "phone-number";
        this.number = String(number);
        this.raw = raw || this.number;
        this.serviceId = serviceId;
    }

    label() {
        return this.number;
    }
}

module.exports = {
    PhoneNumberIdentity,
};
