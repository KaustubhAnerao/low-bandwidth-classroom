export function attachWhiteboardHandlers(canvas, sessionId, ws, clientId) {
    if (!canvas || canvas._wbAttached) return;
    canvas._wbAttached = true;
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;

    const ctx = canvas.getContext("2d");
    ctx.lineCap = "round";
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 2 * dpr;
    let drawing = false;
    let currentStroke = [];

    const getPoint = (e, canvas) => {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
    };

    const startStroke = (e) => {
        e.preventDefault(); drawing = true; currentStroke = [];
        const { x, y } = getPoint(e, canvas);
        currentStroke.push([x, y]);
    };
    const drawStroke = (e) => {
        if (!drawing) return; e.preventDefault();
        const { x, y } = getPoint(e, canvas);
        currentStroke.push([x, y]);
        drawStrokeOnCanvas(canvas, { points: currentStroke, color: '#FFFFFF', width: 2 });
    };
    const endStroke = () => {
        if (!drawing) return; drawing = false;
        if (currentStroke.length > 1) {
            ws.send(JSON.stringify({ action: "whiteboardStroke", role: "teacher", sessionId, stroke: { points: currentStroke, color: '#FFFFFF', width: 2 }, clientId }));
        }
    };

    canvas.addEventListener("pointerdown", startStroke);
    canvas.addEventListener("pointermove", drawStroke);
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointerleave", endStroke);
}

export function drawStrokeOnCanvas(canvas, stroke) {
    if (!canvas || !stroke || !stroke.points || stroke.points.length < 2) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.strokeStyle = stroke.color || "#FFFFFF";
    ctx.lineWidth = (stroke.width || 2) * dpr;
    ctx.beginPath();
    const pts = stroke.points;
    ctx.moveTo(pts[0][0] * canvas.width, pts[0][1] * canvas.height);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * canvas.width, pts[i][1] * canvas.height);
    }
    ctx.stroke();
}

