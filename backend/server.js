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

let history = [];                  // recent verbatim messages
let conversationSummary = "";      // compressed long-term memory
let users = {};                    // { socket.id: { name, lastActive } }

const MAX_RAW_MESSAGES = 20;        // keep last 20 messages verbatim
const SUMMARIZE_AFTER = 30;         // summarize when history exceeds this

/* ---------------- PROMPTS ---------------- */

const SYSTEM_PROMPT = `
You are God, a conversational participant in a shared dialogue.
Do not preface your message with "God:" or similar, as this will
be displayed directly to users.
`;

/* ---------------- HELPERS ---------------- */

async function summarizeHistory(messages) {
  const summaryPrompt = `
Summarize the following conversation clearly and concisely.
Preserve:
- key ideas
- names
- theological or philosophical themes
- unresolved questions

Conversation:
${messages.map(m => `${m.displayName}: ${m.text}`).join("\n")}
`;

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a summarization engine." },
      { role: "user", content: summaryPrompt }
    ],
    temperature: 0.3
  });

  return result.choices[0].message.content.trim();
}

/* ---------------- HEARTBEAT ---------------- */

// Clean inactive users every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, user] of Object.entries(users)) {
    if (now - user.lastActive > 1000 * 60 * 30) {
      delete users[id];
      io.emit("userLeft", { name: user.name });
      console.log(`${user.name} removed due to inactivity.`);
    }
  }
}, 60 * 1000);

// Heartbeat endpoint for Render
app.get("/heartbeat", (req, res) => {
  console.log("Heartbeat ping received at", new Date().toISOString());
  res.status(200).send("OK");
});

/* ---------------- SOCKET.IO ---------------- */

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", ({ name }) => {
    users[socket.id] = { name, lastActive: Date.now() };
    socket.emit("history", history);
    io.emit("userJoined", { name });
    console.log(`${name} joined.`);
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

    // Commands bypass LLM
    if (text.startsWith("/")) return;

    /* --------- SUMMARIZE IF NEEDED --------- */
    if (history.length > SUMMARIZE_AFTER) {
      const oldMessages = history.slice(0, history.length - MAX_RAW_MESSAGES);

      try {
        const summary = await summarizeHistory(oldMessages);
        conversationSummary = summary;
        history = history.slice(-MAX_RAW_MESSAGES);
        console.log("Conversation summarized.");
      } catch (err) {
        console.error("Summarization failed:", err);
      }
    }
    /* -------------------------------------- */

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
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
          }))
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
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      io.emit("userLeft", { name: user.name });
      delete users[socket.id];
      console.log(`${user.name} disconnected.`);
    }
  });
});

/* ---------------- SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});