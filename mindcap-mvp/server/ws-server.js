/**
 * MindCap WebSocket Server — Xiaozhi ESP32 Protocol Compatible
 *
 * Implements the Xiaozhi WebSocket protocol for emotion-aware voice interaction.
 * Handles: hello handshake, audio channel, MCP device control, emotion display.
 *
 * Step 1: Text-based control (no Opus audio processing yet)
 */

const { WebSocketServer } = require("ws");

let wss = null;
let deviceConnection = null; // Single device support for now
let onMessageCallback = null;
const WS_PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : 5052;

// ── Emotion → LED color mapping ──────────────────────────────────

const EMOTION_LED_COLORS = {
  calm:     { r: 68, g: 255, b: 136 },  // green
  neutral:  { r: 200, g: 200, b: 220 }, // soft white
  stress:   { r: 255, g: 136, b: 0 },   // orange
  sad:      { r: 100, g: 100, b: 255 }, // blue
  anxiety:  { r: 255, g: 68, b: 68 },   // red
};

const EMOTION_DISPLAY_ICONS = {
  calm:     "😊",
  neutral:  "😐",
  stress:   "😰",
  sad:      "😢",
  anxiety:  "😨",
};

// ── MCP command builders ──────────────────────────────────────────

let mcpIdCounter = 0;
function nextMcpId() { return ++mcpIdCounter; }

function buildMcpLedCommand(label) {
  const color = EMOTION_LED_COLORS[label] || EMOTION_LED_COLORS.neutral;
  return JSON.stringify({
    session_id: "mindcap",
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "self.light.set_rgb",
        arguments: { r: color.r, g: color.g, b: color.b }
      },
      id: nextMcpId()
    }
  });
}

function buildMcpDisplayCommand(label, text) {
  const icon = EMOTION_DISPLAY_ICONS[label] || "🤖";
  return JSON.stringify({
    session_id: "mindcap",
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "self.display.show",
        arguments: { text: `${icon} ${text || ""}` }
      },
      id: nextMcpId()
    }
  });
}

function buildLlmEmotionCommand(label, text) {
  return JSON.stringify({
    session_id: "mindcap",
    type: "llm",
    emotion: label,
    text: text || EMOTION_DISPLAY_ICONS[label] || "😐"
  });
}

function buildTtsCommand(state, text) {
  const msg = { session_id: "mindcap", type: "tts", state };
  if (text) msg.text = text;
  return JSON.stringify(msg);
}

function buildSttCommand(text) {
  return JSON.stringify({ session_id: "mindcap", type: "stt", text });
}

function buildCustomCommand(payload) {
  return JSON.stringify({ session_id: "mindcap", type: "custom", payload });
}

// ── Session tracking ──────────────────────────────────────────────

let currentSession = {
  sessionId: null,
  emotionLabel: "neutral",
  listening: false,
  speaking: false,
  connectedAt: null,
};

// ── Public API ────────────────────────────────────────────────────

function start(port = WS_PORT) {
  wss = new WebSocketServer({ port, host: "127.0.0.1" });

  wss.on("listening", () => {
    console.log(`WebSocket server running on ws://127.0.0.1:${port}`);
  });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`Device connected from ${clientIp}`);

    deviceConnection = ws;
    currentSession.connectedAt = new Date().toISOString();

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // Opus audio, skip for now
      handleJsonMessage(ws, data.toString());
    });
    ws.on("close", () => {
      console.log("Device disconnected");
      deviceConnection = null;
      currentSession.listening = false;
    });
    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      deviceConnection = null;
    });
  });

  return wss;
}

function stop() {
  if (wss) {
    wss.close();
    wss = null;
    deviceConnection = null;
  }
}

function isConnected() {
  return deviceConnection !== null && deviceConnection.readyState === 1;
}

function sendToDevice(jsonString) {
  if (isConnected()) {
    deviceConnection.send(jsonString);
  }
}

/** Called from server.js when emotion changes */
function broadcastEmotion(label, confidence, reason) {
  if (!isConnected()) return;

  currentSession.emotionLabel = label;

  // Send LED color change
  sendToDevice(buildMcpLedCommand(label));

  // Send display update
  const icon = EMOTION_DISPLAY_ICONS[label] || "🤖";
  sendToDevice(buildLlmEmotionCommand(label, `${icon} ${label}`));
}

/** Called from server.js when chat reply is generated */
function sendChatReply(text, emotionLabel) {
  if (!isConnected()) return;

  const label = emotionLabel || currentSession.emotionLabel;

  // Send LED color based on emotion
  sendToDevice(buildMcpLedCommand(label));

  // Send display update
  sendToDevice(buildLlmEmotionCommand(label, text.substring(0, 60)));

  // Send as custom message (text reply for device to speak)
  sendToDevice(buildCustomCommand({
    message: text,
    emotion: label,
    action: "speak"
  }));
}

function getState() {
  return {
    connected: isConnected(),
    ...currentSession
  };
}

// ── Message handler ───────────────────────────────────────────────

function handleJsonMessage(ws, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    console.error("Invalid JSON from device:", text.substring(0, 100));
    return;
  }

  console.log("Device →", JSON.stringify(msg).substring(0, 120));

  switch (msg.type) {
    case "hello":
      handleHello(ws, msg);
      break;
    case "listen":
      handleListen(ws, msg);
      break;
    case "abort":
      currentSession.listening = false;
      currentSession.speaking = false;
      break;
    case "mcp":
      // Device reporting MCP result
      break;
    default:
      // Forward unknown types to callback if registered
      if (onMessageCallback) {
        onMessageCallback(msg);
      }
  }
}

function handleHello(ws, msg) {
  console.log("Device hello. Version:", msg.version, "Features:", msg.features);

  const sessionId = "mindcap_" + Date.now();
  currentSession.sessionId = sessionId;

  const response = {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: msg.audio_params || {
      format: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60
    }
  };
  ws.send(JSON.stringify(response));
  console.log("Hello response sent, session:", sessionId);
}

function handleListen(ws, msg) {
  currentSession.listening = msg.state === "start" || msg.state === "detect";
  currentSession.mode = msg.mode || "manual";
  console.log("Device listen state:", msg.state, "mode:", msg.mode);

  if (msg.state === "detect" && msg.text) {
    // Wake word detected with text
    console.log("Wake word text:", msg.text);

    // Auto-reply with emotion context
    const emotionLabel = currentSession.emotionLabel || "neutral";
    sendToDevice(buildSttCommand(msg.text));
    sendToDevice(buildMcpLedCommand(emotionLabel));
    sendToDevice(buildLlmEmotionCommand(emotionLabel, `听到你了 (${emotionLabel})`));
  }
}

module.exports = {
  start,
  stop,
  isConnected,
  sendToDevice,
  broadcastEmotion,
  sendChatReply,
  getState,
  // Command builders (exported for testing)
  buildMcpLedCommand,
  buildLlmEmotionCommand,
  buildCustomCommand,
};
