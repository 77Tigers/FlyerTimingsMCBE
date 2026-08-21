'use strict';

/* ======================================================
 *  VIEW – rendering and UI updates
 * ====================================================== */

// Canvas and UI elements
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');
let baseBlockSize = 40;
let blockSize = 40;
let originX = 0;
let originY = 0;

// Conflict display state
let conflictSegments = new Set();
let conflictUntil = 0;

function showStatus(msg, isError = true) {
    statusDiv.textContent = msg;
    statusDiv.style.color = isError ? '#f88' : '#8f8';
    clearTimeout(showStatus._timeout);
    showStatus._timeout = setTimeout(() => { statusDiv.textContent = ''; }, 4000);
}

function setConflicts(conflicts) {
    conflictSegments = new Set(conflicts);
    conflictUntil = performance.now() + 2000;
}

function clearConflicts() {
    conflictSegments.clear();
    conflictUntil = 0;
}

function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    originX = canvas.width / 2;
    originY = canvas.height / 2;
    baseBlockSize = Math.max(20, Math.min(canvas.width, canvas.height) / 15);
    blockSize = baseBlockSize * zoomScale;
    draw();
}
window.addEventListener('resize', resizeCanvas);

function worldToScreenX(wx) { return originX + (wx - panOffsetX) * blockSize; }
function worldToScreenY(wy, camY) { return originY - (wy - camY - panOffsetY) * blockSize; }
function screenToWorldX(sx) { return panOffsetX + (sx - originX) / blockSize; }
function screenToWorldY(sy, camY) { return camY + panOffsetY + (originY - sy) / blockSize; }

function getCameraY() { return scene.B * normaliseTime(visualTime) / scene.L; }

function drawGrid(camY) {
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    const worldLeft = panOffsetX - originX / blockSize;
    const worldRight = panOffsetX + (canvas.width - originX) / blockSize;
    const worldBottom = camY + panOffsetY - originY / blockSize;
    const worldTop = camY + panOffsetY + (canvas.height - originY) / blockSize;
    for (let x = Math.floor(worldLeft); x <= Math.ceil(worldRight); x++) {
        const sx = worldToScreenX(x);
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
    }
    for (let y = Math.floor(worldBottom); y <= Math.ceil(worldTop); y++) {
        const sy = worldToScreenY(y, camY);
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
    }
}

function computeExteriorEdges(seg) {
    const set = new Set(seg.blocks.map(b => `${b.x},${b.y}`));
    const edges = [];
    for (const b of seg.blocks) {
        if (!set.has(`${b.x + 1},${b.y}`)) edges.push([b.x + 1, b.y, b.x + 1, b.y + 1]);
        if (!set.has(`${b.x - 1},${b.y}`)) edges.push([b.x, b.y, b.x, b.y + 1]);
        if (!set.has(`${b.x},${b.y + 1}`)) edges.push([b.x, b.y + 1, b.x + 1, b.y + 1]);
        if (!set.has(`${b.x},${b.y - 1}`)) edges.push([b.x, b.y, b.x + 1, b.y]);
    }
    return edges;
}

function drawSegmentFill(seg, visOff, camY) {
    ctx.fillStyle = seg.frozen ? whiten(COLOURS[seg.colour], 0.7) : COLOURS[seg.colour];
    const pad = 0.75;
    for (const block of seg.blocks) {
        const worldX = block.x;
        const worldY = block.y + visOff;
        const sx = worldToScreenX(worldX);
        const sy = worldToScreenY(worldY + 1, camY);
        ctx.fillRect(sx - pad, sy - pad, blockSize + pad * 2, blockSize + pad * 2);
    }
}

function drawSegmentOutline(seg, visOff, camY, isConflict) {
    const edges = computeExteriorEdges(seg);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 12;
    if (isConflict) { ctx.strokeStyle = '#ff4444'; ctx.shadowColor = '#ff4444'; }
    else { ctx.strokeStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; }
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of edges) {
        const p1x = worldToScreenX(x1);
        const p1y = worldToScreenY(y1 + visOff, camY);
        const p2x = worldToScreenX(x2);
        const p2y = worldToScreenY(y2 + visOff, camY);
        ctx.moveTo(p1x, p1y);
        ctx.lineTo(p2x, p2y);
    }
    ctx.stroke();
    ctx.restore();
}

function drawSegmentName(seg, visOff, camY) {
    if (!seg.name || seg.blocks.length === 0) return;
    let avgX = 0, avgY = 0;
    for (const b of seg.blocks) { avgX += b.x; avgY += b.y + visOff; }
    avgX /= seg.blocks.length; avgY /= seg.blocks.length;
    const anchorX = worldToScreenX(avgX + 0.5);
    const anchorY = worldToScreenY(avgY + 0.5, camY) - 14;
    ctx.font = '14px system-ui, sans-serif';
    const metrics = ctx.measureText(seg.name);
    const w = metrics.width + 8, h = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(anchorX - w / 2, anchorY - h / 2, w, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(seg.name, anchorX, anchorY);
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const L = scene.L, B = scene.B;
    const t = ((visualTime % L) + L) % L;
    const camY = B * t / L;
    drawGrid(camY);

    const visOffs = new Map();
    for (const seg of scene.segments) {
        const visOff = getVisualOffset(seg, getSegmentInternalTime(seg, t));
        visOffs.set(seg.id, visOff);
        drawSegmentFill(seg, visOff, camY);
    }
    for (const seg of scene.segments) {
        const isSelected = seg.id === selectedSegmentId;
        const isConflict = conflictSegments.has(seg.id) && performance.now() < conflictUntil;
        if (!isSelected && !isConflict) continue;
        drawSegmentOutline(seg, visOffs.get(seg.id), camY, isConflict);
    }
    for (const seg of scene.segments) {
        drawSegmentName(seg, visOffs.get(seg.id), camY);
    }
}

function updateSegmentList() {
    const list = document.getElementById('segments-list');
    list.innerHTML = '';
    for (const seg of scene.segments) {
        if (seg.blocks.length === 0) continue;
        const div = document.createElement('div');
        div.className = 'seg-item' + (seg.id === selectedSegmentId ? ' selected' : '');
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = seg.frozen ? whiten(COLOURS[seg.colour], 0.7) : COLOURS[seg.colour];
        div.appendChild(swatch);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = seg.name || '';
        div.appendChild(nameSpan);
        div.addEventListener('click', () => selectSegment(seg.id));
        list.appendChild(div);
    }
}

function updateSelectedPanel() {
    const panel = document.getElementById('selected-panel');
    const seg = scene.segments.find(s => s.id === selectedSegmentId);
    const nameInput = document.getElementById('segName');
    const timingInput = document.getElementById('timingInput');
    if (!seg) {
        panel.style.display = 'none';
        nameInput.value = '';
        timingInput.value = '';
        return;
    }
    panel.style.display = 'flex';
    nameInput.value = seg.name || '';
    timingInput.value = foldTiming(seg.movement);
}

function updateTimeDisplay() {
    document.getElementById('time-display').textContent = `t = ${logicalTime} / ${scene.L} rt`;
}

function updateDefaultTimingDisplay() {
    document.getElementById('defaultTimingInput').value = foldTiming(scene.defaultMovement);
}

function updateCycleMetaDisplay() {
    const bps = (10 * scene.B / scene.L).toFixed(2);
    document.getElementById('cycle-meta-display').textContent = `speed is ${scene.B} blocks in ${scene.L}rt, or ${bps}bps`;
}

function updateUI() {
    updateSegmentList();
    updateSelectedPanel();
    updateTimeDisplay();
    updateDefaultTimingDisplay();
    updateCycleMetaDisplay();
    draw();
}