const WebSocket = require("ws");
const http = require("http");
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { Poppler } = require("node-poppler");
const mongoose = require("mongoose");
const url = require("url");
const connectDB = require("./config/db");
const Session = require("./models/Session");

// ✅ FIX: Only load environment variables from .env file in non-production environments
if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}

// --- DATABASE CONNECTION ---
connectDB();

// --- EXPRESS APP SETUP ---
const app = express();
app.use(cors());

// --- PATHS & DIRECTORIES ---
const publicDir = path.resolve(__dirname, '..', 'public');
const uploadsDir = path.resolve(__dirname, '..', 'uploads');
const slidesDir = path.join(publicDir, 'slides');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir, { recursive: true });

// --- EXPRESS ROUTES ---
app.get('/slides/:sessionId/:slideFile', (req, res) => {
    const { sessionId, slideFile } = req.params;
    if (!slideFile.startsWith('slide-') || !slideFile.endsWith('.png')) {
        return res.status(400).send('Invalid file request.');
    }
    const filePath = path.join(slidesDir, sessionId, slideFile);
    res.sendFile(filePath, (err) => {
        if (err) {
            res.status(404).send('Slide not found.');
        }
    });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage: storage });

app.post("/upload", upload.single("sessionFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded." });
  }
  const { sessionId } = req.body;
  const filePath = req.file.path;
  const outputDir = path.join(slidesDir, sessionId);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  try {
    const poppler = new Poppler();
    const options = {
        pngFile: true,
        singleFile: false,
    };
    const outputFile = path.join(outputDir, 'slide');
    await poppler.pdfToCairo(filePath, outputFile, options);
    const files = fs.readdirSync(outputDir);
    const slideCount = files.filter((f) => f.endsWith(".png")).length;
    console.log(`✅ Converted PDF to ${slideCount} images for session ${sessionId}`);
    fs.unlinkSync(filePath);
    res.json({ success: true, slideCount });
  } catch (err) {
    console.error("❌ PDF conversion error:", err);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ success: false, message: "Failed to process PDF." });
  }
});

// --- SERVER & WEBSOCKET INITIALIZATION ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const liveSessions = new Map();
const sessionStates = new Map();

wss.on("connection", (ws, req) => {
    const parameters = url.parse(req.url, true);
    ws.sessionId = parameters.query.sessionId;
    ws.role = parameters.query.role;
    ws.clientId = parameters.query.clientId;

    const handleConnection = async () => { /* ... existing handleConnection logic ... */ };
    handleConnection();

    ws.on("message", async (message) => { /* ... existing message handling logic ... */ });

    ws.on("close", () => { /* ... existing close handling logic ... */ });
});

// Re-pasting the full logic for clarity
wss.on("connection", (ws, req) => {
    const parameters = url.parse(req.url, true);
    ws.sessionId = parameters.query.sessionId;
    ws.role = parameters.query.role;
    ws.clientId = parameters.query.clientId;

    const handleConnection = async () => {
        const { sessionId, role } = ws;
        if (role === "getSessions") {
            try {
                const sessionsFromDB = await Session.find({ status: { $in: ["scheduled", "live"] } });
                ws.send(JSON.stringify({ action: "sessionList", sessions: sessionsFromDB.reduce((acc, session) => { acc[session.sessionId] = session.toObject(); return acc; }, {}) }));
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
                if (!liveSessions.has(sessionId)) liveSessions.set(sessionId, new Set());
                liveSessions.get(sessionId).add(ws);
            } else if (data.action === "chatMessage") {
                broadcastToSession(sessionId, { ...data, senderRole: "teacher", timestamp: Date.now() });
            } else if (data.action === "whiteboardToggle") {
                if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, { whiteboardEnabled: false, strokes: [] });
                const state = sessionStates.get(sessionId);
                state.whiteboardEnabled = data.enabled;
                const session = await Session.findOne({ sessionId });
                broadcastToSession(sessionId, { ...data, slide: session.currentSlide, slideCount: session.slideCount });
                if (data.enabled) {
                    state.strokes = [];
                    broadcastToSession(sessionId, { action: "whiteboardClear" });
                }
            } else if (data.action === "whiteboardStroke") {
                if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, { whiteboardEnabled: true, strokes: [] });
                const state = sessionStates.get(sessionId);
                if (!Array.isArray(state.strokes)) state.strokes = [];
                state.strokes.push(data.stroke);
                broadcastToSession(sessionId, { ...data });
            } else if (data.action === "whiteboardClear") {
                if (sessionStates.has(sessionId)) sessionStates.get(sessionId).strokes = [];
                broadcastToSession(sessionId, { ...data });
            } else if (data.action === "slideChange") {
                 const session = await Session.findOneAndUpdate({ sessionId }, { currentSlide: data.slide }, { new: true });
                 if (session) {
                    broadcastToSession(sessionId, { ...data, slideCount: session.slideCount });
                 }
            }
        } else if (role === "student") {
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
             } else if (data.action === "chatMessage") {
                broadcastToSession(sessionId, { ...data, senderRole: "student", timestamp: Date.now() });
            }
        }
    });

    ws.on("close", () => {
        if (ws.sessionId && liveSessions.has(ws.sessionId)) {
            const clients = liveSessions.get(ws.sessionId);
            clients.delete(ws);
            if (clients.size === 0) liveSessions.delete(ws.sessionId);
        }
    });
});

function broadcastToSession(sessionId, message) {
    const sessionClients = liveSessions.get(sessionId);
    if (sessionClients) {
        const payload = JSON.stringify(message);
        sessionClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 HTTP & WebSocket server is running on http://localhost:${PORT}`);
});