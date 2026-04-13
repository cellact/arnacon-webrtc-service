"use strict";

function createProviderPolicy({
    providerConfig = null,
}) {
    function normalizeDomain(domain) {
        return String(domain || "").toLowerCase().trim().replace(/\.$/, "");
    }

    function uniqueDomains(domains) {
        return Array.from(new Set((domains || []).map(normalizeDomain).filter(Boolean)));
    }

    function normalizeNumberVariants(number) {
        const num = String(number || "").replace(/^\+/, "");
        const variants = new Set();
        if (!num) return variants;
        variants.add(num);
        if (num.startsWith("0") && num.length > 1) variants.add(`972${num.slice(1)}`);
        if (num.startsWith("972") && num.length > 3) variants.add(`0${num.slice(3)}`);
        if (!num.startsWith("0") && !num.startsWith("972")) variants.add(`0${num}`);
        if (!num.startsWith("972")) variants.add(`972${num}`);
        return variants;
    }

    return {
        providers: providerConfig?.providers || {},
        normalizeNumberVariants,
        normalizeDomain,
        uniqueDomains,
    };
}

module.exports = {
    createProviderPolicy,
};
