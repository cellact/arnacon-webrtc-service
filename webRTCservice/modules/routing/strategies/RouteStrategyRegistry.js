class RouteStrategyRegistry {
    constructor({ strategies = {} } = {}) {
        this.strategies = strategies;
    }

    get(route) {
        return this.strategies[route] || null;
    }

    require(route) {
        const strategy = this.get(route);
        if (!strategy) throw new Error(`No route strategy registered for route: ${route || "unknown"}`);
        return strategy;
    }
}

module.exports = {
    RouteStrategyRegistry,
};
