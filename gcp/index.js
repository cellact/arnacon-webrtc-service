const functions = require("@google-cloud/functions-framework");
const OpenAI = require("openai");
const WebSocket = require("ws");

const EVENT_HANDLERS = {
  "realtime.call.incoming": handleRealtimeCallIncoming,
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

  await beforeAcceptRealtimeCall(event);
  await acceptRealtimeCall(callId, buildRealtimeAcceptConfig(event));
  startRealtimeCallMonitor(callId);
  await afterAcceptRealtimeCall(event);
}

async function beforeAcceptRealtimeCall(event) {
  console.log("Incoming OpenAI SIP call:", {
    eventId: event.id,
    callId: event.data.call_id,
    sipHeaders: summarizeSipHeaders(event.data.sip_headers || []),
  });
}

function buildRealtimeAcceptConfig() {
  return {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    voice: process.env.OPENAI_REALTIME_VOICE || "alloy",
    instructions:
      process.env.OPENAI_REALTIME_INSTRUCTIONS ||
      "You are a helpful phone assistant for Arnacon.",
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

function startRealtimeCallMonitor(callId) {
  const websocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    },
  );

  websocket.on("open", () => {
    console.log("OpenAI realtime monitor connected:", { callId });
    websocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: "Say to the user: Thank you for calling, how can I help you?",
        },
      }),
    );
  });

  websocket.on("message", (data) => {
    console.log("OpenAI realtime event:", data.toString());
  });

  websocket.on("error", (error) => {
    console.error("OpenAI realtime monitor error:", {
      callId,
      error: error.message,
    });
  });

  websocket.on("close", (code, reason) => {
    console.log("OpenAI realtime monitor closed:", {
      callId,
      code,
      reason: reason.toString(),
    });
  });
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
