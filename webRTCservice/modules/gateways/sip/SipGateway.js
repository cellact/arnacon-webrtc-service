class SipGateway {
    constructor({ sipClient, sessionStore, logger = console } = {}) {
        if (!sipClient) throw new Error("SipGateway requires sipClient");
        if (!sessionStore) throw new Error("SipGateway requires sessionStore");
        this.sipClient = sipClient;
        this.sessionStore = sessionStore;
        this.logger = logger;
    }

    openOutbound(sessionId, options = {}) {
        return this.sipClient.openSipSession(sessionId, this.sessionStore, options);
    }

    openInbound(sessionId, options = {}) {
        return this.sipClient.openInboundSipSession(sessionId, this.sessionStore, options);
    }

    close(sessionId) {
        return this.sipClient.closeSipSession(sessionId, this.sessionStore);
    }
}

module.exports = {
    SipGateway,
};
