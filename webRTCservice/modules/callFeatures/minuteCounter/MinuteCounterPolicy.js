class MinuteCounterPolicy {
    constructor({ getServiceRuntime }) {
        this.getServiceRuntime = getServiceRuntime;
    }

    normalizePhone(value) {
        return String(value || "").replace(/^\+/, "");
    }

    getLimitSeconds(serviceRuntime) {
        const constants = serviceRuntime?.serviceConstants || {};
        if (constants.minuteLimitSeconds !== undefined) {
            const parsedSeconds = Number(constants.minuteLimitSeconds);
            return Number.isFinite(parsedSeconds) && parsedSeconds > 0 ? Math.floor(parsedSeconds) : null;
        }
        if (constants.minuteLimitMinutes !== undefined) {
            const parsedMinutes = Number(constants.minuteLimitMinutes);
            return Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? Math.floor(parsedMinutes * 60) : null;
        }
        return null;
    }

    getSettings(serviceId = null) {
        const runtime = this.getServiceRuntime(serviceId);
        const limitSeconds = this.getLimitSeconds(runtime);
        if (!runtime?.id || !limitSeconds) return null;
        return {
            serviceId: runtime.id,
            limitSeconds,
        };
    }

    getIdentity(parsedFrom, session) {
        const rawFull = String(parsedFrom?.full || session?.callerEns || "").trim().toLowerCase();
        if (rawFull.endsWith(".global")) return rawFull;

        const runtime = this.getServiceRuntime(session?.serviceId || null);
        const domains = Array.isArray(runtime?.serviceConstants?.domains) ? runtime.serviceConstants.domains : [];
        const domain = domains[0] || runtime?.primaryDomain || "";
        const label = this.normalizePhone(parsedFrom?.value || rawFull).trim().toLowerCase();
        if (!label || !domain) return rawFull || label;
        return `${label}.${domain}`;
    }
}

module.exports = {
    MinuteCounterPolicy,
};
