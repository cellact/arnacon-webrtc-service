class DestinationResolver {
    constructor({ serviceRegistry, serviceContextFactory }) {
        if (!serviceRegistry) throw new Error("DestinationResolver requires serviceRegistry");
        if (!serviceContextFactory) throw new Error("DestinationResolver requires serviceContextFactory");
        this.serviceRegistry = serviceRegistry;
        this.serviceContextFactory = serviceContextFactory;
    }

    async resolve(parsedTo, parsedFrom = null, serviceId = null) {
        const runtime = this.serviceRegistry.get(serviceId);
        if (!runtime || typeof runtime.resolveDestination !== "function") {
            return { route: "reject", reason: "Missing service resolver" };
        }
        return runtime.resolveDestination({
            serviceId: runtime.id,
            providerId: runtime.providerId,
            parsedTo,
            parsedFrom,
            helpers: this.serviceContextFactory.helpers(runtime),
        });
    }
}

module.exports = {
    DestinationResolver,
};
