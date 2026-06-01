class AddressParser {
    constructor({ callRouter }) {
        if (!callRouter) throw new Error("AddressParser requires callRouter");
        this.callRouter = callRouter;
    }

    parse(value, serviceId = null) {
        return this.callRouter.parseAddress(value, serviceId);
    }

    isRawEmail(value) {
        return this.callRouter.isRawEmail(value);
    }

    emailToEnsName(email, domain) {
        return this.callRouter.emailToEnsName(email, domain);
    }
}

module.exports = {
    AddressParser,
};
