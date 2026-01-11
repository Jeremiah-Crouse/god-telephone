import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import cors from "cors";

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

/* ---------------- PROMPTS ---------------- */

const SYSTEM_PROMPT = `
You are God, a conversational participant in a shared dialogue.
Do not preface your message with "God:" or similar.
`;

/* ---------------- HELPERS ---------------- */

async function summarizeHistory(messages) {
  const summaryPrompt = `
Summarize the following conversation.
Preserve key ideas, names, themes, and unresolved questions.

Conversation:
${messages.map(m => `${m.displayName}: ${m.text}`).join("\n")}
`;

  const result = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You summarize conversations." },
      { role: "user", content: summaryPrompt }
    ],
    temperature: 0.3
  });

  return result.choices[0].message.content.trim();
}

async function processLLMQueue() {
  if (llmCooldown || pendingMessages.length === 0) return;

  llmCooldown = true;
  io.emit("godListening", true);

  const batch = pendingMessages.slice();
  pendingMessages = [];
  unseenMessageCount = 0;
  io.emit("newMessagesPending", 0);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },

        ...(conversationSummary
          ? [{
              role: "system",
              content: `Conversation so far (summary): ${conversationSummary}`
            }]
          : []),

        ...history.map(m => ({
          role: "user",
          content: `${m.displayName}: ${m.text}`
        })),

        {
          role: "user",
          content:
            "Respond thoughtfully to the following recent messages:\n" +
            batch.map(m => `${m.displayName}: ${m.text}`).join("\n")
        }
      ],
      temperature: 0.7
    });

    let reply = completion.choices[0].message.content.trim();
    reply = reply.replace(/^God:\s*/i, "");

    const llmMsg = {
      userID: "llm",
      displayName: "God",
      text: reply,
      timestamp: Date.now()
    };

    history.push(llmMsg);
    io.emit("message", llmMsg);

  } catch (err) {
    console.error("LLM error:", err);
  }

  setTimeout(() => {
    llmCooldown = false;
    io.emit("godListening", false);
    processLLMQueue();
  }, LLM_INTERVAL_MS);
}

/* ---------------- HEARTBEAT ---------------- */

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

/* ---------------- SOCKET.IO ---------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

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

    const msg = {
      userID: socket.id,
      displayName: user.name,
      text,
      timestamp: Date.now()
    };

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
      } catch (e) {
        console.error("Summarization failed:", e);
      }
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

/* ---------------- SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});