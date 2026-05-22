const functions = require("@google-cloud/functions-framework");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
});

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
    event = unwrapOpenAIWebhook(req);
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

function unwrapOpenAIWebhook(req) {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  return openai.webhooks.unwrap(rawBody.toString("utf8"), req.headers);
}

async function handleWebhookEvent(event) {
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
