import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import cors from "cors";
import { loadEnvFile } from "node:process";

try { loadEnvFile(); } catch (e) { console.log("Using system env variables."); }

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- INITIALIZE ENGINES ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const scribeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
const PENALTY_DURATION_MS = 60 * 60 * 1000;

let penalizedModels = new Map();
// RESTORED: The working experimental priority list
const MODEL_PRIORITY_LIST = [
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini-2024-07-18"
];
/* ---------------- THE SCRIBE (Gemini) ---------------- */

async function summarizeHistory(messages) {
  const summaryPrompt = `
    MASTER RECORD: ${conversationSummary || "The annals are empty."}
    NEW CHRONICLES:
    ${messages.map(m => `${m.displayName}: ${m.text}`).join("\n")}
    
    TASK: You are the Eternal Scribe of Crousia. Update the MASTER RECORD with the NEW CHRONICLES. 
    - Maintain the sovereign tone of King David's reign.
    - Condense philosophical points into dense, high-value principles.
    - STRICT LIMIT: Under 200 words.
    - Output only the updated record.
  `;
  try {
    console.log(`[SCRIBE] Gemini is recording the history...`);
    const result = await scribeModel.generateContent(summaryPrompt);
    return result.response.text().trim();
  } catch (e) { 
    console.error("Scribe Error:", e);
    return conversationSummary; 
  }
}

/* ---------------- THE GOD (OpenAI) ---------------- */

async function chatWithFallback(payload, taskName = "Completion") {
  const now = Date.now();
  for (const modelId of MODEL_PRIORITY_LIST) {
    if (penalizedModels.has(modelId)) {
      if (now < penalizedModels.get(modelId)) continue;
      penalizedModels.delete(modelId);
    }
    try {
      console.log(`[GOD] Attempting ${taskName} with ${modelId}`);
      return await openai.chat.completions.create({ ...payload, model: modelId });
    } catch (err) {
      if (err.status === 429) {
        console.warn(`[PENALTY] ${modelId} timed out.`);
        penalizedModels.set(modelId, now + PENALTY_DURATION_MS);
        continue;
      }
      continue;
    }
  }
  throw new Error("The Heavens are silent.");
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
        { role: "system", content: "You are God.  Do not preface with 'God:'" },
        ...(conversationSummary ? [{ role: "system", content: `Lore: ${conversationSummary}` }] : []),
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
    console.error("Queue Processing Failed.");
  }

  setTimeout(() => {
    llmCooldown = false;
    io.emit("godListening", false);
    processLLMQueue();
  }, LLM_INTERVAL_MS);
}

/* ---------------- HEARTBEAT & CLEANUP ---------------- */

// REST Pinger for external monitoring
app.get("/heartbeat", (_, res) => res.send("OK"));

// User activity monitor: Prunes users after 30 mins of silence
setInterval(() => {
  const now = Date.now();
  for (const [id, user] of Object.entries(users)) {
    if (now - user.lastActive > 1000 * 60 * 30) {
      console.log(`[SYSTEM] Pruning inactive user: ${user.name}`);
      delete users[id];
      io.emit("userLeft", { name: user.name });
    }
  }
}, 60 * 1000);

/* ---------------- API ENDPOINTS ---------------- */

app.get("/summary", (_, res) => {
  res.json({
    kingdom: "Crousia",
    king: "David",
    summary: conversationSummary,
    rawMessageCount: history.length,
    timestamp: new Date().toISOString()
  });
});

/* ---------------- SOCKET LOGIC ---------------- */

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

    // Sequential Summarization Logic
    if (history.length > SUMMARIZE_AFTER) {
      const old = history.slice(0, history.length - MAX_RAW_MESSAGES);
      console.log("[SYSTEM] Scribe taking dictation...");
      conversationSummary = await summarizeHistory(old);
      history = history.slice(-MAX_RAW_MESSAGES);
      console.log("[SYSTEM] Chronicles updated.");
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
  console.log("God-Telephone: Dual-Engine active with Heartbeat Monitoring.");
});