const { RouteStrategy } = require("./RouteStrategy");

class RejectRouteStrategy extends RouteStrategy {
    async start() {
        return "reject";
    }

    async connect() {
        return "reject";
    }

    async end() {
        return "reject";
    }

    async cancel() {
        return "reject";
    }

    async fail() {
        return "reject";
    }
}

module.exports = {
    RejectRouteStrategy,
};
