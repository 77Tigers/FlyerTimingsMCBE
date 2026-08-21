'use strict';

/* ======================================================
 *  CONTROLLER – state, event handling, main loop
 * ====================================================== */

// Global state
let scene = createFlyerScene(8, 2);
let logicalTime = 0;
let visualTime = 0;
let playing = false;
let pauseAtNextLogical = false;
let transitionActive = false;
let transitionTarget = 0;
let playSpeed = 2;
let arrowStepSize = 1;

let selectedSegmentId = 1;

let mouseX = 0, mouseY = 0;
let rightMouseDown = false, leftMouseDown = false;
let leftMouseDownWasEmpty = false, leftMouseDownRemovedBlock = false;

let panning = false;
let panStartScreen = { x: 0, y: 0 };
let panStartOffset = { x: 0, y: 0 };
let panOffsetX = 0, panOffsetY = 0;
let panKeysHeld = { w: false, a: false, s: false, d: false };
let draggingSegmentId = null;
let dragStartScreen = { x: 0, y: 0 };
let dragStartScene = null;
let dragLastDx = 0, dragLastDy = 0;
let zoomScale = 1;
const MIN_ZOOM = 0.2, MAX_ZOOM = 6;
let fKeyHeld = false;
let fToggledThisSession = new Set();
let clipboard = null;

function setLogicalTime(t) {
    logicalTime = Math.round(t);
    logicalTime = ((logicalTime % scene.L) + scene.L) % scene.L;
}

/* ---------- Hit testing ---------- */
function updateMouse(e) {
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
}

function getGridCellFromMouse() {
    const camY = getCameraY();
    const worldX = screenToWorldX(mouseX);
    const worldY = screenToWorldY(mouseY, camY);
    return { x: Math.floor(worldX), y: Math.floor(worldY) };
}

function hitTestBlock() {
    const camY = getCameraY();
    for (const seg of scene.segments) {
        const offset = getLogicalOffset(seg, getSegmentInternalTime(seg, logicalTime));
        for (const b of seg.blocks) {
            const worldX = b.x, worldY = b.y + offset;
            const sx = worldToScreenX(worldX);
            const sy = worldToScreenY(worldY + 1, camY);
            if (mouseX >= sx && mouseX <= sx + blockSize && mouseY >= sy && mouseY <= sy + blockSize) {
                return { segId: seg.id, blockX: b.x, blockY: b.y };
            }
        }
    }
    return null;
}

function hitTestLogical() {
    const hit = hitTestBlock();
    return hit ? hit.segId : null;
}

/* ---------- Block editing ---------- */
function addBlockAtMouse() {
    if (!selectedSegmentId) return;
    const seg = scene.segments.find(s => s.id === selectedSegmentId);
    if (!seg) return;

    const cell = getGridCellFromMouse();
    const offset = getLogicalOffset(seg, getSegmentInternalTime(seg, logicalTime));
    const startPos = { x: cell.x, y: cell.y - offset };

    if (seg.blocks.some(b => b.x === startPos.x && b.y === startPos.y)) return;
    for (const s of scene.segments) {
        if (s.blocks.some(b => b.x === startPos.x && b.y === startPos.y)) return;
    }
    for (const s of scene.segments) {
        const off = getLogicalOffset(s, getSegmentInternalTime(s, logicalTime));
        if (s.blocks.some(b => b.x === cell.x && b.y + off === cell.y)) return;
    }

    const oldScene = cloneScene(scene);
    seg.blocks.push(startPos);
    const result = validateSceneUnfrozen(scene);
    if (result.valid) {
        clearConflicts();
        showStatus('Block added.', false);
        updateUI();
    } else {
        scene = oldScene;
        setConflicts(result.conflicts);
        showStatus('Invalid placement: ' + result.errors[0]);
        updateUI();
    }
}

function translateSegmentInScene(candidateScene, segmentId, dx, dy) {
    const seg = candidateScene.segments.find(s => s.id === segmentId);
    if (!seg) return false;
    for (const block of seg.blocks) { block.x += dx; block.y += dy; }
    return true;
}

function tryDragSegment(dx, dy) {
    if (draggingSegmentId === null || !dragStartScene) return false;
    const exactScene = cloneScene(dragStartScene);
    if (!translateSegmentInScene(exactScene, draggingSegmentId, dx, dy)) return false;
    let result = validateSceneUnfrozen(exactScene);
    if (result.valid) {
        scene = exactScene;
        clearConflicts();
        dragLastDx = dx; dragLastDy = dy;
        updateUI();
        return true;
    }
    if (dx !== 0 && dy !== 0) {
        const horizontalScene = cloneScene(dragStartScene);
        translateSegmentInScene(horizontalScene, draggingSegmentId, dx, 0);
        result = validateSceneUnfrozen(horizontalScene);
        if (result.valid) { scene = horizontalScene; clearConflicts(); dragLastDx = dx; dragLastDy = 0; updateUI(); return true; }
        const verticalScene = cloneScene(dragStartScene);
        translateSegmentInScene(verticalScene, draggingSegmentId, 0, dy);
        result = validateSceneUnfrozen(verticalScene);
        if (result.valid) { scene = verticalScene; clearConflicts(); dragLastDx = 0; dragLastDy = dy; updateUI(); return true; }
    }
    if (result && !result.valid) setConflicts(result.conflicts);
    return false;
}

function startSegmentDrag() {
    const hit = hitTestLogical();
    if (!hit) return false;
    const seg = scene.segments.find(s => s.id === hit);
    if (!seg || seg.blocks.length === 0) return false;
    selectSegment(hit);
    draggingSegmentId = hit;
    dragStartScreen = { x: mouseX, y: mouseY };
    dragStartScene = cloneScene(scene);
    dragLastDx = 0; dragLastDy = 0;
    return true;
}

function updateSegmentDrag() {
    if (draggingSegmentId === null || !dragStartScene) return;
    const dx = Math.round((mouseX - dragStartScreen.x) / blockSize);
    const dy = -Math.round((mouseY - dragStartScreen.y) / blockSize);
    if (dx === dragLastDx && dy === dragLastDy) return;
    tryDragSegment(dx, dy);
}

function endSegmentDrag() {
    draggingSegmentId = null;
    dragStartScene = null;
    dragLastDx = 0; dragLastDy = 0;
}

function removeBlockAtMouse() {
    if (!selectedSegmentId) return;
    const seg = scene.segments.find(s => s.id === selectedSegmentId);
    if (!seg) return;
    const cell = getGridCellFromMouse();
    const offset = getLogicalOffset(seg, getSegmentInternalTime(seg, logicalTime));
    const idx = seg.blocks.findIndex(b => b.x === cell.x && b.y + offset === cell.y);
    if (idx === -1) return;
    const oldScene = cloneScene(scene);
    seg.blocks.splice(idx, 1);
    const result = validateSceneUnfrozen(scene);
    if (result.valid) {
        leftMouseDownRemovedBlock = true;
        clearConflicts();
        showStatus('Block removed.', false);
        updateUI();
    } else {
        scene = oldScene;
        setConflicts(result.conflicts);
        showStatus('Removal would break invariants: ' + result.errors[0]);
        updateUI();
    }
}

/* ---------- Segment lifecycle / editing ---------- */
function setSegmentColour(id, colour) {
    const seg = scene.segments.find(s => s.id === id);
    if (!seg) return;
    const oldScene = cloneScene(scene);
    seg.colour = colour;
    const result = validateSceneUnfrozen(scene);
    if (result.valid) { clearConflicts(); showStatus('Colour changed.', false); updateUI(); }
    else { scene = oldScene; setConflicts(result.conflicts); showStatus('Colour change invalid: ' + result.errors[0]); updateUI(); }
}

function removeEmptyUnselectedSegment(previousId) {
    const seg = scene.segments.find(s => s.id === previousId);
    if (seg && seg.blocks.length === 0) scene.segments = scene.segments.filter(s => s.id !== previousId);
}

function selectSegment(id) {
    if (selectedSegmentId === id) return;
    if (selectedSegmentId !== null) removeEmptyUnselectedSegment(selectedSegmentId);
    selectedSegmentId = id;
    updateUI();
}

function createNewSegment(selectIt = true) {
    if (selectedSegmentId !== null) removeEmptyUnselectedSegment(selectedSegmentId);
    const oldScene = cloneScene(scene);
    const id = scene.nextId++;
    scene.segments.push({
        id,
        colour: 'slime',
        name: '',
        blocks: [],
        movement: rotateMovementToStartAt(scene.defaultMovement, logicalTime, scene.L),
        frozen: false
    });
    const result = validateSceneUnfrozen(scene);
    if (!result.valid) {
        scene = oldScene;
        setConflicts(result.conflicts);
        showStatus('Could not create a valid new segment: ' + result.errors[0]);
        updateUI();
        return;
    }
    if (selectIt) selectedSegmentId = id;
    clearConflicts();
    updateUI();
}

function deselectAndCreateBlank() {
    if (selectedSegmentId !== null) removeEmptyUnselectedSegment(selectedSegmentId);
    selectedSegmentId = null;
    createNewSegment(true);
}

/* ---------- Copy / paste ---------- */
function copySegmentUnderMouse() {
    const hit = hitTestBlock();
    if (!hit) { showStatus('No block under the cursor to copy.'); return; }
    const seg = scene.segments.find(s => s.id === hit.segId);
    if (!seg) return;
    clipboard = {
        colour: seg.colour,
        name: seg.name,
        blocks: seg.blocks.map(b => ({ x: b.x, y: b.y })),
        movement: seg.movement.slice(),
        frozen: !!seg.frozen,
        frozenInternalTime: seg.frozen ? seg.frozenInternalTime : undefined,
        anchor: { x: hit.blockX, y: hit.blockY }
    };
    showStatus('Segment copied.', false);
}

function pasteSegmentAtMouse() {
    if (!clipboard) { showStatus('Nothing to paste.'); return; }
    if (clipboard.movement.length !== scene.L) { showStatus('Cannot paste: copied segment has a different cycle length (L).'); return; }
    const oldScene = cloneScene(scene);
    const cell = getGridCellFromMouse();
    const id = scene.nextId++;
    const newSeg = {
        id,
        colour: clipboard.colour,
        name: clipboard.name,
        blocks: clipboard.blocks.map(b => ({ x: b.x, y: b.y })),
        movement: clipboard.movement.slice(),
        frozen: clipboard.frozen,
        frozenInternalTime: clipboard.frozen ? clipboard.frozenInternalTime : undefined
    };
    const internalT = getSegmentInternalTime(newSeg, logicalTime);
    const offset = getLogicalOffset(newSeg, internalT);
    const dx = cell.x - clipboard.anchor.x;
    const dy = (cell.y - offset) - clipboard.anchor.y;
    for (const b of newSeg.blocks) { b.x += dx; b.y += dy; }
    scene.segments.push(newSeg);
    const result = validateSceneUnfrozen(scene);
    if (!result.valid) {
        scene = oldScene;
        setConflicts(result.conflicts);
        showStatus('Paste would violate invariants: ' + result.errors[0]);
        updateUI();
        return;
    }
    clearConflicts();
    selectedSegmentId = id;
    showStatus('Segment pasted.', false);
    updateUI();
}

/* ---------- Timings ---------- */
function unfoldTiming(raw) {
    const out = [];
    for (const ch of raw.trim()) {
        if (ch === '0') out.push(0);
        else if (ch === '1') out.push(1);
        else if (ch === '2') out.push(2);
        else if (ch === 'm' || ch === 'M') out.push(1, 2);
        else if (ch === 'w' || ch === 'W') out.push(0, 0);
        else return null;
    }
    return out;
}

function foldTiming(movement) {
    const raw = movement.join('');
    let out = '', i = 0;
    while (i < raw.length) {
        if (raw[i] === '1' && raw[i + 1] === '2') { out += 'm'; i += 2; }
        else if (raw[i] === '0' && raw[i + 1] === '0') { out += 'w'; i += 2; }
        else { out += raw[i]; i += 1; }
    }
    return out;
}

function applyTiming() {
    if (!selectedSegmentId) return;
    const seg = scene.segments.find(s => s.id === selectedSegmentId);
    if (!seg) return;
    const raw = document.getElementById('timingInput').value;
    const unfolded = unfoldTiming(raw);
    if (!unfolded) { showStatus('Timings may only contain 0, 1, 2, m, w.'); return; }
    if (unfolded.length !== scene.L) {
        setConflicts([seg.id]);
        logicalTime = 0;
        showStatus(`Timing length after unfolding is ${unfolded.length}, but L is ${scene.L}.`);
        updateUI();
        return;
    }
    const oldScene = cloneScene(scene);
    seg.movement = unfolded;
    const result = validateSceneUnfrozen(scene);
    if (result.valid) {
        clearConflicts();
        logicalTime = 0;
        showStatus('Timings updated.', false);
        updateUI();
    } else {
        scene = oldScene;
        setConflicts(result.conflicts);
        logicalTime = 0;
        showStatus('Timing change invalid: ' + result.errors[0]);
        updateUI();
    }
}

function applyDefaultTiming() {
    const raw = document.getElementById('defaultTimingInput').value;
    const unfolded = unfoldTiming(raw);
    if (!unfolded) { showStatus('Default timings may only contain 0, 1, 2, m, w.'); return; }
    const check = validateMovementPattern(unfolded, scene.L, scene.B);
    if (!check.valid) { showStatus('Default timings invalid: ' + check.error); return; }
    scene.defaultMovement = unfolded;
    showStatus('Default timings updated.', false);
    updateUI();
}

/* ---------- Import / Export ---------- */
function exportJSON() {
    document.getElementById('jsonArea').value = JSON.stringify(scene);
    showStatus('Exported to textarea.', false);
}

function importJSON() {
    try {
        const data = JSON.parse(document.getElementById('jsonArea').value);
        if (!data || !Array.isArray(data.segments)) throw new Error('JSON must contain a segments array.');
        data.L = Number(data.L);
        data.B = Number(data.B);
        data.nextId = data.segments.reduce((max, s) => Math.max(max, s.id || 0), 0) + 1;
        for (const seg of data.segments) {
            if (typeof seg.frozen !== 'boolean') seg.frozen = false;
            if (seg.frozen && typeof seg.frozenInternalTime !== 'number') seg.frozenInternalTime = 0;
            delete seg.timeOffset;
        }
        if (!Array.isArray(data.defaultMovement) || !validateMovementPattern(data.defaultMovement, data.L, data.B).valid) {
            data.defaultMovement = makeMovement(data.L, data.B);
        }
        const result = validateSceneUnfrozen(data);
        if (!result.valid) { setConflicts(result.conflicts); showStatus('Import invalid: ' + result.errors[0]); return; }
        scene = data;
        logicalTime = 0;
        visualTime = 0;
        playing = false;
        pauseAtNextLogical = false;
        transitionActive = false;
        document.getElementById('play').textContent = 'Play';
        clearConflicts();
        clipboard = null;
        if (scene.segments.length > 0) selectedSegmentId = scene.segments[0].id;
        else selectedSegmentId = null;
        updateUI();
        showStatus('Imported successfully.', false);
    } catch (e) {
        showStatus('Import error: ' + e.message);
    }
}

/* ---------- Time stepping / playback ---------- */
function stepTime(delta) { if (playing) return; animateToLogical(logicalTime + delta); updateUI(); }

function resetTime() {
    playing = false;
    pauseAtNextLogical = false;
    document.getElementById('play').textContent = 'Play';
    animateToLogical(0);
    updateUI();
}

function togglePlay() {
    if (!playing) {
        pauseAtNextLogical = false;
        transitionActive = false;
        visualTime = logicalTime;
        playing = true;
        document.getElementById('play').textContent = 'Pause';
    } else {
        pauseAtNextLogical = true;
    }
    updateUI();
}

/* ---------- Keyboard ---------- */
function handleKeyboard(e) {
    if (e.target.matches('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySegmentUnderMouse(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteSegmentAtMouse(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepTime(-arrowStepSize); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepTime(arrowStepSize); return; }
    if (!e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'w') { panKeysHeld.w = true; return; }
        if (k === 'a') { panKeysHeld.a = true; return; }
        if (k === 's') { panKeysHeld.s = true; return; }
        if (k === 'd') { panKeysHeld.d = true; return; }
    }
    if (e.key.toLowerCase() === 'f') {
        if (!fKeyHeld) {
            fKeyHeld = true;
            fToggledThisSession = new Set();
            if (selectedSegmentId !== null) {
                toggleFreezeById(selectedSegmentId);
                fToggledThisSession.add(selectedSegmentId);
            }
        }
        e.preventDefault();
        return;
    }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); createNewSegment(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); deselectAndCreateBlank(); }
}

function handleKeyUp(e) {
    const k = e.key.toLowerCase();
    if (k === 'w') panKeysHeld.w = false;
    if (k === 'a') panKeysHeld.a = false;
    if (k === 's') panKeysHeld.s = false;
    if (k === 'd') panKeysHeld.d = false;
    if (k === 'f') { fKeyHeld = false; fToggledThisSession = new Set(); }
}

window.addEventListener('blur', () => {
    panKeysHeld.w = panKeysHeld.a = panKeysHeld.s = panKeysHeld.d = false;
    fKeyHeld = false;
    fToggledThisSession = new Set();
});

/* ---------- Animation loop ---------- */
const KEY_PAN_SPEED = 8;
let lastTime = performance.now();
function animate(now) {
    const dt = (now - lastTime) / 1000;

    if (panKeysHeld.w) panOffsetY += KEY_PAN_SPEED * dt;
    if (panKeysHeld.s) panOffsetY -= KEY_PAN_SPEED * dt;
    if (panKeysHeld.a) panOffsetX -= KEY_PAN_SPEED * dt;
    if (panKeysHeld.d) panOffsetX += KEY_PAN_SPEED * dt;

    if (!playing && transitionActive) {
        const oldVisual = visualTime;
        const distance = transitionTarget - oldVisual;
        const transitionSpeed = Math.max(4, playSpeed * 4);
        const move = transitionSpeed * dt;
        let newVisual;
        if (Math.abs(distance) <= move) { newVisual = transitionTarget; transitionActive = false; }
        else { newVisual = oldVisual + Math.sign(distance) * move; }

        if ((oldVisual < scene.L && newVisual >= scene.L) ||
            (oldVisual >= scene.L && newVisual < oldVisual)) {
            shiftFrozenBlocksOnWrap();
        }
        visualTime = normaliseTime(newVisual);
    }

    if (playing) {
        const oldVisual = visualTime;
        const newVisualRaw = oldVisual + dt * playSpeed;
        if (oldVisual < scene.L && newVisualRaw >= scene.L) {
            shiftFrozenBlocksOnWrap();
        }
        visualTime = normaliseTime(newVisualRaw);

        if (pauseAtNextLogical) {
            const oldFloor = Math.floor(oldVisual + 1e-9);
            const newFloor = Math.floor(visualTime + 1e-9);
            if (newFloor !== oldFloor || Math.abs(visualTime - Math.round(visualTime)) < 1e-6) {
                advanceLogicalTo(Math.round(visualTime));
                visualTime = logicalTime;
                playing = false;
                pauseAtNextLogical = false;
                document.getElementById('play').textContent = 'Play';
                updateTimeDisplay();
            }
        } else {
            advanceLogicalTo(Math.floor(visualTime + 1e-9));
            updateTimeDisplay();
        }
    }

    lastTime = now;
    draw();
    requestAnimationFrame(animate);
}

/* ---------- Event wiring ---------- */
canvas.addEventListener('mousedown', (e) => {
    updateMouse(e);
    if (e.button === 0 && e.ctrlKey && !e.shiftKey) {
        if (startSegmentDrag()) { e.preventDefault(); return; }
    }
    if (e.button === 0 && (e.ctrlKey || e.shiftKey)) {
        panning = true;
        panStartScreen = { x: mouseX, y: mouseY };
        panStartOffset = { x: panOffsetX, y: panOffsetY };
        e.preventDefault();
        return;
    }
    if (e.button === 2) {
        rightMouseDown = true;
        addBlockAtMouse();
        e.preventDefault();
    } else if (e.button === 0) {
        leftMouseDown = true;
        leftMouseDownWasEmpty = !hitTestBlock();
        leftMouseDownRemovedBlock = false;
        removeBlockAtMouse();
    }
});

canvas.addEventListener('mousemove', (e) => {
    updateMouse(e);
    if (draggingSegmentId !== null) { updateSegmentDrag(); return; }
    if (panning) {
        const dx = (mouseX - panStartScreen.x) / blockSize;
        const dy = (mouseY - panStartScreen.y) / blockSize;
        panOffsetX = panStartOffset.x - dx;
        panOffsetY = panStartOffset.y + dy;
        draw();
        return;
    }
    if (rightMouseDown) { addBlockAtMouse(); }
    else if (leftMouseDown) { removeBlockAtMouse(); }
    else {
        const hit = hitTestLogical();
        if (hit) {
            selectedSegmentId = hit;
            updateUI();
            if (fKeyHeld && !fToggledThisSession.has(hit)) {
                toggleFreezeById(hit);
                fToggledThisSession.add(hit);
            }
        }
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 2) rightMouseDown = false;
    if (e.button === 0) {
        leftMouseDown = false;
        endSegmentDrag();
        if (leftMouseDownWasEmpty && !leftMouseDownRemovedBlock) {
            createNewSegment(true);
        }
        leftMouseDownWasEmpty = false;
        leftMouseDownRemovedBlock = false;
    }
    panning = false;
});

canvas.addEventListener('mouseleave', () => {
    rightMouseDown = false; leftMouseDown = false;
    leftMouseDownWasEmpty = false; leftMouseDownRemovedBlock = false;
    panning = false;
    endSegmentDrag();
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    updateMouse(e);
    const camY = getCameraY();
    const worldXBefore = screenToWorldX(mouseX);
    const worldYBefore = screenToWorldY(mouseY, camY);
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomScale * zoomFactor));
    blockSize = baseBlockSize * zoomScale;
    panOffsetX = worldXBefore - (mouseX - originX) / blockSize;
    panOffsetY = (worldYBefore - camY) - (originY - mouseY) / blockSize;
    draw();
}, { passive: false });

// UI buttons
document.getElementById('step-2').addEventListener('click', () => stepTime(-2));
document.getElementById('step-1').addEventListener('click', () => stepTime(-1));
document.getElementById('reset').addEventListener('click', resetTime);
document.getElementById('step+1').addEventListener('click', () => stepTime(1));
document.getElementById('step+2').addEventListener('click', () => stepTime(2));
document.getElementById('play').addEventListener('click', togglePlay);
document.getElementById('applyTiming').addEventListener('click', applyTiming);
document.getElementById('applyDefaultTiming').addEventListener('click', applyDefaultTiming);
document.getElementById('export').addEventListener('click', exportJSON);
document.getElementById('import').addEventListener('click', importJSON);
document.getElementById('newSegment').addEventListener('click', () => createNewSegment(true));
document.getElementById('arrowStepToggle').addEventListener('click', () => {
    arrowStepSize = arrowStepSize === 1 ? 2 : 1;
    document.getElementById('arrowStepToggle').textContent = arrowStepSize + ' rt';
});
window.addEventListener('keydown', handleKeyboard);
window.addEventListener('keyup', handleKeyUp);

const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
speedSlider.addEventListener('input', () => {
    playSpeed = parseFloat(speedSlider.value);
    speedValue.textContent = playSpeed.toFixed(1) + ' rt/s';
});

document.querySelectorAll('.colour-btn').forEach(btn => {
    btn.addEventListener('click', () => setSegmentColour(selectedSegmentId, btn.dataset.colour));
});

document.getElementById('segName').addEventListener('input', (e) => {
    const seg = scene.segments.find(s => s.id === selectedSegmentId);
    if (seg) { seg.name = e.target.value; updateSegmentList(); draw(); }
});

/* ---------- Initialisation ---------- */
function startEditor(L, B) {
    scene = createFlyerScene(L, B);
    logicalTime = 0;
    visualTime = 0;
    playing = false;
    pauseAtNextLogical = false;
    transitionActive = false;
    transitionTarget = 0;
    clipboard = null;
    selectedSegmentId = scene.segments.length ? scene.segments[0].id : null;
    document.getElementById('setup-screen').style.display = 'none';
    resizeCanvas();
    updateUI();
    exportJSON();
}

document.getElementById('createFlyer').addEventListener('click', () => {
    const L = parseInt(document.getElementById('setupL').value, 10);
    const B = parseInt(document.getElementById('setupB').value, 10);
    const setupStatus = document.getElementById('setup-status');
    if (!Number.isInteger(L) || L < 2) { setupStatus.textContent = 'L must be an integer >= 2.'; return; }
    if (!Number.isInteger(B) || B < 0 || 2 * B > L) { setupStatus.textContent = 'B must be a non-negative integer with 2B <= L.'; return; }
    setupStatus.textContent = '';
    startEditor(L, B);
});

resizeCanvas();
requestAnimationFrame(animate);