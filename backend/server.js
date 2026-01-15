import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import cors from "cors";
import { loadEnvFile } from "node:process";

// Native Node.js .env loading (Built-in for Node 20.6+)
try {
  loadEnvFile(); 
} catch (e) {
  console.log("No local .env file; using system environment variables.");
}

const app = express();
app.use(cors({ origin: "*" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------- STATE ---------------- */
let history = [];
let conversationSummary = "";
let users = {};

let pendingMessages = [];
let llmCooldown = false;
let unseenMessageCount = 0;

const MAX_RAW_MESSAGES = 20;
const SUMMARIZE_AFTER = 30;
const LLM_INTERVAL_MS = 20_000;

// Every request starts at the top and tries to work its way down if blocked
const MODEL_PRIORITY_LIST = [
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18"
];

const SYSTEM_PROMPT = `
You are God, a conversational participant in a shared dialogue. 
Do not preface your message with "God:" or similar.
`;

/* ---------------- HELPERS ---------------- */

/**
 * Optimized Fallback Logic:
 * Tries the best models first for every single call.
 */
async function chatWithFallback(payload, taskName = "Completion") {
  for (const modelId of MODEL_PRIORITY_LIST) {
    try {
      console.log(`[${new Date().toISOString()}] Attempting ${taskName} with: ${modelId}`);
      
      const response = await openai.chat.completions.create({
        ...payload,
        model: modelId,
      });

      console.log(`[SUCCESS] ${taskName} completed using ${modelId}`);
      return response;

    } catch (err) {
      // 429 = Rate Limit or Quota. If we hit this, we try the next model immediately.
      if (err.status === 429 || err.message.toLowerCase().includes("quota")) {
        console.warn(`[FALLBACK] ${modelId} reached limit. Trying next...`);
        continue;
      }
      console.error(`[CRITICAL ERROR] ${modelId} failed:`, err.message);
      throw err; 
    }
  }
  throw new Error("All models currently exhausted for this window.");
}

async function summarizeHistory(messages) {
  const summaryPrompt = `Summarize conversation. Preserve themes:\n${messages.map(m => `${m.displayName}: ${m.text}`).join("\n")}`;
  
  const result = await chatWithFallback({
    messages: [
      { role: "system", content: "You summarize conversations." },
      { role: "user", content: summaryPrompt }
    ],
    temperature: 0.3
  }, "Summarization");
  
  return result.choices[0].message.content.trim();
}

async function processLLMQueue() {
  if (llmCooldown || pendingMessages.length === 0) return;

  llmCooldown = true;
  io.emit("godListening", true);

  const batch = [...pendingMessages];
  pendingMessages = [];
  unseenMessageCount = 0;
  io.emit("newMessagesPending", 0);

  try {
    const completion = await chatWithFallback({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(conversationSummary ? [{ role: "system", content: `History: ${conversationSummary}` }] : []),
        ...history.map(m => ({ role: "user", content: `${m.displayName}: ${m.text}` })),
        { role: "user", content: "Respond to:\n" + batch.map(m => `${m.displayName}: ${m.text}`).join("\n") }
      ],
      temperature: 0.7
    }, "God Response");

    let reply = completion.choices[0].message.content.trim().replace(/^God:\s*/i, "");

    const llmMsg = { userID: "llm", displayName: "God", text: reply, timestamp: Date.now() };
    history.push(llmMsg);
    io.emit("message", llmMsg);

  } catch (err) {
    console.error("LLM Queue Processing Failed:", err.message);
  }

  setTimeout(() => {
    llmCooldown = false;
    io.emit("godListening", false);
    processLLMQueue();
  }, LLM_INTERVAL_MS);
}

/* ---------------- HEARTBEAT ---------------- */
// Cleans up users who haven't sent a message or active status in 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, user] of Object.entries(users)) {
    if (now - user.lastActive > 1000 * 60 * 30) {
      console.log(`User ${user.name} timed out.`);
      delete users[id];
      io.emit("userLeft", { name: user.name });
    }
  }
}, 60 * 1000);

app.get("/heartbeat", (_, res) => res.send("OK"));

/* ---------------- SOCKET.IO ---------------- */
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join", ({ name }) => {
    users[socket.id] = { name, lastActive: Date.now() };
    socket.emit("history", history);
    socket.emit("godListening", llmCooldown);
    socket.emit("newMessagesPending", unseenMessageCount);
    io.emit("userJoined", { name });
  });

  socket.on("message", async ({ text }) => {
    const user = users[socket.id];
    if (!user) return;
    user.lastActive = Date.now();

    const msg = { userID: socket.id, displayName: user.name, text, timestamp: Date.now() };
    history.push(msg);
    io.emit("message", msg);
    unseenMessageCount++;
    io.emit("newMessagesPending", unseenMessageCount);

    if (text.startsWith("/")) return;

    if (history.length > SUMMARIZE_AFTER) {
      const old = history.slice(0, history.length - MAX_RAW_MESSAGES);
      try {
        conversationSummary = await summarizeHistory(old);
        history = history.slice(-MAX_RAW_MESSAGES);
      } catch (e) { console.error("Summary error:", e); }
    }

    pendingMessages.push(msg);
    processLLMQueue();
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      delete users[socket.id];
      io.emit("userLeft", { name: user.name });
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("God-Telephone Server Active - Fallback Logging Enabled");
});