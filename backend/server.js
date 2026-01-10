import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(cors({ origin: "*" })); // allow all for now

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let history = [];
const SYSTEM_PROMPT = `
You are a conversational participant in a shared dialogue.
Respond thoughtfully and calmly.
Do not claim divine authority.
Do not say "God says".
Be concise.
`;

io.on("connection", (socket) => {
  console.log("User connected");
  socket.emit("history", history);

  socket.on("message", async ({ speaker, text }) => {
    const msg = { speaker, text };
    history.push(msg);
    io.emit("message", msg);

    if (text.startsWith("/")) return;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history.map(m => ({
            role: m.speaker === "llm" ? "assistant" : "user",
            content: m.text
          }))
        ],
        temperature: 0.7
      });

      const reply = completion.choices[0].message.content.trim();
      const llmMsg = { speaker: "llm", text: reply };
      history.push(llmMsg);
      io.emit("message", llmMsg);

    } catch (err) {
      console.error(err);
    }
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);