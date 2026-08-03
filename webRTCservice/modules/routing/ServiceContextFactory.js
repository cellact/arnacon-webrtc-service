const crypto = require("crypto");

const PRIVACY_LOG_KEYS = new Set([
    "from",
    "to",
    "fromnumber",
    "tonumber",
    "caller",
    "callee",
    "callerens",
    "calleeens",
    "ensname",
    "notifyidentity",
    "targetvalue",
    "identity",
    "endpoint",
]);

function isLogPrivacyEnabled(serviceRuntime) {
    return serviceRuntime?.serviceConstants?.logPrivacy?.enabled === true;
}

function hashLogIdentity(value) {
    const str = String(value ?? "").trim();
    if (!str) return "";
    return crypto.createHash("sha256").update(str).digest("hex");
}

function sanitizeLogPayload(value, privacyEnabled, keyHint = "") {
    if (!privacyEnabled) return value;
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeLogPayload(item, privacyEnabled, keyHint));
    }
    if (typeof value === "object") {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = sanitizeLogPayload(entry, privacyEnabled, key);
        }
        return out;
    }
    const normalizedKey = String(keyHint || "").toLowerCase();
    if (PRIVACY_LOG_KEYS.has(normalizedKey)) {
        return hashLogIdentity(value);
    }
    return value;
}

class ServiceContextFactory {
    constructor({
        serviceRegistry,
        zeroAddress,
        parseAddress,
        normalizePhone,
        blockchainApi,
        callRouterApi,
        lightPbxProvisionReader = null,
        sendNotification,
        findOutboundSessionForInbound,
        openSipSession,
        openInboundSipSession,
        notifyAndBridge,
        sendAck,
        sendAnswer,
        sendAckAndAnswer,
        sendDataChannelMessage,
        handleCallEnd,
        emailToEnsName,
        logger = console,
    } = {}) {
        Object.assign(this, {
            serviceRegistry,
            zeroAddress,
            parseAddress,
            normalizePhone,
            blockchainApi,
            callRouterApi,
            lightPbxProvisionReader,
            sendNotification,
            findOutboundSessionForInbound,
            openSipSession,
            openInboundSipSession,
            notifyAndBridge,
            sendAck,
            sendAnswer,
            sendAckAndAnswer,
            sendDataChannelMessage,
            handleCallEnd,
            emailToEnsName,
            logger,
        });
    }

    buildInboundCandidates({ value, domains = [] }) {
        const normalized = this.normalizePhone(value);
        if (!normalized) return [];
        const variants = new Set([normalized]);
        if (normalized.startsWith("0") && normalized.length > 1) variants.add(`972${normalized.slice(1)}`);
        if (normalized.startsWith("972") && normalized.length > 3) variants.add(`0${normalized.slice(3)}`);
        const out = [];
        for (const domain of domains) {
            for (const variant of variants) out.push(`${variant}.${domain}`);
        }
        return out;
    }

    selectInboundLookupValue({ payload, lookupField }) {
        const field = lookupField === "diversion" ? "diversion" : "to";
        return payload?.[field] || null;
    }

    async tryInternalWebrtcLookup(label, targetDomains = []) {
        const normalized = this.normalizePhone(label);
        for (const domain of targetDomains || []) {
            const ensName = `${normalized}.${domain}`;
            try {
                const addr = await this.blockchainApi.resolveEnsToAddress(ensName);
                if (addr && addr !== this.zeroAddress) {
                    return { route: "webrtc", wallet: addr, ensName };
                }
            } catch (_) {}
        }
        return null;
    }

    helpers(serviceRuntime) {
        const logPrivacyEnabled = isLogPrivacyEnabled(serviceRuntime);
        return {
            zeroAddress: this.zeroAddress,
            getServiceConstants: () => serviceRuntime.serviceConstants || {},
            parseIdentity: (value) => this.parseAddress(value, serviceRuntime.id),
            normalizePhone: this.normalizePhone,
            normalizeEmail: (value) => String(value || "").trim().toLowerCase(),
            buildEnsLabel: (value) => String(value || "").trim().toLowerCase(),
            formatProviderEns: (label, domain) => `${label}.${domain}`,
            lookupEnsOwner: (...args) => this.blockchainApi.resolveEnsToOwner(...args),
            lookupEnsAddress: (...args) => this.blockchainApi.resolveEnsToAddress(...args),
            lookupEnsTextRecord: (...args) => this.blockchainApi.resolveEnsTextRecord(...args),
            lookupWalletByWeb2Identity: (...args) => this.blockchainApi.resolveWalletByWeb2Identity(...args),
            lookupNftOwnedNumber: (...args) => this.blockchainApi.nftGetOwnedNumber(...args),
            lookupBusinessNumber: (...args) => this.callRouterApi.roflFindBusinessNumber(...args),
            lookupBusinessNumberCascade: (...args) => this.callRouterApi.roflCascadingBusinessLookup(...args),
            assignPoolFromNumber: (...args) => this.callRouterApi.roflAssignFromNumber(...args),
            readLightPbxProvision: this.lightPbxProvisionReader
                ? (...args) => this.lightPbxProvisionReader.readLightPbxProvision(...args)
                : null,
            getProviderForDomain: (domain) => {
                if (!domain) return null;
                const configured = Array.isArray(serviceRuntime.serviceConstants?.domains)
                    ? serviceRuntime.serviceConstants.domains
                    : [serviceRuntime.primaryDomain, ...(serviceRuntime.domainAliases || [])];
                return configured.includes(domain) ? serviceRuntime.providerId : null;
            },
            extractInboundFields: (payload) => payload || {},
            buildInboundCandidates: (...args) => this.buildInboundCandidates(...args),
            findLinkedOutboundSession: (...args) => this.findOutboundSessionForInbound(...args),
            selectInboundLookupValue: (...args) => this.selectInboundLookupValue(...args),
            notifyAndWakeUser: async (input) => {
                let message = input.message;
                if (serviceRuntime.shapeNotifyPayload) {
                    message = await serviceRuntime.shapeNotifyPayload({
                        serviceId: serviceRuntime.id,
                        providerId: serviceRuntime.providerId,
                        message: input.message,
                        payload: input.payload || null,
                        helpers: this.helpers(serviceRuntime),
                    });
                }
                return this.sendNotification(input.callerEns, input.calleeEns, message, input.notificationType, {
                    targetWallet: input.targetWallet,
                    web2identity: input.web2identity,
                });
            },
            forwardInviteToKamailio: async (input) => this.openSipSession(input.sessionId, input.sipFrom, input.sipTo),
            openInboundSipLeg: async (input) => this.openInboundSipSession(input.sessionId, input.phoneNumber),
            bridgeWebrtcSessions: async (input) => this.notifyAndBridge(input.sessionId, input.destination),
            buildCallerIdPayload: (input) => input,
            sendAck: this.sendAck,
            sendAnswer: this.sendAnswer,
            sendAckAndAnswer: this.sendAckAndAnswer,
            sendDataChannelMessage: this.sendDataChannelMessage,
            endCall: (sessionId, reason) => this.handleCallEnd(sessionId, reason, true),
            logRouteDecision: (entry) =>
                this.logger.log("[ServiceRoute]", sanitizeLogPayload(entry, logPrivacyEnabled)),
            emitServiceMetric: (metric) =>
                this.logger.log("[ServiceMetric]", sanitizeLogPayload(metric, logPrivacyEnabled)),
            getAllServiceDomains: () => this.serviceRegistry.allDomains(),
            getFirstServiceDomain: () => this.serviceRegistry.firstDomain(serviceRuntime.id),
            tryInternalWebrtcLookup: (...args) => this.tryInternalWebrtcLookup(...args),
            emailToEnsName: this.emailToEnsName,
        };
    }
}

module.exports = {
    ServiceContextFactory,
};
