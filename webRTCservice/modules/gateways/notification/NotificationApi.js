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
    function isEthAddress(value) {
        return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
    }

    function checksumWalletOrNull(value) {
        try {
            if (!isEthAddress(value)) return null;
            return ethers.utils.getAddress(String(value).trim());
        } catch (_) {
            return null;
        }
    }

    function normalizePhoneLabel(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const normalized = raw.replace(/^\+/, "").replace(/\D/g, "");
        return /^\d+$/.test(normalized) ? normalized : "";
    }

    function deriveWeb2Identity(identity) {
        let value = String(identity || "").trim();
        if (!value) return "";
        if (/^sip:/i.test(value)) value = value.slice(4);
        value = value.split(";")[0];
        value = value.split("@")[0];
        if (value.includes(".")) value = value.split(".")[0];
        return normalizePhoneLabel(value);
    }

    async function resolveTargetWallet(calleeEns, options = {}) {
        const providedWallet = checksumWalletOrNull(options.targetWallet);
        if (providedWallet) return providedWallet;

        if (typeof blockchainApi.resolveWalletByWeb2Identity === "function") {
            const web2identity = String(options.web2identity || deriveWeb2Identity(calleeEns)).trim();
            if (web2identity) {
                const mapped = checksumWalletOrNull(await blockchainApi.resolveWalletByWeb2Identity(web2identity));
                if (mapped) return mapped;
            }
        }

        if (typeof blockchainApi.resolveEnsToAddress === "function" && calleeEns) {
            try {
                const ensWallet = checksumWalletOrNull(await blockchainApi.resolveEnsToAddress(calleeEns));
                if (ensWallet) return ensWallet;
            } catch (err) {
                logger.warn(`[Notification] ENS fallback lookup failed for ${calleeEns}: ${err.message}`);
            }
        }

        return null;
    }

    async function resolveNotificationPlanContext(callerEns, calleeEns, message, notificationType, options = {}) {
        const config = await blockchainApi.resolveCallerServiceProviderContract(callerEns);
        if (!config) throw new Error(`No service provider contract found for caller: ${callerEns}`);
        const targetWallet = await resolveTargetWallet(calleeEns, options);
        if (!targetWallet) {
            throw new Error(`No target wallet resolved for notification callee: ${calleeEns}`);
        }
        const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        const contract = new ethers.Contract(
            config.notificationRegistryAddress,
            signalingPlanAbi,
            provider,
        );

        const callData = contract.interface.encodeFunctionData("getApplicationTokenPlan", [
            callerEns, targetWallet, message, notificationType,
        ]);
        const raw = await provider.call({
            to: config.notificationRegistryAddress,
            data: callData,
            from: ethers.constants.AddressZero,
        });

        const [steps] = contract.interface.decodeFunctionResult("getApplicationTokenPlan", raw);
        if (!steps || steps.length === 0) {
            throw new Error("No signaling plan returned");
        }
        return { steps, targetWallet };
    }

    async function resolveNotificationPlan(callerEns, calleeEns, message, notificationType, options = {}) {
        const { steps } = await resolveNotificationPlanContext(
            callerEns,
            calleeEns,
            message,
            notificationType,
            options,
        );
        return steps;
    }

    async function executeNotificationPlan(steps, options = {}) {
        return executePlan(steps, options);
    }

    async function sendNotification(callerEns, calleeEns, message, notificationType = notiTypeCall, options = {}) {
        logger.log(`[Notification] Sending from=${callerEns} to=${calleeEns}, type=${notificationType}`);
        const { steps, targetWallet } = await resolveNotificationPlanContext(
            callerEns,
            calleeEns,
            message,
            notificationType,
            options,
        );
        const result = await executeNotificationPlan(steps, {
            initialPlaceholders: {
                "{{TARGET_ADDR}}": targetWallet,
            },
        });
        if (!result.success) {
            logger.warn(
                `[Notification] send failed from=${callerEns} to=${calleeEns} status=${result.statusCode}`,
            );
            throw new Error(`Plan-based execution failed (HTTP ${result.statusCode})`);
        }
        logger.log(
            `[Notification] send ok from=${callerEns} to=${calleeEns} status=${result.statusCode}`,
        );
        return result;
    }

    async function executePlan(steps, options = {}) {
        const placeholders = {
            ...(options.initialPlaceholders || {}),
        };
        let lastHttpResult = null;
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

            if (method === "CLIENT_GENERATE") {
                const value = handleClientGenerate(body);
                if (placeholderKey) placeholders[placeholderKey] = value;
                i++;
                continue;
            }

            if (method === "CLIENT_ETH_SIGN") {
                const dataToSign = replacePlaceholders(body, placeholders);
                const signature = await handleClientEthSign(dataToSign);
                if (placeholderKey) placeholders[placeholderKey] = signature;
                i++;
                continue;
            }

            if (method === "CLIENT_ABI_ENCODE") {
                const calldata = handleClientAbiEncode(body);
                if (!calldata) {
                    return { success: false, statusCode: -1, error: `CLIENT_ABI_ENCODE failed: ${body}` };
                }
                if (placeholderKey) placeholders[placeholderKey] = calldata;
                i++;
                continue;
            }

            if (method === "CLIENT_ABI_DECODE") {
                const decoded = handleClientAbiDecode(body);
                if (decoded === null) {
                    return { success: false, statusCode: -1, error: `CLIENT_ABI_DECODE failed: ${body}` };
                }
                if (placeholderKey) placeholders[placeholderKey] = decoded;
                i++;
                continue;
            }

            if (method === "CLIENT_JSON_EXTRACT") {
                const extracted = handleClientJsonExtract(body);
                if (extracted === null) {
                    i++;
                    continue;
                }
                if (placeholderKey) placeholders[placeholderKey] = extracted;
                i++;
                continue;
            }

            if (method === "CLIENT_CONDITION") {
                const skipCount = handleClientCondition(body);
                if (skipCount > 0) i += skipCount;
                i++;
                continue;
            }

            if (method === "CLIENT_RETURN") {
                return { success: true, statusCode: 200, responseBody: body };
            }

            if (extractField) {
                let result = await executeHttpRequest(url, method, contentType, body, headers);
                if (!result.success && fallbackUrl) {
                    result = await executeHttpRequest(fallbackUrl, method, contentType, body, headers);
                }

                if (!result.success) {
                    return { success: false, statusCode: result.statusCode, error: `Intermediate step ${i + 1} failed (HTTP ${result.statusCode})` };
                }

                const extracted = extractJsonField(result.responseBody, extractField);
                if (!extracted) {
                    i++;
                    continue;
                }

                if (placeholderKey) placeholders[placeholderKey] = extracted;
            } else {
                let result = await executeHttpRequest(url, method, contentType, body, headers);

                if (!result.success && fallbackUrl) {
                    result = await executeHttpRequest(fallbackUrl, method, contentType, body, headers);
                }

                if (!result.success) {
                    return {
                        success: false,
                        statusCode: result.statusCode,
                        error: `HTTP step ${i + 1} failed (HTTP ${result.statusCode})`,
                        responseBody: result.responseBody || null,
                    };
                }

                lastHttpResult = result;
            }
            i++;
        }

        if (!lastHttpResult) {
            return { success: false, statusCode: -1, error: "No final HTTP step found in plan" };
        }

        return lastHttpResult;
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

    function parseConditionParts(body) {
        const parts = [];
        let start = 0;
        for (let i = 0; i < body.length && parts.length < 3; i++) {
            if (body[i] !== ":") continue;
            parts.push(body.slice(start, i));
            start = i + 1;
        }
        parts.push(body.slice(start));
        return parts;
    }

    function handleClientCondition(body) {
        try {
            const parts = parseConditionParts(String(body || ""));
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
        resolveNotificationPlan,
        executeNotificationPlan,
        executePlan,
    };
}

module.exports = {
    createNotificationApi,
};
