import dbManager from './db.js';
import * as ui from './ui.js';
import * as wsManager from './websocket.js';
import { attachWhiteboardHandlers } from './whiteboard.js';

// --- DOM Element Selectors ---
const domElements = {
    roleSelectionEl: document.getElementById("roleSelection"),
    teacherRoleBtn: document.getElementById("teacherRoleBtn"),
    studentRoleBtn: document.getElementById("studentRoleBtn"),
    teacherDashboardEl: document.getElementById("teacherDashboard"),
    statusEl: document.getElementById("status"),
    createSessionFormEl: document.getElementById("createSessionForm"),
    sessionNameInput: document.getElementById("sessionName"),
    sessionFileInput: document.getElementById("sessionFile"),
    sessionDateInput: document.getElementById("sessionDate"),
    sessionTimeInput: document.getElementById("sessionTime"),
    createSessionBtn: document.getElementById("createSessionBtn"),
    teacherSessionListEl: document.getElementById("teacherSessionList"),
    studentDashboardEl: document.getElementById("studentDashboard"),
    studentStatusEl: document.getElementById("studentStatus"),
    refreshSessionsBtn: document.getElementById("refreshSessionsBtn"),
    sessionListEl: document.getElementById("sessionList"),
    noSessionsMessageEl: document.getElementById("noSessionsMessage"),
    studentViewEl: document.getElementById("studentView"),
    studentContentWrapper: document.getElementById("studentContentWrapper"),
    studentCurrentSessionIdEl: document.getElementById("studentCurrentSessionId"),
    studentChatContainer: document.getElementById("studentChatContainer"),
    studentChatMessages: document.getElementById("studentChatMessages"),
    studentChatInput: document.getElementById("studentChatInput"),
    studentSendChatBtn: document.getElementById("studentSendChatBtn"),
};

// --- INITIALIZATION ---
let ws; 
const clientId = ui.generateClientId();

// --- EVENT LISTENERS ---

// 1. Role Selection
domElements.teacherRoleBtn.addEventListener("click", () => {
    domElements.roleSelectionEl.classList.add("hidden");
    domElements.teacherDashboardEl.classList.remove("hidden");
    ws = wsManager.connectTeacherSocket(clientId, domElements);
});

domElements.studentRoleBtn.addEventListener("click", () => {
    domElements.roleSelectionEl.classList.add("hidden");
    domElements.studentDashboardEl.classList.remove("hidden");
    domElements.studentStatusEl.textContent = "Click Refresh to see available sessions.";
    dbManager.init();
});

// 2. Teacher Dashboard
domElements.createSessionBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        domElements.statusEl.textContent = "Not connected.";
        return;
    }
    const sessionName = domElements.sessionNameInput.value.trim();
    const sessionFile = domElements.sessionFileInput.files[0];
    const sessionDate = domElements.sessionDateInput.value;
    const sessionTime = domElements.sessionTimeInput.value;
    if (!sessionName || !sessionFile || !sessionDate || !sessionTime) {
        domElements.statusEl.textContent = "Please fill all fields.";
        return;
    }
    domElements.statusEl.textContent = "Uploading...";
    const sessionId = ui.generateSessionId();
    const formData = new FormData();
    formData.append("sessionFile", sessionFile);
    formData.append("sessionId", sessionId);

    try {
        // ✅ DEPLOY: Use the live Render URL for the file upload
        const response = await fetch("https://low-bandwidth-classroom-backend.onrender.com/upload", { method: "POST", body: formData });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "File upload failed.");

        const { slideCount } = result;
        ws.send(JSON.stringify({
            action: "createSession", sessionId, sessionName, sessionDate, sessionTime,
            pptFileNames: [sessionFile.name], slideCount, role: "teacher", clientId
        }));
        ui.addSessionCardToTeacherList({ sessionId, name: sessionName, files: [sessionFile.name], slideCount, date: sessionDate, time: sessionTime }, domElements.teacherSessionListEl);
        domElements.createSessionFormEl.reset();
        domElements.statusEl.textContent = "Session created!";
    } catch (error) {
        domElements.statusEl.textContent = `Error: ${error.message}`;
    }
});

domElements.teacherSessionListEl.addEventListener("click", (e) => {
    const card = e.target.closest(".session-card");
    if (!card) return;
    const sessionId = card.dataset.sessionId;
    const slideCount = parseInt(card.dataset.slideCount);
    let slide = parseInt(card.dataset.slide || "1");

    if (e.target.matches(".start-session-btn")) {
        ws.send(JSON.stringify({ action: "startSession", role: "teacher", sessionId, clientId }));
        e.target.classList.add("hidden");
        card.querySelector(".teacher-view").classList.remove("hidden");
        ui.updateTeacherSlideDisplayFromServer(card.querySelector(".slide-display"), slide, sessionId);
    }

    const changeSlide = (newSlide) => {
        card.dataset.slide = newSlide;
        ws.send(JSON.stringify({ action: "slideChange", role: "teacher", sessionId, slide: newSlide, clientId }));
        ui.updateTeacherSlideDisplayFromServer(card.querySelector(".slide-display"), newSlide, sessionId);
    };
    if (e.target.matches(".next-btn")) changeSlide(Math.min(slide + 1, slideCount));
    if (e.target.matches(".prev-btn")) changeSlide(Math.max(slide - 1, 1));

    if (e.target.matches(".send-chat-btn")) {
        const input = card.querySelector(".chat-input");
        const text = input.value.trim();
        if (!text) return;
        const msg = { action: "chatMessage", sessionId, role: "teacher", text, clientId };
        ws.send(JSON.stringify(msg));
        ui.appendChatMessageToBox(card.querySelector('.chat-messages'), { ...msg, senderRole: 'teacher', timestamp: Date.now() });
        input.value = "";
    }

    if (e.target.matches(".whiteboard-toggle-btn")) {
        const wbContainer = card.querySelector(".whiteboard-container");
        const isWbActive = !wbContainer.classList.contains("hidden");
        const enableWb = !isWbActive;
        ws.send(JSON.stringify({ action: "whiteboardToggle", role: "teacher", sessionId, enabled: enableWb, clientId }));
        ui.handleLocalWhiteboardToggleUI(card, enableWb);
        if (enableWb) {
            const canvas = card.querySelector(".wb-canvas");
            if (canvas) {
                canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            }
            attachWhiteboardHandlers(canvas, sessionId, ws, clientId);
        }
    }

    if (e.target.matches(".clear-whiteboard-btn")) {
        const canvas = card.querySelector(".wb-canvas");
        if (canvas) {
            canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            ws.send(JSON.stringify({ action: "whiteboardClear", role: "teacher", sessionId, clientId }));
        }
    }
});

// 3. Student Dashboard
domElements.refreshSessionsBtn.addEventListener("click", () => {
    wsManager.refreshSessions(domElements);
});

domElements.sessionListEl.addEventListener('click', (e) => {
    if (e.target.matches('.download-btn')) {
        const button = e.target;
        ui.downloadSession(button.dataset.sessionId, parseInt(button.dataset.slideCount), button);
    }
    if (e.target.matches('.join-session-btn')) {
        ws = wsManager.joinSession(e.target.dataset.sessionId, clientId, domElements);
    }
});

domElements.studentSendChatBtn.addEventListener("click", () => {
    wsManager.sendStudentChatMessage(ws, clientId, domElements);
});
