class PendingBridgeRegistry {
    constructor({ pendingBridges }) {
        this.pendingBridges = pendingBridges;
    }

    getList(walletKey) {
        const raw = this.pendingBridges.get(walletKey);
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        return [raw];
    }

    setList(walletKey, list) {
        if (!list || list.length === 0) {
            this.pendingBridges.delete(walletKey);
            return;
        }
        this.pendingBridges.set(walletKey, list);
    }

    add(walletKey, entry) {
        const list = this.getList(walletKey);
        list.push(entry);
        this.setList(walletKey, list);
    }

    remove(walletKey, predicate) {
        const list = this.getList(walletKey).filter((entry) => !predicate(entry));
        this.setList(walletKey, list);
    }

    has(walletKey, predicate) {
        return this.getList(walletKey).some(predicate);
    }

    entries() {
        return this.pendingBridges.entries();
    }
}

module.exports = {
    PendingBridgeRegistry,
};
