class OpenAiTransferController {
    constructor({ activeCalls, sessions, onTransferOpenAiCall = null }) {
        this.activeCalls = activeCalls;
        this.sessions = sessions;
        this.onTransferOpenAiCall = onTransferOpenAiCall;
    }

    find(body = {}) {
        const sessionId = String(body.sessionId || "").trim();
        if (sessionId && this.activeCalls.has(sessionId)) {
            return this.activeCalls.get(sessionId);
        }

        const sipCallId = String(body.sipCallId || body.sip_call_id || "").trim();
        const openAiCallId = String(body.openAiCallId || body.callId || body.call_id || "").trim();
        for (const call of this.activeCalls.values()) {
            if (sipCallId && call.callId === sipCallId) return call;
            if (openAiCallId && call.openAiCallId === openAiCallId) return call;
        }
        return null;
    }

    async transfer(body = {}) {
        if (typeof this.onTransferOpenAiCall !== "function") {
            throw Object.assign(new Error("OpenAI call transfer is not configured"), { statusCode: 501 });
        }
        const call = this.find(body);
        if (!call) {
            throw Object.assign(new Error("No active OpenAI SIP call matched transfer request"), { statusCode: 404 });
        }
        const target = String(body.target || body.number || "").trim();
        if (!target) {
            throw Object.assign(new Error("transfer target is required"), { statusCode: 400 });
        }

        const session = this.sessions.get(call.sessionId);
        if (!session) {
            throw Object.assign(new Error("matched OpenAI SIP call has no active WebRTC session"), { statusCode: 404 });
        }

        const result = await this.onTransferOpenAiCall({
            sessionId: call.sessionId,
            sipCallId: call.callId,
            openAiCallId: call.openAiCallId || body.openAiCallId || body.callId || null,
            target,
            label: body.label || null,
            reason: body.reason || "openai-transfer-call",
        });
        return {
            ok: true,
            sessionId: call.sessionId,
            sipCallId: call.callId,
            openAiCallId: call.openAiCallId || null,
            target,
            ...result,
        };
    }
}

module.exports = {
    OpenAiTransferController,
};
