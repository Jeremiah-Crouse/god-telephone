import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import cors from "cors";
import { loadEnvFile } from "node:process";

try { loadEnvFile(); } catch (e) { console.log("Using system env variables."); }

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
const PENALTY_DURATION_MS = 60 * 60 * 1000; // 1 Hour

// The "Penalty Box" - stores modelId: unlockTimestamp
let penalizedModels = new Map();

const MODEL_PRIORITY_LIST = [
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18"
];

/* ---------------- HELPERS ---------------- */

async function chatWithFallback(payload, taskName = "Completion") {
  const now = Date.now();

  for (const modelId of MODEL_PRIORITY_LIST) {
    // Check if model is in the penalty box
    if (penalizedModels.has(modelId)) {
      const unlockTime = penalizedModels.get(modelId);
      if (now < unlockTime) {
        // Still penalized, skip silently and instantly
        continue;
      } else {
        // Penalty expired, clean it up
        penalizedModels.delete(modelId);
      }
    }

    try {
      console.log(`[${new Date().toISOString()}] Attempting ${taskName} with: ${modelId}`);
      const response = await openai.chat.completions.create({ ...payload, model: modelId });
      console.log(`[SUCCESS] ${taskName} using ${modelId}`);
      return response;

    } catch (err) {
      if (err.status === 429 || err.message.toLowerCase().includes("quota")) {
        console.warn(`[PENALIZING] ${modelId} failed. Putting in 1-hour timeout.`);
        penalizedModels.set(modelId, Date.now() + PENALTY_DURATION_MS);
        continue; // Immediately try the next non-penalized model
      }
      throw err; 
    }
  }
  throw new Error("All models are currently in the penalty box.");
}

/* ---------------- LOGIC ---------------- */

async function summarizeHistory(messages) {
  const summaryPrompt = `
    MASTER RECORD: ${conversationSummary || "No previous history."}
    
    NEW UPDATES:
    ${messages.map(m => `${m.displayName}: ${m.text}`).join("\n")}
    
    TASK: Update the MASTER RECORD with the NEW UPDATES. 
    - Maintain the core narrative of Crousia and the King's decrees.
    - STRICT LIMIT: Keep the final output under 500 words. 
    - If the record is getting too long, consolidate older details but keep the most important facts.
  `;

  try {
    const result = await chatWithFallback({
      messages: [
        { role: "system", content: "You are the Eternal Scribe of Crousia. You specialize in dense, recursive summarization." },
        { role: "user", content: summaryPrompt }
      ],
      temperature: 0.3
    }, "Summarization");
    
    return result.choices[0].message.content.trim();
  } catch (e) { 
    return conversationSummary; 
  }
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
        { role: "system", content: "You are God. Do not preface with 'God:'." },
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
    console.error("Queue Processing Failed: All models penalized.");
  }

  setTimeout(() => {
    llmCooldown = false;
    io.emit("godListening", false);
    processLLMQueue();
  }, LLM_INTERVAL_MS);
}

/* ---------------- HEARTBEAT & SOCKETS ---------------- */

setInterval(() => {
  const now = Date.now();
  for (const [id, user] of Object.entries(users)) {
    if (now - user.lastActive > 1000 * 60 * 30) {
      delete users[id];
      io.emit("userLeft", { name: user.name });
    }
  }
}, 60 * 1000);

app.get("/heartbeat", (_, res) => res.send("OK"));

// Access the Royal Archives via Terminal
app.get("/summary", (_, res) => {
  res.json({
    kingdom: "Crousia",
    king: "David",
    summary: conversationSummary,
    rawMessageCount: history.length,
    timestamp: new Date().toISOString()
  });
});

io.on("connection", (socket) => {
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
      conversationSummary = await summarizeHistory(old);
      history = history.slice(-MAX_RAW_MESSAGES);
    }
    pendingMessages.push(msg);
    processLLMQueue();
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) { delete users[socket.id]; io.emit("userLeft", { name: user.name }); }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("God-Telephone Server Active with 1-Hour Penalty Logic");
});