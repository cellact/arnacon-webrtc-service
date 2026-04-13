"use strict";

const { ethers } = require("ethers");
const http2 = require("http2");

function createNotificationApi({
    blockchainApi,
    signalingPlanAbi,
    notiTypeCall,
    ephemeralWallet,
    logger = console,
    fetchImpl = fetch,
}) {
    async function sendNotification(callerEns, calleeEns, message, notificationType = notiTypeCall) {
        logger.log(`[Notification] Sending from=${callerEns} to=${calleeEns}, type=${notificationType}`);
        const config = await blockchainApi.resolveCallerServiceProviderContract(callerEns);
        if (!config) throw new Error(`No service provider contract found for caller: ${callerEns}`);

        const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        const contract = new ethers.Contract(
            config.notificationRegistryAddress,
            signalingPlanAbi,
            provider,
        );

        const callData = contract.interface.encodeFunctionData("getSignalingPlan", [
            callerEns, calleeEns, message, notificationType,
        ]);
        const raw = await provider.call({
            to: config.notificationRegistryAddress,
            data: callData,
            from: ethers.constants.AddressZero,
        });

        const [steps] = contract.interface.decodeFunctionResult("getSignalingPlan", raw);
        if (!steps || steps.length === 0) {
            throw new Error("No signaling plan returned");
        }
        const result = await executePlan(steps, message);
        if (!result.success) throw new Error(`Plan-based execution failed (HTTP ${result.statusCode})`);
    }

    async function executePlan(steps, messageOverride) {
        const placeholders = {};
        let finalStep = null;
        let i = 0;

        while (i < steps.length) {
            const step = steps[i];

            const method = replacePlaceholders(step.method, placeholders);
            const url = replacePlaceholders(step.url, placeholders);
            const body = replacePlaceholders(step.body, placeholders);
            const headers = replacePlaceholders(step.headers, placeholders);
            const contentType = replacePlaceholders(step.contentType, placeholders);
            const fallbackUrl = replacePlaceholders(step.fallbackUrl, placeholders);
            const extractField = step.responseExtractField;
            const placeholderKey = step.placeholderKey;

            logger.log(`[Notification] Step ${i + 1}/${steps.length}: ${method}`);

            if (method === "CLIENT_GENERATE") {
                const value = handleClientGenerate(body);
                logger.log(`[Notification] Step ${i + 1} CLIENT_GENERATE -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = value;
                i++;
                continue;
            }

            if (method === "CLIENT_ETH_SIGN") {
                const dataToSign = replacePlaceholders(body, placeholders);
                const signature = await handleClientEthSign(dataToSign);
                logger.log(`[Notification] Step ${i + 1} CLIENT_ETH_SIGN -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = signature;
                i++;
                continue;
            }

            if (method === "CLIENT_ABI_ENCODE") {
                const calldata = handleClientAbiEncode(body);
                if (!calldata) {
                    return { success: false, statusCode: -1, error: `CLIENT_ABI_ENCODE failed: ${body}` };
                }
                logger.log(`[Notification] Step ${i + 1} CLIENT_ABI_ENCODE -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = calldata;
                i++;
                continue;
            }

            if (method === "CLIENT_ABI_DECODE") {
                const decoded = handleClientAbiDecode(body);
                if (decoded === null) {
                    return { success: false, statusCode: -1, error: `CLIENT_ABI_DECODE failed: ${body}` };
                }
                logger.log(`[Notification] Step ${i + 1} CLIENT_ABI_DECODE -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = decoded;
                i++;
                continue;
            }

            if (method === "CLIENT_JSON_EXTRACT") {
                const extracted = handleClientJsonExtract(body);
                if (extracted === null) {
                    return { success: false, statusCode: -1, error: `CLIENT_JSON_EXTRACT failed: ${body}` };
                }
                logger.log(`[Notification] Step ${i + 1} CLIENT_JSON_EXTRACT -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = extracted;
                i++;
                continue;
            }

            if (method === "CLIENT_CONDITION") {
                const skipCount = handleClientCondition(body);
                if (skipCount > 0) {
                    logger.log(`[Notification] Step ${i + 1} CLIENT_CONDITION -> skip ${skipCount}`);
                    i += skipCount;
                } else {
                    logger.log(`[Notification] Step ${i + 1} CLIENT_CONDITION -> continue`);
                }
                i++;
                continue;
            }

            if (extractField) {
                logger.log(`[Notification] Step ${i + 1} intermediate HTTP: ${method} ${url}`);
                let result = await executeHttpRequest(url, method, contentType, body, headers);

                if (!result.success && fallbackUrl) {
                    logger.log(`[Notification] Step ${i + 1} primary failed (${result.statusCode}), trying fallback: ${fallbackUrl}`);
                    result = await executeHttpRequest(fallbackUrl, method, contentType, body, headers);
                }

                if (!result.success) {
                    return { success: false, statusCode: result.statusCode, error: `Intermediate step ${i + 1} failed (HTTP ${result.statusCode})` };
                }

                const extracted = extractJsonField(result.responseBody, extractField);
                if (!extracted) {
                    return { success: false, statusCode: -1, error: `Failed to extract '${extractField}' from step ${i + 1} response` };
                }

                logger.log(`[Notification] Step ${i + 1} extracted '${extractField}' -> ${placeholderKey}`);
                if (placeholderKey) placeholders[placeholderKey] = extracted;
            } else {
                finalStep = { url, method, contentType, body, headers, fallbackUrl };
                logger.log(`[Notification] Step ${i + 1} final HTTP stored: ${method} ${url}`);
            }
            i++;
        }

        if (!finalStep) {
            return { success: false, statusCode: -1, error: "No final HTTP step found in plan" };
        }

        const isApns = finalStep.url && finalStep.url.includes("push.apple.com");
        const isFcm = finalStep.url && finalStep.url.includes("fcm.googleapis.com");
        let sendBody = finalStep.body;

        if (isApns && messageOverride) {
            sendBody = messageOverride;
            logger.log(`[Notification] Using offerPayload as APNS body (${messageOverride.length} bytes) instead of Sapphire body (${(finalStep.body || "").length} bytes)`);
        }
        if (isFcm && messageOverride) {
            sendBody = buildFcmBodyWithOfferPayload(finalStep.body, messageOverride);
            logger.log(`[Notification] Using offerPayload as FCM data.body (${messageOverride.length} bytes)`);
        }

        logger.log(`[Notification] Executing final HTTP step: ${finalStep.method} ${finalStep.url}`);
        let result = await executeHttpRequest(
            finalStep.url, finalStep.method, finalStep.contentType, sendBody, finalStep.headers,
        );

        if (!result.success && finalStep.fallbackUrl) {
            logger.log(`[Notification] Final step primary URL failed (${result.statusCode}), trying fallback`);
            result = await executeHttpRequest(
                finalStep.fallbackUrl, finalStep.method, finalStep.contentType, sendBody, finalStep.headers,
            );
        }

        return result;
    }

    async function handleClientEthSign(dataToSign) {
        try {
            return await ephemeralWallet.signMessage(dataToSign);
        } catch (err) {
            logger.error(`[Notification] CLIENT_ETH_SIGN failed: ${err.message}`);
            return "";
        }
    }

    function handleClientAbiEncode(body) {
        try {
            const colonIdx = body.indexOf(":");
            if (colonIdx < 0) return null;
            const funcSig = body.substring(0, colonIdx);
            const argsStr = body.substring(colonIdx + 1);

            const parenOpen = funcSig.indexOf("(");
            const parenClose = funcSig.lastIndexOf(")");
            if (parenOpen < 0 || parenClose < 0) return null;

            const funcName = funcSig.substring(0, parenOpen);
            const paramTypesStr = funcSig.substring(parenOpen + 1, parenClose);
            const paramTypes = paramTypesStr ? paramTypesStr.split(",").map(t => t.trim()) : [];

            const args = paramTypes.length <= 1
                ? (paramTypes.length === 0 ? [] : [argsStr])
                : argsStr.split(":").slice(0, paramTypes.length);

            const iface = new ethers.utils.Interface([`function ${funcSig}`]);
            return iface.encodeFunctionData(funcName, args);
        } catch (err) {
            logger.error(`[Notification] CLIENT_ABI_ENCODE error: ${err.message}`);
            return null;
        }
    }

    function handleClientAbiDecode(body) {
        try {
            const colonIdx = body.indexOf(":");
            if (colonIdx < 0) return null;
            const returnType = body.substring(0, colonIdx);
            const hexData = body.substring(colonIdx + 1);

            const decoded = ethers.utils.defaultAbiCoder.decode([returnType], hexData);
            const value = decoded[0];
            if (value === undefined || value === null) return null;
            return value.toString ? value.toString() : String(value);
        } catch (err) {
            logger.error(`[Notification] CLIENT_ABI_DECODE error: ${err.message}`);
            return null;
        }
    }

    function handleClientJsonExtract(body) {
        try {
            const colonIdx = body.indexOf(":");
            if (colonIdx < 0) return null;
            const fieldName = body.substring(0, colonIdx);
            const jsonStr = body.substring(colonIdx + 1);
            const obj = JSON.parse(jsonStr);
            const value = obj[fieldName];
            if (value === undefined || value === null) return null;
            return typeof value === "string" ? value : String(value);
        } catch (err) {
            logger.error(`[Notification] CLIENT_JSON_EXTRACT error: ${err.message}`);
            return null;
        }
    }

    function handleClientCondition(body) {
        try {
            const parts = body.split(":");
            if (parts.length < 4) return 0;
            const [op, left, right, skipCountStr] = parts;
            const skipCount = parseInt(skipCountStr, 10);
            if (Number.isNaN(skipCount)) return 0;
            let conditionTrue;
            if (op === "eq") conditionTrue = left === right;
            else if (op === "ne") conditionTrue = left !== right;
            else return 0;
            return conditionTrue ? 0 : skipCount;
        } catch (err) {
            logger.error(`[Notification] CLIENT_CONDITION error: ${err.message}`);
            return 0;
        }
    }

    function handleClientGenerate(format) {
        if (format === "uuid_timestamp") {
            const uuid = ethers.utils.hexlify(ethers.utils.randomBytes(16)).slice(2);
            const formatted = [uuid.slice(0, 8), uuid.slice(8, 12), uuid.slice(12, 16), uuid.slice(16, 20), uuid.slice(20)].join("-");
            return `${formatted}:${Math.floor(Date.now() / 1000)}`;
        }
        return ethers.utils.hexlify(ethers.utils.randomBytes(16)).slice(2);
    }

    function replacePlaceholders(template, placeholders) {
        if (!template) return template;
        let result = template;
        for (const [key, value] of Object.entries(placeholders)) {
            result = result.split(key).join(value);
        }
        return result;
    }

    function extractJsonField(jsonString, field) {
        try {
            const obj = JSON.parse(jsonString);
            return obj?.[field];
        } catch (_) {
            return null;
        }
    }

    function buildFcmBodyWithOfferPayload(originalBody, offerPayload) {
        try {
            const parsed = JSON.parse(originalBody || "{}");
            if (!parsed.message || typeof parsed.message !== "object") parsed.message = {};
            if (!parsed.message.data || typeof parsed.message.data !== "object") parsed.message.data = {};
            parsed.message.data.body = offerPayload;
            return JSON.stringify(parsed);
        } catch (_) {
            if (typeof originalBody === "string" && originalBody.length > 0) {
                if (originalBody.includes("\"body\"")) {
                    return originalBody.replace(/"body"\s*:\s*"[^"]*"/, `"body":${JSON.stringify(offerPayload)}`);
                }
                return originalBody;
            }
            return JSON.stringify({ message: { data: { body: offerPayload } } });
        }
    }

    async function executeHttpRequest(url, method, contentType, bodyStr, headersJson) {
        if (url.includes("push.apple.com")) {
            return executeApnsHttp2(url, method, contentType, bodyStr, headersJson);
        }
        try {
            const fetchOptions = { method: method || "GET", headers: {} };

            if (headersJson && headersJson !== "{}") {
                try {
                    const hdrs = JSON.parse(headersJson);
                    for (const [key, value] of Object.entries(hdrs)) {
                        fetchOptions.headers[key] = value;
                    }
                } catch (_) {}
            }

            if (method && method.toUpperCase() === "POST") {
                fetchOptions.headers["Content-Type"] = contentType || "application/json";
                fetchOptions.body = bodyStr || "";
            }

            const response = await fetchImpl(url, fetchOptions);
            const statusCode = response.status;
            const responseBody = await response.text();
            const success = statusCode >= 200 && statusCode < 300;
            return { success, statusCode, responseBody };
        } catch (err) {
            logger.error(`[Notification] HTTP request failed: ${err.message}`);
            return { success: false, statusCode: -1, responseBody: null, error: err.message };
        }
    }

    async function executeApnsHttp2(url, method, contentType, bodyStr, headersJson) {
        return new Promise((resolve) => {
            try {
                const parsed = new URL(url);
                const authority = `${parsed.protocol}//${parsed.host}`;
                const client = http2.connect(authority);
                client.on("error", (err) => {
                    resolve({ success: false, statusCode: -1, responseBody: null, error: err.message });
                });

                const reqHeaders = {
                    ":method": method || "POST",
                    ":path": parsed.pathname,
                    "content-type": contentType || "application/json",
                };

                if (headersJson && headersJson !== "{}") {
                    try {
                        const hdrs = JSON.parse(headersJson);
                        for (const [key, value] of Object.entries(hdrs)) {
                            reqHeaders[key.toLowerCase()] = value;
                        }
                    } catch (_) {}
                }

                const req = client.request(reqHeaders);
                let responseBody = "";
                let statusCode = 0;

                req.on("response", (headers) => {
                    statusCode = headers[":status"];
                });
                req.on("data", (chunk) => {
                    responseBody += chunk.toString();
                });
                req.on("end", () => {
                    client.close();
                    const success = statusCode >= 200 && statusCode < 300;
                    resolve({ success, statusCode, responseBody });
                });
                req.on("error", (err) => {
                    client.close();
                    resolve({ success: false, statusCode: -1, responseBody: null, error: err.message });
                });
                req.setTimeout(10000, () => {
                    req.close();
                    client.close();
                    resolve({ success: false, statusCode: -1, responseBody: null, error: "timeout" });
                });

                if (bodyStr) req.write(bodyStr);
                req.end();
            } catch (err) {
                resolve({ success: false, statusCode: -1, responseBody: null, error: err.message });
            }
        });
    }

    return {
        sendNotification,
        executePlan,
    };
}

module.exports = {
    createNotificationApi,
};
