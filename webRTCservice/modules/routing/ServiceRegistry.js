class ServiceRegistry {
    constructor({ serviceRuntimes = {}, activeServiceRuntimes = null, logger = console } = {}) {
        this.serviceRuntimes = serviceRuntimes;
        this.activeServiceRuntimes = activeServiceRuntimes || Object.values(serviceRuntimes);
        this.defaultServiceRuntime = this.activeServiceRuntimes[0] || Object.values(serviceRuntimes)[0] || null;
        this.logger = logger;
    }

    get(serviceId = null) {
        if (serviceId && this.serviceRuntimes[serviceId]) return this.serviceRuntimes[serviceId];
        return this.defaultServiceRuntime;
    }

    all() {
        return Object.values(this.serviceRuntimes);
    }

    active() {
        return this.activeServiceRuntimes;
    }

    allDomains() {
        const domains = [];
        for (const runtime of this.all()) {
            const configured = Array.isArray(runtime.serviceConstants?.domains)
                ? runtime.serviceConstants.domains
                : [];
            if (configured.length > 0) domains.push(...configured);
            else {
                if (runtime.primaryDomain) domains.push(runtime.primaryDomain);
                if (Array.isArray(runtime.domainAliases)) domains.push(...runtime.domainAliases);
            }
        }
        return Array.from(new Set(domains.filter(Boolean)));
    }

    firstDomain(serviceId = null) {
        const runtime = this.get(serviceId);
        const configured = Array.isArray(runtime?.serviceConstants?.domains)
            ? runtime.serviceConstants.domains
            : [];
        return configured[0] || runtime?.primaryDomain || this.allDomains()[0] || "";
    }
}

module.exports = {
    ServiceRegistry,
};
