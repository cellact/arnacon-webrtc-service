"use strict";

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

    function getUsedSeconds({ serviceId, identity }) {
        const normalizedServiceId = normalizeServiceId(serviceId);
        const normalizedIdentity = normalizeIdentity(identity);
        if (!normalizedServiceId || !normalizedIdentity) return 0;

        const totals = readTotals();
        return Number(totals?.[normalizedServiceId]?.[normalizedIdentity] || 0);
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
        if (!totals[serviceId] || typeof totals[serviceId] !== "object" || Array.isArray(totals[serviceId])) {
            totals[serviceId] = {};
        }
        totals[serviceId][identity] = Number(totals[serviceId][identity] || 0) + seconds;
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
