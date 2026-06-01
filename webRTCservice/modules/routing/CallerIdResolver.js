class CallerIdResolver {
    constructor({ serviceRegistry, serviceContextFactory }) {
        if (!serviceRegistry) throw new Error("CallerIdResolver requires serviceRegistry");
        if (!serviceContextFactory) throw new Error("CallerIdResolver requires serviceContextFactory");
        this.serviceRegistry = serviceRegistry;
        this.serviceContextFactory = serviceContextFactory;
    }

    async resolve(parsedFrom, walletAddress, serviceId = null) {
        const runtime = this.serviceRegistry.get(serviceId);
        if (!runtime || typeof runtime.resolveCallerId !== "function") {
            return { callerId: parsedFrom?.full || parsedFrom?.value || null, privateId: null };
        }
        return runtime.resolveCallerId({
            serviceId: runtime.id,
            providerId: runtime.providerId,
            parsedFrom,
            walletAddress,
            helpers: this.serviceContextFactory.helpers(runtime),
        });
    }
}

module.exports = {
    CallerIdResolver,
};
