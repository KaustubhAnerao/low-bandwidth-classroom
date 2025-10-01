import dbManager from './db.js';

// --- UTILITY Functions ---
export const generateSessionId = () => Math.random().toString(36).substring(2, 8).toUpperCase();
export const generateClientId = () => Math.random().toString(36).substring(2, 12);

export const updateTeacherSlideDisplayFromServer = (el, slide, sessionId) => {
    if (!sessionId || slide < 1) { el.innerHTML = `<span>Waiting...</span>`; return; }
    // ✅ FIX: Pad the slide number to two digits (e.g., 1 -> 01, 10 -> 10)
    const paddedSlideNumber = String(slide).padStart(2, '0');
    const imageURL = `https://low-bandwidth-classroom-backend.onrender.com/slides/${sessionId}/slide-${paddedSlideNumber}.png`; 
    el.innerHTML = `<img src="${imageURL}" alt="Slide ${slide}" onerror="this.onerror=null;this.innerHTML='<span>Image Not Found</span>';">`;
};

export const updateStudentSlideDisplayFromLocal = async (el, slide, sessionId, slideCount) => {
    if (!sessionId || slide < 1 || (slideCount && slide > slideCount)) { el.innerHTML = `<span>Waiting...</span>`; return; }
    try {
        const imageBlob = await dbManager.getSlide(sessionId, slide);
        const objectURL = URL.createObjectURL(imageBlob);
        if (el.dataset.previousUrl) URL.revokeObjectURL(el.dataset.previousUrl);
        el.innerHTML = `<div id="studentSlideDisplay"><img src="${objectURL}" alt="Slide ${slide}"></div>`;
        el.dataset.previousUrl = objectURL;
    } catch (error) { el.innerHTML = `<span>Slide not loaded.</span>`; }
};

export const escapeHtml = (s) => (s + "").replace(/[&<>"'`]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[m]));

export const appendChatMessageToBox = (chatBox, message) => {
    const when = new Date(message.timestamp || Date.now()).toLocaleTimeString();
    const role = message.senderRole || message.role || "unknown";
    const el = document.createElement("div");
    el.className = "mb-2";
    el.innerHTML = `<span class="text-xs text-slate-400">[${when}]</span> <strong class="text-sm ml-1">${role}:</strong> <span class="ml-2 text-sm">${escapeHtml(message.text)}</span>`;
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
};

export const addSessionCardToTeacherList = (sessionData, parentEl) => {
    const { sessionId, name, files, slideCount, date, time } = sessionData;
    const card = document.createElement("div");
    card.className = "session-card bg-slate-900 rounded-xl p-6 shadow-md border border-indigo-500";
    card.dataset.sessionId = sessionId;
    card.dataset.sessionName = name;
    card.dataset.slideCount = slideCount;
    card.innerHTML = `
      <h3 class="text-xl font-bold mb-2 text-indigo-400">Session: ${name} (${sessionId})</h3>
      <p class="text-sm text-slate-400">Scheduled for: ${date} at ${time}</p>
      <p class="text-sm text-slate-400 mb-4">Files: ${files.join(', ')} (${slideCount} slides)</p>
      <button class="start-session-btn w-full mb-4 px-6 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg">Start Session</button>
      <div class="teacher-view hidden text-center">
        <div class="slide-display mb-4"><span>Presentation will appear here.</span></div>
        <div class="whiteboard-container hidden mt-4">
             <div class="slide-display" style="height:400px;">
                <canvas class="wb-canvas"></canvas>
             </div>
             <div class="mt-3 flex gap-2 justify-center">
                <button class="clear-whiteboard-btn px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg">Clear</button>
             </div>
        </div>
        <div class="mt-6 flex flex-col sm:flex-row justify-center items-center space-y-3 sm:space-y-0 sm:space-x-4">
            <button class="prev-btn px-6 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg">&larr; Prev</button>
            <button class="next-btn px-6 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg">Next &rarr;</button>
            <button class="whiteboard-toggle-btn px-6 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg">Toggle Whiteboard</button>
        </div>
        <div class="chat-container mt-4 text-left">
          <div class="chat-messages h-40 overflow-auto p-3 bg-slate-800 rounded-lg text-sm"></div>
          <div class="mt-2 flex gap-2">
            <input class="chat-input flex-1 px-4 py-2 bg-slate-700 rounded-lg" placeholder="Type..." />
            <button class="send-chat-btn px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg">Send</button>
          </div>
        </div>
      </div>`;
    parentEl.appendChild(card);
};

export function handleLocalWhiteboardToggleUI(card, enabled) {
    const wbContainer = card.querySelector(".whiteboard-container");
    const slideDisp = card.querySelector(".slide-display");
    const prevBtn = card.querySelector(".prev-btn");
    const nextBtn = card.querySelector(".next-btn");
    
    wbContainer.classList.toggle("hidden", !enabled);
    slideDisp.classList.toggle("hidden", enabled);
    if(prevBtn) prevBtn.disabled = enabled;
    if(nextBtn) nextBtn.disabled = enabled;
}

export const renderSessionCards = (sessions, parentEl, noSessionsEl) => {
    parentEl.innerHTML = "";
    const sessionEntries = Object.entries(sessions);
    if (sessionEntries.length === 0) { noSessionsEl.classList.remove("hidden"); return; }
    noSessionsEl.classList.add("hidden");
    sessionEntries.forEach(async ([sessionId, session]) => {
        const card = document.createElement("div");
        card.className = `session-card bg-slate-900 rounded-xl p-4 shadow-md border ${session.status === "live" ? "border-emerald-500" : "border-slate-600"} flex flex-col sm:flex-row items-start justify-between gap-4`;
        const isDownloaded = await dbManager.isSessionDownloaded(sessionId, session.slideCount);
        card.innerHTML = `
          <div class="flex-grow">
              <h3 class="text-lg font-bold ${session.status === "live" ? "text-emerald-400" : "text-slate-200"}">${session.sessionName}</h3>
              <p class="text-sm text-slate-400">ID: ${sessionId}</p>
              <p class="text-sm text-slate-500 mt-2">Files: ${session.pptFileNames.join(', ')} (${session.slideCount} slides)</p>
          </div>
          <div class="flex flex-col items-end gap-2 w-full sm:w-auto">
              <div class="w-full text-right h-4"><span class="download-status text-xs text-slate-400"></span></div>
              <button class="download-btn w-full px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-lg ${isDownloaded ? 'hidden' : ''}" data-session-id="${sessionId}" data-slide-count="${session.slideCount}">Download Materials</button>
              ${session.status === 'live'
                  ? `<button class="join-session-btn w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg disabled:bg-slate-600 disabled:cursor-not-allowed" data-session-id="${sessionId}" ${!isDownloaded ? 'disabled' : ''}>Join</button>`
                  : `<div class="w-full px-4 py-2 bg-slate-700 text-slate-400 font-bold rounded-lg text-center">Scheduled ${isDownloaded ? '(Downloaded)' : ''}</div>`
              }
          </div>`;
        parentEl.appendChild(card);
    });
};

export async function downloadSession(sessionId, slideCount, button) {
    const card = button.closest('.session-card');
    const statusEl = card.querySelector('.download-status');
    const joinBtn = card.querySelector('.join-session-btn');
    button.disabled = true;
    statusEl.textContent = 'Downloading...';
    let downloadedCount = 0;
    for (let i = 1; i <= slideCount; i++) {
        try {
            // ✅ FIX: Pad the slide number to two digits (e.g., 1 -> 01, 9 -> 09, 11 -> 11)
            const paddedSlideNumber = String(i).padStart(2, '0');
            const response = await fetch(`https://low-bandwidth-classroom-backend.onrender.com/slides/${sessionId}/slide-${paddedSlideNumber}.png`);
            const blob = await response.blob();
            await dbManager.storeSlide(sessionId, i, blob);
            downloadedCount++;
            statusEl.textContent = `Downloading... (${downloadedCount}/${slideCount})`;
        } catch (error) { statusEl.textContent = `Error downloading.`; button.disabled = false; return; }
    }
    statusEl.textContent = 'Complete!';
    button.classList.add('hidden');
    if (joinBtn) joinBtn.disabled = false;
    const scheduledDiv = card.querySelector('.bg-slate-700');
    if (scheduledDiv) scheduledDiv.textContent = 'Scheduled (Downloaded)';
}

