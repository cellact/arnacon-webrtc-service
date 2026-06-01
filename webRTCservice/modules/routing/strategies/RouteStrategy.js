class RouteStrategy {
    async start() {
        throw new Error(`${this.constructor.name}.start is not implemented`);
    }

    async connect() {
        throw new Error(`${this.constructor.name}.connect is not implemented`);
    }

    async cancel() {
        throw new Error(`${this.constructor.name}.cancel is not implemented`);
    }

    async end() {
        throw new Error(`${this.constructor.name}.end is not implemented`);
    }

    async fail() {
        throw new Error(`${this.constructor.name}.fail is not implemented`);
    }

    async endFromRemote() {
        throw new Error(`${this.constructor.name}.endFromRemote is not implemented`);
    }

    async handleRemoteEnd(context, event) {
        return this.endFromRemote(context, event);
    }
}

module.exports = {
    RouteStrategy,
};
