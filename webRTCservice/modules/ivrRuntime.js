"use strict";

const IVR_TARGET_NUMBER = "2006";

function createIvrRuntime({
    sessions,
    sendDataChannelMessage,
    playAudioForSession = null,
    playAudioFileForSession = null,
    stopAudioForSession = null,
    redirectCallForSession = null,
    handlers = {},
    logger = console,
}) {
    function normalizeDialTarget(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const label = raw.includes(".") ? raw.split(".")[0] : raw;
        return String(label).replace(/^\+/, "");
    }

    function isIvrTarget(value) {
        return normalizeDialTarget(value) === IVR_TARGET_NUMBER;
    }

    function isIvrSession(session) {
        return Boolean(session?.ivr?.active);
    }

    function shouldStartForSession(session, explicitTarget = "") {
        if (!session) return false;
        if (session.serviceId !== "secnum") return false;
        if (isIvrSession(session)) return true;

        const target =
            explicitTarget ||
            session?.inboundCall?.toNumber ||
            session?.toIdentity ||
            "";
        return isIvrTarget(target);
    }

    async function say(sessionId, text, reason = "ivr-custom", extra = {}) {
        if (typeof playAudioForSession === "function") {
            const played = await playAudioForSession(sessionId, text, {
                interrupt: true,
                reason,
                meta: extra,
                waitForCompletion: Boolean(extra?.waitForCompletion),
            });
            if (played) return true;
        }
        logger.warn(`[${sessionId}] IVR audio was not played for reason=${reason}`);
        return false;
    }

    async function sayFile(sessionId, fileNameOrPath, reason = "ivr-file", extra = {}) {
        if (typeof playAudioFileForSession === "function") {
            const played = await playAudioFileForSession(sessionId, fileNameOrPath, {
                interrupt: true,
                reason,
                meta: extra,
                waitForCompletion: Boolean(extra?.waitForCompletion),
                loop: Boolean(extra?.loop),
            });
            if (played) return true;
        }
        logger.warn(`[${sessionId}] IVR audio file was not played for reason=${reason}`);
        return false;
    }

    async function redirectTo(sessionId, targetEns, options = {}) {
        if (typeof redirectCallForSession !== "function") {
            logger.warn(`[${sessionId}] IVR redirect unavailable target=${targetEns}`);
            return false;
        }
        return redirectCallForSession(sessionId, targetEns, options);
    }

    function buildHandlerContext(sessionId, msg = null, meta = {}) {
        const session = sessions.get(sessionId);
        return {
            sessionId,
            session,
            msg,
            meta,
            say: (text, reason = "ivr-custom", extra = {}) => say(sessionId, text, reason, extra),
            sayFile: (fileNameOrPath, reason = "ivr-file", extra = {}) => sayFile(sessionId, fileNameOrPath, reason, extra),
            redirectTo: (targetEns, options = {}) => redirectTo(sessionId, targetEns, options),
            send: (payload) => sendDataChannelMessage(sessionId, payload),
        };
    }

    function createDefaultHandlers() {
        return {
            async onCallStart(ctx) {
                const played = await ctx.sayFile("Hello.m4a", "ivr-start-file");
                if (!played) {
                    await ctx.say(
                        "Welcome to the secnum IVR. Press any digit from zero to nine.",
                        "ivr-start",
                    );
                }
            },
            async onInvalidDigit(ctx) {
                const rawDigit = String(ctx?.msg?.digit ?? "").trim();
                await ctx.say("Only digits zero to nine are supported.", "ivr-invalid-digit", {
                    digit: rawDigit,
                    eventId: ctx?.msg?.eventId || null,
                });
            },
            onDigit0,
            onDigit1,
            onDigit2,
            onDigit3,
            onDigit4,
            onDigit5,
            onDigit6,
            onDigit7,
            onDigit8,
            onDigit9,
        };
    }

    const activeHandlers = {
        ...createDefaultHandlers(),
        ...(handlers || {}),
    };

    async function invokeHandler(name, context) {
        const fn = activeHandlers[name];
        if (typeof fn !== "function") return;
        try {
            await fn(context);
        } catch (err) {
            logger.error(`[${context.sessionId}] IVR handler ${name} failed: ${err.message}`);
        }
    }

    async function startIvr(sessionId, meta = {}) {
        const session = sessions.get(sessionId);
        if (!session) return false;
        if (session.serviceId && session.serviceId !== "secnum") return false;

        session.ivr = {
            active: true,
            target: IVR_TARGET_NUMBER,
            startedAt: Date.now(),
            source: meta.source || "unknown",
            lastDigit: null,
            waitingAudioFile: meta.waitingAudioFile || null,
        };

        sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "ivr-state",
            state: "active",
            providerId: "secnum",
            target: IVR_TARGET_NUMBER,
            source: session.ivr.source,
        });
        await invokeHandler("onCallStart", buildHandlerContext(sessionId, null, meta));
        logger.log(`[${sessionId}] IVR started for secnum target ${IVR_TARGET_NUMBER} source=${session.ivr.source}`);
        return true;
    }

    function stopIvr(sessionId, reason = "call-ended") {
        const session = sessions.get(sessionId);
        if (!session || !session.ivr?.active) return false;
        session.ivr.active = false;
        if (typeof stopAudioForSession === "function") {
            stopAudioForSession(sessionId, `ivr-stop:${reason}`).catch(() => {});
        }
        sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "ivr-state",
            state: "stopped",
            providerId: "secnum",
            target: IVR_TARGET_NUMBER,
            reason,
        });
        logger.log(`[${sessionId}] IVR stopped reason=${reason}`);
        return true;
    }

    async function handleDtmf(sessionId, msg = {}) {
        const session = sessions.get(sessionId);
        if (!session || !session.ivr?.active) return false;

        const rawDigit = String(msg?.digit ?? "").trim();
        if (!/^[0-9]$/.test(rawDigit)) {
            await invokeHandler("onInvalidDigit", buildHandlerContext(sessionId, msg));
            return true;
        }

        session.ivr.lastDigit = rawDigit;
        sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "ack",
            ackFor: "dtmf",
            digit: rawDigit,
            eventId: msg?.eventId || null,
        });
        await invokeHandler(`onDigit${rawDigit}`, buildHandlerContext(sessionId, msg));
        logger.log(`[${sessionId}] IVR handled DTMF digit=${rawDigit}`);
        return true;
    }

    return {
        isIvrTarget,
        shouldStartForSession,
        startIvr,
        stopIvr,
        handleDtmf,
        handlers: activeHandlers,
    };
}

function buildDigitExtra(ctx, digit) {
    return {
        digit,
        eventId: ctx?.msg?.eventId || null,
    };
}

async function onDigit0(ctx) {
    await ctx.say("You pressed 0.", "ivr-digit-0", buildDigitExtra(ctx, "0"));
}

async function onDigit1(ctx) {
    const played = await ctx.sayFile("One.m4a", "ivr-digit-1-file", buildDigitExtra(ctx, "1"));
    if (!played) {
        await ctx.say("You pressed 1.", "ivr-digit-1", buildDigitExtra(ctx, "1"));
    }
}

async function onDigit2(ctx) {
    const played = await ctx.sayFile("Two.m4a", "ivr-digit-2-file", buildDigitExtra(ctx, "2"));
    if (!played) {
        await ctx.say("You pressed 2.", "ivr-digit-2", buildDigitExtra(ctx, "2"));
    }
}

async function onDigit3(ctx) {
    const extra = {
        ...buildDigitExtra(ctx, "3"),
        waitForCompletion: true,
    };
    await ctx.say("redirecting to 972557012407", "ivr-digit-3-redirect", extra);
    await ctx.redirectTo("972557012407.secnumtest.global", {
        reason: "ivr-digit-3",
        waitingAudioFile: ctx.session?.ivr?.waitingAudioFile || null,
    });
}

async function onDigit4(ctx) {
    await ctx.say("You pressed 4.", "ivr-digit-4", buildDigitExtra(ctx, "4"));
}

async function onDigit5(ctx) {
    await ctx.say("You pressed 5.", "ivr-digit-5", buildDigitExtra(ctx, "5"));
}

async function onDigit6(ctx) {
    await ctx.say("You pressed 6.", "ivr-digit-6", buildDigitExtra(ctx, "6"));
}

async function onDigit7(ctx) {
    await ctx.say("You pressed 7.", "ivr-digit-7", buildDigitExtra(ctx, "7"));
}

async function onDigit8(ctx) {
    await ctx.say("You pressed 8.", "ivr-digit-8", buildDigitExtra(ctx, "8"));
}

async function onDigit9(ctx) {
    await ctx.say("You pressed 9.", "ivr-digit-9", buildDigitExtra(ctx, "9"));
}

module.exports = {
    createIvrRuntime,
};
