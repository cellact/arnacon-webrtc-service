"use strict";
/**
 * WebRTC Statistics API implementation
 * Based on: https://www.w3.org/TR/webrtc-stats/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCStatsReport = void 0;
exports.generateStatsId = generateStatsId;
exports.getStatsTimestamp = getStatsTimestamp;
/**
 * RTCStatsReport is a Map-like object that holds WebRTC statistics
 */
class RTCStatsReport extends Map {
    constructor(stats) {
        super();
        if (stats) {
            for (const stat of stats) {
                this.set(stat.id, stat);
            }
        }
    }
}
exports.RTCStatsReport = RTCStatsReport;
/**
 * Generate a unique ID for a statistics object
 */
function generateStatsId(type, ...parts) {
    const validParts = parts.filter((p) => p !== undefined);
    return `${type}_${validParts.join("_")}`;
}
/**
 * Get current timestamp in milliseconds (DOMHighResTimeStamp)
 */
function getStatsTimestamp() {
    return performance.now();
}
//# sourceMappingURL=stats.js.map