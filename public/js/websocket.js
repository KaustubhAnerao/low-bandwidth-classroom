import { appendChatMessageToBox, renderSessionCards, updateStudentSlideDisplayFromLocal } from './ui.js';
import { drawStrokeOnCanvas } from './whiteboard.js';

let currentSessionIdForStudent = null;

export function connectTeacherSocket(clientId, domElements) {
    // ✅ DEPLOY: Use the live, secure WebSocket URL (wss)
    const ws = new WebSocket(`wss://low-bandwidth-classroom-backend.onrender.com?clientId=${clientId}`);
    ws.onopen = () => {
        domElements.statusEl.textContent = "Connected.";
        domElements.statusEl.classList.add("text-green-400");
    };
    ws.onclose = () => {
        domElements.statusEl.textContent = "Disconnected.";
        domElements.statusEl.classList.remove("text-green-400");
    };
    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.clientId === clientId) return;

            if (message.action === "chatMessage" && message.sessionId) {
                const card = document.querySelector(`.session-card[data-session-id="${message.sessionId}"]`);
                if (card) {
                    const chatBox = card.querySelector(".chat-messages");
                    if (chatBox) appendChatMessageToBox(chatBox, message);
                }
            }
            if (message.action === "whiteboardClear" && message.sessionId) {
                const card = document.querySelector(`.session-card[data-session-id="${message.sessionId}"]`);
                const canvas = card?.querySelector(".wb-canvas");
                if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            }
            if (message.action === "whiteboardStroke" && message.sessionId) {
                const card = document.querySelector(`.session-card[data-session-id="${message.sessionId}"]`);
                const canvas = card?.querySelector(".wb-canvas");
                if (canvas) drawStrokeOnCanvas(canvas, message.stroke);
            }
        } catch (e) {
            console.error("Teacher WS message error:", e);
        }
    };
    return ws;
}

export function refreshSessions(domElements) {
    // ✅ DEPLOY: Use the live, secure WebSocket URL (wss)
    const listWs = new WebSocket(`wss://low-bandwidth-classroom-backend.onrender.com?role=getSessions`);
    domElements.studentStatusEl.textContent = "Refreshing session list...";
    listWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.action === "sessionList") {
            renderSessionCards(message.sessions, domElements.sessionListEl, domElements.noSessionsMessageEl);
            domElements.studentStatusEl.textContent = "Session list updated.";
        }
    };
}

export function joinSession(sessionId, clientId, domElements) {
    domElements.studentDashboardEl.classList.add("hidden");
    domElements.studentViewEl.classList.remove("hidden");
    domElements.studentCurrentSessionIdEl.textContent = sessionId;
    currentSessionIdForStudent = sessionId;
    domElements.studentChatContainer.classList.remove("hidden");
    domElements.studentChatMessages.innerHTML = "";

    // ✅ DEPLOY: Use the live, secure WebSocket URL (wss)
    const ws = new WebSocket(`wss://low-bandwidth-classroom-backend.onrender.com?sessionId=${sessionId}&role=student&clientId=${clientId}`);
    ws.onopen = () => ws.send(JSON.stringify({ action: "getInitialState", clientId }));
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.clientId === clientId) return;

        if (msg.action === "slideChange") {
            updateStudentSlideDisplayFromLocal(domElements.studentContentWrapper, msg.slide, currentSessionIdForStudent, msg.slideCount);
        }
        if (msg.action === "chatMessage") {
            appendChatMessageToBox(domElements.studentChatMessages, msg);
        }
        if (msg.action === "whiteboardToggle") {
            if (msg.enabled) {
                const canvas = document.createElement('canvas');
                canvas.className = 'wb-canvas';
                domElements.studentContentWrapper.innerHTML = '';
                domElements.studentContentWrapper.appendChild(canvas);
                const dpr = window.devicePixelRatio || 1;
                canvas.width = canvas.clientWidth * dpr;
                canvas.height = canvas.clientHeight * dpr;
            } else {
                updateStudentSlideDisplayFromLocal(domElements.studentContentWrapper, msg.slide, currentSessionIdForStudent, msg.slideCount);
            }
        }
        if (msg.action === "whiteboardState" && Array.isArray(msg.strokes)) {
            const canvas = domElements.studentContentWrapper.querySelector(".wb-canvas");
            if (canvas) msg.strokes.forEach(stroke => drawStrokeOnCanvas(canvas, stroke));
        }
        if (msg.action === "whiteboardStroke") {
            const canvas = domElements.studentContentWrapper.querySelector(".wb-canvas");
            if (canvas) drawStrokeOnCanvas(canvas, msg.stroke);
        }
        if (msg.action === "whiteboardClear") {
            const canvas = domElements.studentContentWrapper.querySelector(".wb-canvas");
            if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        }
    };
    ws.onclose = () => {
        domElements.studentDashboardEl.classList.remove("hidden");
        domElements.studentViewEl.classList.add("hidden");
        domElements.studentStatusEl.textContent = "Disconnected from session.";
    };
    return ws;
}

export function sendStudentChatMessage(ws, clientId, domElements) {
    const text = domElements.studentChatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: "chatMessage", role: "student", sessionId: currentSessionIdForStudent, text, clientId }));
    appendChatMessageToBox(domElements.studentChatMessages, { senderRole: 'student', text, timestamp: Date.now() });
    domElements.studentChatInput.value = "";
}
