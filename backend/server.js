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

let history = [];  // store all messages
let users = {};    // { socket.id: { name, lastActive } }

const SYSTEM_PROMPT = `
You are a conversational participant in a shared dialogue.
Do not preface your message with "GodLLM:" or similar.
Be concise.
`;

// Heartbeat: clean inactive users every 30 min
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

// Heartbeat GET endpoint for cronjobs
app.get("/heartbeat", (req, res) => {
  console.log("Heartbeat ping received at", new Date().toISOString());
  res.status(200).send("OK");
});

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

    user.lastActive = Date.now(); // update heartbeat

    const msg = {
      userID: socket.id,
      displayName: user.name,
      text,
      timestamp: Date.now()
    };
    history.push(msg);
    io.emit("message", msg);

    if (text.startsWith("/")) return; // bypass LLM

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history.map(m => ({
            role: "user",
            content: `${m.displayName}: ${m.text}`
          }))
        ],
        temperature: 0.7
      });

      const reply = completion.choices[0].message.content.trim();
      const llmMsg = { userID: "llm", displayName: "GodLLM", text: reply, timestamp: Date.now() };
      history.push(llmMsg);
      io.emit("message", llmMsg);

    } catch (err) {
      console.error(err);
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

server.listen(process.env.PORT || 3000, () => console.log("Server running"));