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

// Updated Schema with slideCount
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

// 1. Configure Middleware
app.use(cors());

// ✅ FIX: Added enhanced logging to the explicit route for slides to diagnose the 404 error.
app.get('/slides/:sessionId/:slideFile', (req, res) => {
    const { sessionId, slideFile } = req.params;
    console.log(`[SERVER LOG] Request received for slide: /slides/${sessionId}/${slideFile}`);

    // Basic security check to prevent directory traversal attacks
    if (!slideFile.startsWith('slide-') || !slideFile.endsWith('.png')) {
        console.error(`[SERVER LOG] Invalid file request rejected: ${slideFile}`);
        return res.status(400).send('Invalid file request.');
    }

    const filePath = path.join(__dirname, 'public', 'slides', sessionId, slideFile);
    console.log(`[SERVER LOG] Attempting to access file at path: ${filePath}`);

    // Check if the file exists before trying to send it
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            console.error(`[SERVER LOG] File not found or accessible at path: ${filePath}`);
            return res.status(404).send('Slide not found.');
        }

        // If file exists, send it
        res.sendFile(filePath, (err) => {
            if (err) {
                console.error(`[SERVER LOG] Error sending file after it was found:`, err.message);
                // Avoid sending another response if one has already been sent
            } else {
                console.log(`[SERVER LOG] Successfully sent file: ${filePath}`);
            }
        });
    });
});


// 2. Ensure Directories Exist
const uploadsDir = path.join(__dirname, "uploads");
const slidesDir = path.join(__dirname, "public", "slides");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir, { recursive: true });

// 3. Configure File Upload Handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage: storage });

// 4. Define API Routes
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
    console.log(`✅ Converted PDF to images for session ${sessionId}`);
    const files = fs.readdirSync(outputDir);
    const slideCount = files.filter((f) => f.endsWith(".png")).length;
    fs.unlinkSync(filePath);
    res.json({ success: true, slideCount });
  } catch (err) {
    console.error("❌ PDF conversion error:", err);
    fs.unlinkSync(filePath);
    res.status(500).json({ success: false, message: "Failed to process PDF." });
  }
});

// 5. Create the HTTP Server and Attach the Express App
const server = http.createServer(app);

// --- ⚡ WEBSOCKET SERVER SETUP ---
const wss = new WebSocket.Server({ server });
const liveSessions = new Map();

wss.on("connection", (ws, req) => {
  const parameters = url.parse(req.url, true);
  ws.sessionId = parameters.query.sessionId;
  ws.role = parameters.query.role;

  // --- INITIAL CONNECTION LOGIC ---
  const handleConnection = async () => {
    if (ws.role === "getSessions") {
      try {
        const sessionsFromDB = await Session.find({ status: { $in: ["scheduled", "live"] } });
        ws.send(JSON.stringify({
          action: "sessionList",
          sessions: sessionsFromDB.reduce((acc, session) => {
            acc[session.sessionId] = session.toObject();
            return acc;
          }, {}),
        }));
      } catch (error) { console.error("Error fetching sessions:", error); }
      ws.close();
      return;
    } 
    
    if (ws.sessionId) {
      if (!liveSessions.has(ws.sessionId)) liveSessions.set(ws.sessionId, new Set());
      liveSessions.get(ws.sessionId).add(ws);
      console.log(`- ${ws.role} connected to session: ${ws.sessionId}. Total: ${liveSessions.get(ws.sessionId).size}`);
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

      if (role === "teacher") {
        if (data.action === "createSession") {
          const sessionData = {
            sessionId: data.sessionId, sessionName: data.sessionName, sessionDate: data.sessionDate,
            sessionTime: data.sessionTime, pptFileNames: data.pptFileNames, slideCount: data.slideCount,
            status: "scheduled", currentSlide: 1,
          };
          await Session.findOneAndUpdate({ sessionId: data.sessionId }, sessionData, { upsert: true, new: true });
          console.log(`- Session ${data.sessionId} created in DB.`);
        } else if (data.action === "startSession") {
          await Session.findOneAndUpdate({ sessionId }, { status: "live" });
          console.log(`- Session ${sessionId} is now LIVE.`);
        } else if (data.action === "slideChange") {
          const session = await Session.findOneAndUpdate({ sessionId: data.sessionId }, { currentSlide: data.slide }, { new: true });
          if (session && session.status === "live") {
            const broadcastMessage = { action: "slideChange", slide: data.slide, presentation: session.sessionName, slideCount: session.slideCount };
            if (liveSessions.has(data.sessionId)) {
              liveSessions.get(data.sessionId).forEach((client) => {
                if (client.role === "student" && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(broadcastMessage));
                }
              });
            }
          }
        }
      } else if (role === "student") {
        if (data.action === "getInitialState") {
          const session = await Session.findOne({ sessionId });
          if (session && session.status === "live") {
            ws.send(JSON.stringify({
              action: "slideChange", slide: session.currentSlide,
              presentation: session.sessionName, slideCount: session.slideCount
            }));
          }
        }
      }
    } catch (e) { console.error("Failed to process message:", e); }
  });

  ws.on("close", () => {
    if (ws.sessionId && liveSessions.has(ws.sessionId)) {
      const clients = liveSessions.get(ws.sessionId);
      clients.delete(ws);
      console.log(`- ${ws.role} disconnected from ${ws.sessionId}. Remaining: ${clients.size}`);
      if (clients.size === 0) liveSessions.delete(ws.sessionId);
    } else {
      console.log(`- A teacher (generic) disconnected.`);
    }
  });
});

// 6. Start the Server
server.listen(8080, () => {
    console.log("🚀 HTTP & WebSocket server is running on http://localhost:8080");
});