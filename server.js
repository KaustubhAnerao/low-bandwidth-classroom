const WebSocket = require("ws");
const url = require("url");
const mongoose = require("mongoose");

require("dotenv").config();

// --- 💾 DATABASE SETUP ---
const MONGO_URI = process.env.MONGODB_CONNECTION_STRING;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully."))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const sessionSchema = new mongoose.Schema(
  {
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
  },
  { timestamps: true }
);

const Session = mongoose.model("Session", sessionSchema);

// ---  WebSocket SERVER SETUP ---
const wss = new WebSocket.Server({ port: 8080 });
console.log("🚀 WebSocket server is running on ws://localhost:8080");

const liveSessions = new Map();

wss.on("connection", (ws, req) => {
  const parameters = url.parse(req.url, true);

  // ✅ FIX: Assign the role and ID immediately from the URL.
  // This resolves the race condition.
  ws.sessionId = parameters.query.sessionId;
  ws.role = parameters.query.role;

  // --- MESSAGE HANDLING ---
  // Now, when this runs, ws.sessionId and ws.role will always be defined.
  ws.on("message", async (message) => {
    try {
      //Parse the message FIRST.
      const data = JSON.parse(message);

      //Reliably determine role and sessionId from the connection OR the message data.
      const role = ws.role || data.role;
      const sessionId = ws.sessionId || data.sessionId;

      console.log(
        `- Received message from ${ws.role} in session ${ws.sessionId}:`,
        message.toString()
      );

      if (role === "teacher") {
        if (data.action === "createSession") {
          const sessionData = {
            sessionId: data.sessionId,
            sessionName: data.sessionName,
            sessionDate: data.sessionDate,
            sessionTime: data.sessionTime,
            pptFileNames: data.pptFileNames,
            status: "scheduled",
            currentSlide: 1,
          };
          await Session.findOneAndUpdate(
            { sessionId: data.sessionId },
            sessionData,
            { upsert: true, new: true }
          );
          console.log(`- Session ${data.sessionId} created/updated in DB.`);
        } else if (data.action === "startSession") {
          const session = await Session.findOneAndUpdate(
            { sessionId: data.sessionId },
            { status: "live" },
            { new: true }
          );
          if (session) {
            console.log(`- Session ${data.sessionId} is now LIVE.`);
          }
        } else if (data.action === "slideChange") {
          const session = await Session.findOneAndUpdate(
            { sessionId: data.sessionId },
            { currentSlide: data.slide },
            { new: true }
          );
          if (session && session.status === "live") {
            console.log(
              `- Teacher in ${data.sessionId} changed slide to ${data.slide}`
            );
            const broadcastMessage = {
              action: "slideChange",
              slide: data.slide,
              presentation: session.sessionName,
            };
            if (liveSessions.has(data.sessionId)) {
              liveSessions.get(data.sessionId).forEach((client) => {
                if (
                  client.role === "student" &&
                  client.readyState === WebSocket.OPEN
                ) {
                  client.send(JSON.stringify(broadcastMessage));
                }
              });
            }
          }
        }
      } else if (role === "student") {
        if (data.action === "getInitialState") {
          const session = await Session.findOne({ sessionId: sessionId });
          if (session && session.status === "live") {
            ws.send(
              JSON.stringify({
                action: "slideChange",
                slide: session.currentSlide,
                presentation: session.sessionName,
              })
            );
          }
        }
      }
    } catch (e) {
      console.error("Failed to process message:", e);
    }
  });

  // --- DISCONNECTION HANDLING ---
  ws.on("close", () => {
    const currentSessionId = ws.sessionId;
    if (currentSessionId && liveSessions.has(currentSessionId)) {
      const clients = liveSessions.get(currentSessionId);
      clients.delete(ws);
      console.log(
        `- ${ws.role} disconnected from session: ${currentSessionId}. Remaining clients: ${clients.size}`
      );
      if (clients.size === 0) {
        liveSessions.delete(currentSessionId);
        console.log(`- Live session ${currentSessionId} is now empty.`);
      }
    }
  });

  // --- INITIAL CONNECTION LOGIC ---
  // This function now runs using the properties we already set on `ws`.
  const handleConnection = async () => {
    const { sessionId, role } = ws; // Use properties from ws object

    if (role === "getSessions") {
      try {
        const sessionsFromDB = await Session.find({
          status: { $in: ["scheduled", "live"] },
        });
        ws.send(
          JSON.stringify({
            action: "sessionList",
            sessions: sessionsFromDB.reduce((acc, session) => {
              acc[session.sessionId] = session.toObject();
              return acc;
            }, {}),
          })
        );
      } catch (error) {
        console.error("Error fetching sessions:", error);
      }
      ws.close();
      return;
    }

    if (!role) {
      console.log(`- Generic teacher connection established.`);
      return;
    }

    if (!sessionId) {
      return ws.close(1008, "Session ID is required.");
    }

    try {
      const session = await Session.findOne({ sessionId: sessionId });
      if (!session && role !== "teacher") {
        return ws.close(1008, "Session does not exist.");
      }
      if (session && role === "student" && session.status !== "live") {
        return ws.close(1008, "Session is not live.");
      }

      if (!liveSessions.has(sessionId)) {
        liveSessions.set(sessionId, new Set());
      }
      liveSessions.get(sessionId).add(ws);

      console.log(
        `- ${role} connected to session: ${sessionId}. Total clients in session: ${
          liveSessions.get(sessionId).size
        }`
      );
    } catch (error) {
      console.error("Database validation error:", error);
      return ws.close(1011, "Internal server error.");
    }
  };

  handleConnection();
});
