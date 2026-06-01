const fs = require("fs");
const path = require("path");

function createMinuteCounter({
    filePath,
    logger = console,
} = {}) {
    const resolvedFilePath = filePath ? path.resolve(filePath) : "";

    function normalizeServiceId(serviceId) {
        return String(serviceId || "").trim();
    }

    function normalizeIdentity(identity) {
        return String(identity || "").trim().toLowerCase();
    }

    function normalizeLimitSeconds(limitSeconds) {
        const parsed = Number(limitSeconds);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return Math.floor(parsed);
    }

    function getLocalDateParts(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return {
            date: `${year}-${month}-${day}`,
            month: `${year}-${month}`,
        };
    }

    function getEntryMonth(entry) {
        const raw = typeof entry?.lastUpdated === "string" ? entry.lastUpdated : "";
        const match = raw.match(/^(\d{4})-(\d{2})-\d{2}$/);
        return match ? `${match[1]}-${match[2]}` : "";
    }

    function readTotals() {
        if (!resolvedFilePath || !fs.existsSync(resolvedFilePath)) return {};
        try {
            const raw = fs.readFileSync(resolvedFilePath, "utf8").trim();
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (err) {
            logger.error(`[MinuteCounter] Failed reading ${resolvedFilePath}: ${err.message}`);
            return {};
        }
    }

    function writeTotals(totals) {
        if (!resolvedFilePath) return;
        const dir = path.dirname(resolvedFilePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${resolvedFilePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(totals, null, 2));
        fs.renameSync(tmpPath, resolvedFilePath);
    }

    function getMonthlyEntry(totals, serviceId, identity, { create = false } = {}) {
        if (!totals[serviceId] || typeof totals[serviceId] !== "object" || Array.isArray(totals[serviceId])) {
            if (!create) return { entry: null, changed: false };
            totals[serviceId] = {};
        }

        const serviceTotals = totals[serviceId];
        let entry = serviceTotals[identity];
        let changed = false;
        const today = getLocalDateParts();

        if (entry === undefined || entry === null) {
            if (!create) return { entry: null, changed };
            entry = { totalSeconds: 0, lastUpdated: today.date };
            serviceTotals[identity] = entry;
            changed = true;
        } else if (typeof entry === "number") {
            entry = { totalSeconds: Math.max(0, Number(entry) || 0), lastUpdated: today.date };
            serviceTotals[identity] = entry;
            changed = true;
        } else if (typeof entry !== "object" || Array.isArray(entry)) {
            entry = { totalSeconds: 0, lastUpdated: today.date };
            serviceTotals[identity] = entry;
            changed = true;
        } else {
            const normalizedSeconds = Math.max(0, Number(entry.totalSeconds) || 0);
            if (entry.totalSeconds !== normalizedSeconds) {
                entry.totalSeconds = normalizedSeconds;
                changed = true;
            }
            if (!entry.lastUpdated) {
                entry.lastUpdated = today.date;
                changed = true;
            }
        }

        if (getEntryMonth(entry) !== today.month) {
            entry.totalSeconds = 0;
            entry.lastUpdated = today.date;
            changed = true;
        }

        return { entry, changed };
    }

    function getUsedSeconds({ serviceId, identity }) {
        const normalizedServiceId = normalizeServiceId(serviceId);
        const normalizedIdentity = normalizeIdentity(identity);
        if (!normalizedServiceId || !normalizedIdentity) return 0;

        const totals = readTotals();
        const { entry, changed } = getMonthlyEntry(totals, normalizedServiceId, normalizedIdentity);
        if (changed) writeTotals(totals);
        return Number(entry?.totalSeconds || 0);
    }

    function assertCanStart({ serviceId, identity, limitSeconds }) {
        const normalizedLimit = normalizeLimitSeconds(limitSeconds);
        if (!resolvedFilePath || !normalizedLimit) return true;

        const usedSeconds = getUsedSeconds({ serviceId, identity });
        if (usedSeconds >= normalizedLimit) {
            throw new Error(`Call minute limit reached for ${identity}`);
        }
        return true;
    }

    function start(session, { serviceId, identity, limitSeconds } = {}) {
        const normalizedServiceId = normalizeServiceId(serviceId);
        const normalizedIdentity = normalizeIdentity(identity);
        const normalizedLimit = normalizeLimitSeconds(limitSeconds);
        if (!session || !resolvedFilePath || !normalizedLimit || !normalizedServiceId || !normalizedIdentity) return false;

        session.minuteCounter = {
            serviceId: normalizedServiceId,
            identity: normalizedIdentity,
            startedAt: Date.now(),
            finished: false,
        };
        return true;
    }

    function finish(session) {
        const active = session?.minuteCounter;
        if (!active || active.finished) return 0;

        active.finished = true;
        const serviceId = normalizeServiceId(active.serviceId);
        const identity = normalizeIdentity(active.identity);
        if (!resolvedFilePath || !serviceId || !identity) return 0;

        const seconds = Math.max(0, Math.ceil((Date.now() - Number(active.startedAt || Date.now())) / 1000));
        if (seconds <= 0) return 0;

        const totals = readTotals();
        const { entry } = getMonthlyEntry(totals, serviceId, identity, { create: true });
        entry.totalSeconds = Number(entry.totalSeconds || 0) + seconds;
        entry.lastUpdated = getLocalDateParts().date;
        writeTotals(totals);

        logger.log(`[MinuteCounter] Added ${seconds}s to ${serviceId}/${identity}`);
        return seconds;
    }

    return {
        getUsedSeconds,
        assertCanStart,
        start,
        finish,
    };
}

module.exports = {
    createMinuteCounter,
};
