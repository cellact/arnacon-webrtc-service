"use strict";

const path = require("path");
const fs = require("fs");
const pkg = require("../package.json");

const projectRoot = path.resolve(__dirname, "..");
const exportsMap = pkg.exports || {};
const targets = Object.values(exportsMap);
const checks = Array.from(new Set(targets));

for (const relTarget of checks) {
    const target = path.resolve(projectRoot, relTarget);
    if (!fs.existsSync(target)) {
        throw new Error(`Missing export target: ${relTarget} -> ${target}`);
    }
}

console.log(`Export validation successful. Checked ${checks.length} targets.`);
