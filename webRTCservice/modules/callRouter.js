"use strict";

const crypto = require("crypto");

function createCallRouter({
    roflBaseUrl,
    fetchImpl = fetch,
    logger = console,
}) {
    function isRawEmail(str) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str) && !str.endsWith(".global");
    }

    function emailToEnsName(email, domain) {
        const hash = crypto.createHash("sha256").update(email).digest("hex");
        return `${hash.substring(0, 12)}.${domain}`;
    }

    function parseAddress(addr) {
        if (!addr) return { type: "unknown", value: addr, full: addr };
        const value = String(addr).trim();
        if (/^[0-9*+][0-9]{0,20}$/.test(value)) return { type: "raw", value, full: value };
        if (isRawEmail(value)) return { type: "email", value, full: value };
        const ensMatch = value.match(/^(.+)\.([^.]+\.[^.]+|[^.]+)\.global$/);
        if (ensMatch) {
            return {
                type: "ens",
                value: ensMatch[1],
                domain: `${ensMatch[2]}.global`,
                full: value,
            };
        }
        return { type: "unknown", value, full: value };
    }

    async function roflFindBusinessNumber(callee) {
        try {
            const resp = await fetchImpl(`${roflBaseUrl}/find-business-number`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callee }),
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.phoneNumber || null;
        } catch (err) {
            logger.error(`[ROFL] find-business-number failed for ${callee}: ${err.message}`);
            return null;
        }
    }

    async function roflCascadingBusinessLookup(identifier) {
        const lookups = [identifier];

        if (identifier.includes("_")) {
            const domain = identifier.split("_", 2)[1];
            if (!lookups.includes(domain)) lookups.push(domain);
            let parts = domain;
            while (parts.includes(".")) {
                parts = parts.substring(0, parts.lastIndexOf("."));
                if (!lookups.includes(parts)) lookups.push(parts);
            }
        } else {
            let parts = identifier;
            while (parts.includes(".")) {
                parts = parts.substring(0, parts.lastIndexOf("."));
                if (!lookups.includes(parts)) lookups.push(parts);
            }
        }

        logger.log(`[Route] Cascading business lookup: [${lookups.join(", ")}]`);

        for (const callee of lookups) {
            const phone = await roflFindBusinessNumber(callee);
            if (phone) {
                logger.log(`[Route] Business match for '${callee}': ${phone}`);
                return phone;
            }
            logger.log(`[Route] No match for '${callee}', trying next...`);
        }
        return null;
    }

    async function roflAssignFromNumber() {
        try {
            const resp = await fetchImpl(`${roflBaseUrl}/assign-from-number`);
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.fromNumber || null;
        } catch (err) {
            logger.error(`[ROFL] assign-from-number failed: ${err.message}`);
            return null;
        }
    }

    return {
        parseAddress,
        isRawEmail,
        emailToEnsName,
        roflFindBusinessNumber,
        roflCascadingBusinessLookup,
        roflAssignFromNumber,
    };
}

module.exports = {
    createCallRouter,
};
