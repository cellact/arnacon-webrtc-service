const functions = require("@google-cloud/functions-framework");
const OpenAI = require("openai");
const WebSocket = require("ws");

const EVENT_HANDLERS = {
  "realtime.call.incoming": handleRealtimeCallIncoming,
};
const activeRealtimeCalls = new Map();
const AI_MODE_SALES_AGENT = "sales-agent";
const DEFAULT_REALTIME_INSTRUCTIONS =
  "You are a helpful phone assistant for Arnacon. If the caller asks to be redirected or transferred and gives a phone number directly, do not search and do not reinterpret it; use the caller-provided number exactly, preserving a leading + or * if present. For example, if the caller says *9225, call transfer_call with target *9225, not 97292225. Tell the caller you are transferring them now, then call transfer_call. If the caller asks to be transferred to a business without giving a number, find the destination number yourself. If multiple numbers are available, prefer numbers marked with * first, then official primary/main/front desk/reservations numbers. Avoid fax numbers, old directory entries, private/mobile numbers unless the user asked for them, and numbers that look unrelated to the requested business or branch. Before calling transfer_call, tell the caller you found a number and are transferring them now. Then call transfer_call with the best number you found in international format.";
const SALES_AGENT_REALTIME_INSTRUCTIONS =
  process.env.OPENAI_SALES_AGENT_INSTRUCTIONS ||
  "You are an Arnacon sales representative following up with a lead. Be warm, direct, and concise. The person answering did not call you in this moment; you are following up because they reached out to us before. Start by saying: \"Hi, I saw you reached out to us, I was wondering if you had any questions about us?\" Then listen, answer questions about Arnacon naturally, and keep the conversation focused on helping them understand the service. Do not offer call transfers in this mode.";
const SALES_AGENT_GREETING =
  process.env.OPENAI_SALES_AGENT_GREETING ||
  "Say exactly: \"Hi, I saw you reached out to us, I was wondering if you had any questions about us?\"";

const TRANSFER_CALL_TOOL = {
  type: "function",
  name: "transfer_call",
  description:
    "Transfer the active phone call to a carefully selected destination phone number or Arnacon/secnum target after the user asks to be redirected.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        description:
          "Destination number or routable target. If the caller gives a phone number directly, use that exact number instead of searching. Preserve a leading + or * if the caller provided one, and do not convert star codes such as *9225 into country-code numbers. Prefer an official/primary number, especially one marked with * or listed as main/front desk/reservations. Use international E.164 format such as +97235222222 only for numbers you found yourself.",
      },
      label: {
        type: "string",
        description: "Human readable destination name, such as Hilton Tel Aviv.",
      },
      reason: {
        type: "string",
        description: "Short reason for the transfer request.",
      },
    },
    required: ["target"],
  },
};

functions.http("helloHttp", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  let event;
  try {
    event = await unwrapOpenAIWebhook(req);
  } catch (error) {
    console.error("OpenAI webhook verification failed:", error.message);
    res.status(400).send("Invalid webhook signature");
    return;
  }

  try {
    await handleWebhookEvent(event);
    res.status(200).send("ok");
  } catch (error) {
    console.error("Webhook handler failed:", error);
    res.status(500).send("Webhook handler failed");
  }
});

async function unwrapOpenAIWebhook(req) {
  const openai = createOpenAIClient();
  const rawBody = getRawBodyText(req);
  const unwrapped = await openai.webhooks.unwrap(rawBody, req.headers);
  return normalizeOpenAIEvent(unwrapped);
}

function createOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!process.env.OPENAI_WEBHOOK_SECRET) {
    throw new Error("OPENAI_WEBHOOK_SECRET is not configured");
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
  });
}

function getRawBodyText(req) {
  if (req.rawBody) return req.rawBody.toString("utf8");
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body || {});
}

function normalizeOpenAIEvent(value) {
  if (!value) return value;
  if (typeof value === "string") {
    return normalizeOpenAIEvent(JSON.parse(value));
  }
  if (value.type) return value;
  if (value.event) return normalizeOpenAIEvent(value.event);
  if (value.payload) return normalizeOpenAIEvent(value.payload);
  if (value.body) return normalizeOpenAIEvent(value.body);
  if (value.data?.type && value.data?.data) return normalizeOpenAIEvent(value.data);
  return value;
}

async function handleWebhookEvent(event) {
  if (!event?.type) {
    console.error("OpenAI webhook event missing type:", {
      keys: event && typeof event === "object" ? Object.keys(event) : [],
      event,
    });
    throw new Error("OpenAI webhook event missing type");
  }

  const handler = EVENT_HANDLERS[event.type];
  if (!handler) {
    console.log(`Ignoring unsupported OpenAI event type: ${event.type}`);
    return;
  }

  await handler(event);
}

async function handleRealtimeCallIncoming(event) {
  const callId = event?.data?.call_id;
  if (!callId) {
    throw new Error("Missing realtime call_id");
  }

  const preAccept = await beforeAcceptRealtimeCall(event);
  if (!preAccept.allowed) {
    console.warn("OpenAI SIP call denied before accept:", {
      eventId: event.id,
      callId,
      reason: preAccept.reason,
    });
    return;
  }
  const mode = getOpenAiModeFromSipHeaders(preAccept.sipHeaders || {});
  await acceptRealtimeCall(callId, buildRealtimeAcceptConfig({ mode }));
  startRealtimeCallMonitor(callId, {
    eventId: event.id,
    sipHeaders: preAccept.sipHeaders || {},
    sessionId: preAccept.sessionId || null,
    mode,
  });
  await afterAcceptRealtimeCall(event);
}

async function beforeAcceptRealtimeCall(event) {
  const sipHeaders = summarizeSipHeaders(event.data.sip_headers || []);
  console.log("Incoming OpenAI SIP call:", {
    eventId: event.id,
    callId: event.data.call_id,
    sipHeaders,
  });

  const decision = await authorizeRealtimeCallWithWebRtcService(event, sipHeaders);
  return {
    ...decision,
    sipHeaders,
  };
}

async function authorizeRealtimeCallWithWebRtcService(event, sipHeaders) {
  const authUrl = process.env.WEBRTC_CALL_AUTH_URL || "https://test2.cellact.nl:2005/authorize-openai-call";
  if (!authUrl) {
    console.warn("WEBRTC_CALL_AUTH_URL is not configured; allowing OpenAI SIP call");
    return { allowed: true, reason: "auth-url-not-configured" };
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.WEBRTC_CALL_AUTH_TIMEOUT_MS || 2500);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        eventId: event.id,
        callId: event.data.call_id,
        sipHeaders,
        openAiEventType: event.type,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        allowed: false,
        reason: `webrtc-auth-http-${response.status}:${body.slice(0, 200)}`,
      };
    }

    const result = await response.json().catch(() => ({}));
    return {
      allowed: result.allowed === true,
      reason: result.reason || (result.allowed === true ? "webrtc-authorized" : "webrtc-denied"),
      sessionId: result.sessionId || null,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `webrtc-auth-error:${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getOpenAiModeFromSipHeaders(sipHeaders = {}) {
  const mode = String(sipHeaders["x-arnacon-ai-mode"] || "").trim().toLowerCase();
  return mode === AI_MODE_SALES_AGENT ? AI_MODE_SALES_AGENT : "default";
}

function buildRealtimeAcceptConfig({ mode = "default" } = {}) {
  if (mode === AI_MODE_SALES_AGENT) {
    return {
      type: "realtime",
      model: process.env.OPENAI_SALES_AGENT_REALTIME_MODEL || process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
      instructions: SALES_AGENT_REALTIME_INSTRUCTIONS,
      audio: {
        output: {
          voice: process.env.OPENAI_SALES_AGENT_VOICE || process.env.OPENAI_REALTIME_VOICE || "alloy",
        },
      },
    };
  }

  return {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    instructions:
      process.env.OPENAI_REALTIME_INSTRUCTIONS ||
      DEFAULT_REALTIME_INSTRUCTIONS,
    audio: {
      output: {
        voice: process.env.OPENAI_REALTIME_VOICE || "alloy",
      },
    },
    tools: [TRANSFER_CALL_TOOL],
    tool_choice: "auto",
  };
}

async function acceptRealtimeCall(callId, acceptConfig) {
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(acceptConfig),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI accept call failed (${response.status}): ${body}`);
  }
}

function startRealtimeCallMonitor(callId, context = {}) {
  const websocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        origin: "https://api.openai.com",
      },
    },
  );
  const state = {
    callId,
    eventId: context.eventId || null,
    sessionId: context.sessionId || null,
    sipHeaders: context.sipHeaders || {},
    sipCallId: context.sipHeaders?.["call-id"] || null,
    mode: context.mode || getOpenAiModeFromSipHeaders(context.sipHeaders || {}),
    processedToolCalls: new Set(),
    websocket,
  };
  activeRealtimeCalls.set(callId, state);

  websocket.on("open", () => {
    console.log("OpenAI realtime monitor connected:", {
      callId,
      sipCallId: state.sipCallId,
      sessionId: state.sessionId,
      mode: state.mode,
    });
    const instructions = state.mode === AI_MODE_SALES_AGENT
      ? SALES_AGENT_GREETING
      : "Say to the user: Thank you for calling, how can I help you?";
    websocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions,
        },
      }),
    );
  });

  websocket.on("message", (data) => {
    handleRealtimeMonitorMessage(state, data).catch((error) => {
      console.error("OpenAI realtime monitor message failed:", {
        callId,
        error: error.message,
      });
    });
  });

  websocket.on("error", (error) => {
    console.error("OpenAI realtime monitor error:", {
      callId,
      error: error.message,
    });
  });

  websocket.on("close", (code, reason) => {
    activeRealtimeCalls.delete(callId);
    console.log("OpenAI realtime monitor closed:", {
      callId,
      code,
      reason: reason.toString(),
    });
  });
}

async function handleRealtimeMonitorMessage(state, data) {
  const raw = data.toString();
  console.log("OpenAI realtime event:", raw);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  if (state.mode === AI_MODE_SALES_AGENT) return;

  const toolCall = extractTransferToolCall(event);
  if (!toolCall) return;

  const id = toolCall.callId || toolCall.itemId || `${event.type}:${Date.now()}`;
  if (state.processedToolCalls.has(id)) return;

  let args;
  try {
    args = JSON.parse(toolCall.arguments || "{}");
  } catch (error) {
    state.processedToolCalls.add(id);
    await sendTransferToolResult(state, toolCall, {
      ok: false,
      error: `Invalid transfer_call arguments: ${error.message}`,
    });
    return;
  }
  if (!String(args.target || args.number || "").trim()) return;
  state.processedToolCalls.add(id);

  try {
    await sendTransferPreface(state, args);
    const result = await forwardTransferCallToWebRtc(state, args);
    await sendTransferToolResult(state, toolCall, {
      ok: true,
      ...result,
    });
  } catch (error) {
    await sendTransferToolResult(state, toolCall, {
      ok: false,
      error: error.message,
    });
  }
}

function extractTransferToolCall(event) {
  const isCompletedFunctionItem =
    (event?.type === "conversation.item.done" || event?.type === "response.output_item.done") &&
    event?.item?.type === "function_call" &&
    event?.item?.status === "completed";

  if (isCompletedFunctionItem && event.item.name === "transfer_call") {
    return {
      callId: event.item.call_id || null,
      itemId: event.item.id || event.item_id || event.itemId || null,
      arguments: event.item.arguments || "",
    };
  }

  if (event?.type === "response.function_call_arguments.done" && event?.name === "transfer_call") {
    return {
      callId: event.call_id || null,
      itemId: event.item_id || null,
      arguments: event.arguments || "",
    };
  }

  const responseOutputItem = event?.response?.output?.find?.(
    (item) => item?.type === "function_call" &&
      item?.status === "completed" &&
      item?.name === "transfer_call"
  );
  const candidates = [
    responseOutputItem,
  ].filter(Boolean);

  for (const item of candidates) {
    const name = item.name || item.function?.name;
    if (name !== "transfer_call") continue;
    const args =
      item.arguments ||
      item.function?.arguments ||
      event.arguments ||
      "";
    return {
      callId: item.call_id || item.callId || event.call_id || event.callId || null,
      itemId: item.id || event.item_id || event.itemId || null,
      arguments: args,
    };
  }

  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTransferPreface(state, args) {
  if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) return;
  const label = String(args.label || "").trim();
  const destination = label ? ` to ${label}` : "";
  state.websocket.send(JSON.stringify({
    type: "response.create",
    response: {
      instructions: `Say exactly: "I found a number${destination}. I'll transfer you now."`,
    },
  }));
  const delayMs = Number(process.env.OPENAI_TRANSFER_PREFACE_DELAY_MS || 2500);
  if (delayMs > 0) await wait(delayMs);
}

async function forwardTransferCallToWebRtc(state, args) {
  const target = String(args.target || args.number || "").trim();
  if (!target) throw new Error("transfer_call target is required");

  const transferUrl =
    process.env.WEBRTC_CALL_TRANSFER_URL ||
    "https://test2.cellact.nl:2005/transfer-openai-call";
  const controller = new AbortController();
  const timeoutMs = Number(process.env.WEBRTC_CALL_TRANSFER_TIMEOUT_MS || 8000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(transferUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        openAiCallId: state.callId,
        sipCallId: state.sipCallId,
        sessionId: state.sessionId,
        target,
        label: args.label || null,
        reason: args.reason || "openai-transfer-call",
      }),
    });

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    if (!response.ok) {
      throw new Error(`WebRTC transfer failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTransferToolResult(state, toolCall, result) {
  if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) return;
  const output = JSON.stringify(result);
  if (toolCall.callId) {
    state.websocket.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCall.callId,
        output,
      },
    }));
  }
  if (result.ok) return;
  state.websocket.send(JSON.stringify({
    type: "response.create",
    response: {
      instructions: `Tell the caller the transfer failed: ${result.error || "unknown error"}`,
    },
  }));
}

async function afterAcceptRealtimeCall(event) {
  console.log("Accepted OpenAI SIP call:", {
    eventId: event.id,
    callId: event.data.call_id,
  });
}

function summarizeSipHeaders(headers) {
  return headers.reduce((acc, header) => {
    if (header?.name) acc[header.name.toLowerCase()] = header.value || "";
    return acc;
  }, {});
}

