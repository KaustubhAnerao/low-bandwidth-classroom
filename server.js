const WebSocket = require("ws");
const http = require("http");
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const poppler = require("pdf-poppler");
const url = require("url");
const mongoose = require("mongoose");

require("dotenv").config();

// --- 💾 DATABASE SETUP ---
const MONGO_URI = process.env.MONGODB_CONNECTION_STRING;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully."))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  sessionName: String,
  sessionDate: String,
  sessionTime: String,
  pptFileNames: [String],
  status: {
    type: String,
    enum: ["scheduled", "live", "ended"],
    default: "scheduled",
  },
  currentSlide: { type: Number, default: 1 },
  slideCount: { type: Number, default: 0 },
}, { timestamps: true });

const Session = mongoose.model("Session", sessionSchema);

// --- 🌐 EXPRESS & HTTP SERVER SETUP ---
const app = express();
app.use(cors());

app.get('/slides/:sessionId/:slideFile', (req, res) => {
    const { sessionId, slideFile } = req.params;
    if (!slideFile.startsWith('slide-') || !slideFile.endsWith('.png')) {
        return res.status(400).send('Invalid file request.');
    }
    const filePath = path.join(__dirname, 'public', 'slides', sessionId, slideFile);
    res.sendFile(filePath, (err) => {
        if (err) {
            res.status(404).send('Slide not found.');
        }
    });
});

const uploadsDir = path.join(__dirname, "uploads");
const slidesDir = path.join(__dirname, "public", "slides");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage: storage });

app.post("/upload", upload.single("sessionFile"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
  if (path.extname(req.file.originalname).toLowerCase() !== '.pdf') {
     fs.unlinkSync(req.file.path);
     return res.status(400).json({ success: false, message: "Only PDF files are allowed." });
  }
  const { sessionId } = req.body;
  const filePath = req.file.path;
  const outputDir = path.join(slidesDir, sessionId);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  try {
    const opts = { format: "png", out_dir: outputDir, out_prefix: "slide", page: null };
    await poppler.convert(filePath, opts);
    const files = fs.readdirSync(outputDir);
    const slideCount = files.filter((f) => f.endsWith(".png")).length;
    fs.unlinkSync(filePath);
    res.json({ success: true, slideCount });
  } catch (err) {
    fs.unlinkSync(filePath);
    res.status(500).json({ success: false, message: "Failed to process PDF." });
  }
});

const server = http.createServer(app);

// --- ⚡ WEBSOCKET SERVER SETUP ---
const wss = new WebSocket.Server({ server });
const liveSessions = new Map();
const sessionStates = new Map();

wss.on("connection", (ws, req) => {
  const parameters = url.parse(req.url, true);
  ws.sessionId = parameters.query.sessionId;
  ws.role = parameters.query.role;

  const handleConnection = async () => {
    const { sessionId, role } = ws;
    if (role === "getSessions") {
      try {
        const sessionsFromDB = await Session.find({ status: { $in: ["scheduled", "live"] } });
        ws.send(JSON.stringify({
          action: "sessionList",
          sessions: sessionsFromDB.reduce((acc, session) => { acc[session.sessionId] = session.toObject(); return acc; }, {}),
        }));
      } catch (error) { console.error("Error fetching sessions:", error); }
      ws.close();
      return;
    }
    
    if (sessionId) {
      if (!liveSessions.has(sessionId)) liveSessions.set(sessionId, new Set());
      liveSessions.get(sessionId).add(ws);
      console.log(`- ${role} connected to session: ${sessionId}. Total: ${liveSessions.get(sessionId).size}`);
      const state = sessionStates.get(sessionId);
      if (state && state.whiteboardEnabled) {
        ws.send(JSON.stringify({ action: "whiteboardToggle", sessionId, enabled: true }));
        ws.send(JSON.stringify({ action: "whiteboardState", sessionId, strokes: state.strokes || [] }));
      }
    } else {
      console.log(`- A teacher connected (generic).`);
    }
  };

  handleConnection();

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      const role = ws.role || data.role;
      const sessionId = ws.sessionId || data.sessionId;

      if (!sessionId) return;

      if (role === "teacher") {
        if (data.action === "createSession") {
          const sessionData = {
            sessionId: data.sessionId, sessionName: data.sessionName, sessionDate: data.sessionDate,
            sessionTime: data.sessionTime, pptFileNames: data.pptFileNames, slideCount: data.slideCount,
            status: "scheduled", currentSlide: 1,
          };
          await Session.findOneAndUpdate({ sessionId: data.sessionId }, sessionData, { upsert: true, new: true });
        } else if (data.action === "startSession") {
          await Session.findOneAndUpdate({ sessionId }, { status: "live" });
          ws.sessionId = sessionId;
          if (!liveSessions.has(sessionId)) {
            liveSessions.set(sessionId, new Set());
          }
          liveSessions.get(sessionId).add(ws);
          console.log(`- Teacher registered for session ${sessionId}. Total: ${liveSessions.get(sessionId).size}`);
        } else if (data.action === "slideChange") {
          const session = await Session.findOneAndUpdate({ sessionId }, { currentSlide: data.slide }, { new: true });
          if (session) {
            broadcastToSession(sessionId, { action: "slideChange", slide: session.currentSlide, slideCount: session.slideCount });
          }
        }
        else if (data.action === "whiteboardToggle") {
          if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, { whiteboardEnabled: false, strokes: [] });
          const state = sessionStates.get(sessionId);
          state.whiteboardEnabled = data.enabled;
          
          const session = await Session.findOne({ sessionId });
          broadcastToSession(sessionId, { action: "whiteboardToggle", enabled: data.enabled, slide: session.currentSlide, slideCount: session.slideCount });

          // ✅ FIX: When the teacher toggles the whiteboard ON, clear the strokes.
          if (data.enabled) {
            state.strokes = [];
            // This broadcast ensures all clients get a fresh canvas.
            broadcastToSession(sessionId, { action: "whiteboardClear" });
          }
        } else if (data.action === "whiteboardStroke") {
          if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, { whiteboardEnabled: true, strokes: [] });
          const state = sessionStates.get(sessionId);
          if (!Array.isArray(state.strokes)) state.strokes = [];
          state.strokes.push(data.stroke);
          broadcastToSession(sessionId, { action: "whiteboardStroke", stroke: data.stroke }, ws);
        } else if (data.action === "whiteboardClear") {
          if (sessionStates.has(sessionId)) sessionStates.get(sessionId).strokes = [];
          broadcastToSession(sessionId, { action: "whiteboardClear" }, ws);
        } else if (data.action === "chatMessage") {
          broadcastToSession(sessionId, { action: "chatMessage", sessionId, senderRole: "teacher", text: data.text, timestamp: Date.now() }, ws);
        }
      }
      else if (role === "student") {
        if (data.action === "getInitialState") {
          const session = await Session.findOne({ sessionId });
          if (session && session.status === "live") {
            ws.send(JSON.stringify({ action: "slideChange", slide: session.currentSlide, slideCount: session.slideCount }));
            const state = sessionStates.get(sessionId);
            if (state && state.whiteboardEnabled) {
                ws.send(JSON.stringify({ action: "whiteboardToggle", enabled: true }));
                ws.send(JSON.stringify({ action: "whiteboardState", strokes: state.strokes || [] }));
            }
          }
        }
        else if (data.action === "chatMessage") {
          broadcastToSession(sessionId, { action: "chatMessage", sessionId: sessionId, senderRole: "student", text: data.text, timestamp: Date.now() });
        }
      }
    } catch (e) { console.error("Failed to process message:", e); }
  });

  ws.on("close", () => {
    if (ws.sessionId && liveSessions.has(ws.sessionId)) {
      const clients = liveSessions.get(ws.sessionId);
      clients.delete(ws);
      if (clients.size === 0) {
        liveSessions.delete(ws.sessionId);
        console.log(`- Live session ${ws.sessionId} is now empty.`);
      }
    } else {
        console.log(`- A generic connection disconnected.`);
    }
  });
});

function broadcastToSession(sessionId, message, excludeClient) {
    if (liveSessions.has(sessionId)) {
        const payload = JSON.stringify(message);
        liveSessions.get(sessionId).forEach((client) => {
            if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

server.listen(8080, () => {
    console.log("🚀 HTTP & WebSocket server is running on http://localhost:8080");
});

