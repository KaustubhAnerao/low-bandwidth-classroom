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

// liveSessions maps sessionId => Set of client ws
const liveSessions = new Map();

// sessionStates stores ephemeral whiteboard state per session:
// { whiteboardEnabled: boolean, strokes: [ { points: [[x,y],...], color, width } ] }
const sessionStates = new Map();

wss.on("connection", (ws, req) => {
  const parameters = url.parse(req.url, true);

  // Assign role and sessionId from URL if provided
  ws.sessionId = parameters.query.sessionId;
  ws.role = parameters.query.role;

  // --- MESSAGE HANDLING ---
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // Determine role and session id either from connection or message
      const role = ws.role || data.role;
      const sessionId = ws.sessionId || data.sessionId;
      // optional clientId forwarded from client (used by clients to dedupe)
      const senderClientId = data.clientId;

      console.log(
        `- Received message from ${role || "unknown"} in session ${sessionId || "none"}:`,
        data.action || message.toString()
      );

      // TEACHER ACTIONS
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

          // ensure the teacher connection is associated with this session
          ws.sessionId = data.sessionId;
          if (!liveSessions.has(data.sessionId)) {
            liveSessions.set(data.sessionId, new Set());
          }
          liveSessions.get(data.sessionId).add(ws);
          console.log(`- Teacher added to liveSessions for ${data.sessionId}. Total: ${liveSessions.get(data.sessionId).size}`);
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
              whiteboardActive: sessionStates.get(data.sessionId)?.whiteboardEnabled || false,
              clientId: senderClientId
            };
            if (liveSessions.has(data.sessionId)) {
              // broadcast to all clients (including teacher). clients ignore their own messages by clientId.
              liveSessions.get(data.sessionId).forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(broadcastMessage));
                }
              });
            }
          }
        } else if (data.action === "whiteboardToggle") {
          // Teacher turned whiteboard ON/OFF
          const enabled = !!data.enabled;
          if (!sessionStates.has(data.sessionId)) {
            sessionStates.set(data.sessionId, { whiteboardEnabled: false, strokes: [] });
          }
          const state = sessionStates.get(data.sessionId);
          state.whiteboardEnabled = enabled;

          // Broadcast toggle to all clients in the session (include clientId)
          if (liveSessions.has(data.sessionId)) {
            const session = await Session.findOne({ sessionId: data.sessionId });
            const payload = {
              action: "whiteboardToggle",
              sessionId: data.sessionId,
              enabled: enabled,
              slide: session?.currentSlide || 1,
              presentation: session?.sessionName || "Presentation",
              clientId: senderClientId
            };
            liveSessions.get(data.sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        } else if (data.action === "whiteboardStroke") {
          // Teacher is sending a stroke -> store and broadcast to all (include clientId)
          if (!sessionStates.has(data.sessionId)) {
            sessionStates.set(data.sessionId, { whiteboardEnabled: true, strokes: [] });
          }
          const state = sessionStates.get(data.sessionId);
          if (!Array.isArray(state.strokes)) state.strokes = [];
          state.strokes.push(data.stroke);
          // Broadcast stroke to all clients in that session
          if (liveSessions.has(data.sessionId)) {
            const payload = {
              action: "whiteboardStroke",
              sessionId: data.sessionId,
              stroke: data.stroke,
              clientId: senderClientId
            };
            liveSessions.get(data.sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        } else if (data.action === "whiteboardClear") {
          // Teacher cleared canvas
          if (sessionStates.has(data.sessionId)) {
            sessionStates.get(data.sessionId).strokes = [];
          }
          if (liveSessions.has(data.sessionId)) {
            const payload = {
              action: "whiteboardClear",
              sessionId: data.sessionId,
              clientId: senderClientId
            };
            liveSessions.get(data.sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        } else if (data.action === "chatMessage") {
          // teacher chat broadcast to all participants (include clientId)
          const payload = {
            action: "chatMessage",
            sessionId: data.sessionId,
            senderRole: "teacher",
            text: data.text,
            timestamp: Date.now(),
            clientId: senderClientId
          };
          if (data.sessionId && liveSessions.has(data.sessionId)) {
            liveSessions.get(data.sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        }
      } else if (role === "student") {
        // --- STUDENT MESSAGES ---
        if (data.action === "getInitialState") {
          const session = await Session.findOne({ sessionId: sessionId });
          if (session && session.status === "live") {
            // send slide state
            ws.send(
              JSON.stringify({
                action: "slideChange",
                slide: session.currentSlide,
                presentation: session.sessionName,
                whiteboardActive: sessionStates.get(sessionId)?.whiteboardEnabled || false,
                clientId: null // server-originated, no clientId
              })
            );
            // if whiteboard currently active, send the whiteboard snapshot as well
            const state = sessionStates.get(sessionId);
            if (state && state.whiteboardEnabled) {
              // notify this client that whiteboard is active
              ws.send(JSON.stringify({
                action: "whiteboardToggle",
                sessionId,
                enabled: true,
                clientId: null
              }));
              // send existing strokes so client can paint full board
              ws.send(JSON.stringify({
                action: "whiteboardState",
                sessionId,
                strokes: state.strokes || [],
                clientId: null
              }));
            }
          }
        } else if (data.action === "chatMessage") {
          // broadcast student's chat message to everyone in the session (include clientId)
          const payload = {
            action: "chatMessage",
            sessionId: sessionId,
            senderRole: "student",
            text: data.text,
            timestamp: Date.now(),
            clientId: senderClientId
          };
          if (sessionId && liveSessions.has(sessionId)) {
            liveSessions.get(sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        }
      } else {
        // Generic/other role: fallback chat broadcast if someone sends chat without role
        if (data.action === "chatMessage" && data.sessionId) {
          const payload = {
            action: "chatMessage",
            sessionId: data.sessionId,
            senderRole: data.role || "unknown",
            text: data.text,
            timestamp: Date.now(),
            clientId: senderClientId
          };
          if (liveSessions.has(data.sessionId)) {
            liveSessions.get(data.sessionId).forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
              }
            });
          }
        }
      }
    } catch (e) {
      console.error("Failed to process message:", e);
    }
  });

  // --- DISCONNECTION HANDLING ---
  ws.on("close", () => {
    // Remove ws from all liveSessions sets (safer when ws is part of multiple sessions).
    for (const [sid, clients] of liveSessions.entries()) {
      if (clients.has(ws)) {
        clients.delete(ws);
        console.log(`- ${ws.role} disconnected from session: ${sid}. Remaining clients: ${clients.size}`);
        if (clients.size === 0) {
          liveSessions.delete(sid);
          console.log(`- Live session ${sid} is now empty.`);
        }
      }
    }
  });

  // --- INITIAL CONNECTION LOGIC ---
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
        `- ${role} connected to session: ${sessionId}. Total clients in session: ${liveSessions.get(sessionId).size}`
      );

      // If a student/teacher joins and whiteboard active, send snapshot
      const state = sessionStates.get(sessionId);
      if (state && state.whiteboardEnabled) {
        // notify this client that whiteboard is active
        ws.send(JSON.stringify({
          action: "whiteboardToggle",
          sessionId,
          enabled: true,
          clientId: null
        }));
        // send existing strokes so client can paint full board
        ws.send(JSON.stringify({
          action: "whiteboardState",
          sessionId,
          strokes: state.strokes || [],
          clientId: null
        }));
      }
    } catch (error) {
      console.error("Database validation error:", error);
      return ws.close(1011, "Internal server error.");
    }
  };

  handleConnection();
});