'use strict';

/* ======================================================
 *  MODEL – state and pure logic
 * ====================================================== */

// Colour definitions and utilities
const COLOURS = {
    slime: '#7cc24e',
    honey: '#f2c144',
    blue: '#4a8fd4'
};

function whiten(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.round(r + (255 - r) * amount);
    const ng = Math.round(g + (255 - g) * amount);
    const nb = Math.round(b + (255 - b) * amount);
    return `rgb(${nr},${ng},${nb})`;
}

function makeMovement(L, B) {
    return [...Array(B)].flatMap(() => [1, 2]).concat(Array(L - 2 * B).fill(0));
}

function createFlyerScene(L, B) {
    const movement = makeMovement(L, B);
    return {
        L,
        B,
        segments: [
            {
                id: 1,
                colour: 'slime',
                name: 'Core',
                blocks: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
                movement: movement.slice(),
                frozen: false
            },
            {
                id: 2,
                colour: 'honey',
                name: 'Piston',
                blocks: [{ x: 2, y: 0 }, { x: 2, y: 1 }],
                movement: movement.slice(),
                frozen: false
            }
        ],
        nextId: 3,
        defaultMovement: movement.slice()
    };
}

function cloneScene(s) {
    return JSON.parse(JSON.stringify(s));
}

/* ---------- Movement and time helpers ---------- */

function countTwosBefore(movement, t) {
    let c = 0;
    for (let i = 0; i < t; i++) if (movement[i] === 2) c++;
    return c;
}

/**
 * Logical offset of a segment at a given time.
 * The `L` parameter avoids relying on the global `scene` when working
 * with cloned scenes.
 */
function getLogicalOffset(seg, time, L = scene.L) {
    const t = ((time % L) + L) % L;
    const i = Math.floor(t);
    return countTwosBefore(seg.movement, i) + (seg.movement[i] === 2 ? 1 : 0);
}

function visStateValue(s) {
    if (s === 1) return 0.2;
    if (s === 2) return -0.2;
    return 0;
}

/**
 * Visual world offset for a segment at continuous visual time.
 * Logical offset already includes the +1 shift when state is 2, so
 * visStateValue just adds a small visual nudge (0.2 or -0.2).
 */
function getVisualOffset(seg, time) {
    const L = scene.L;
    const t = ((time % L) + L) % L;
    const i = Math.floor(t);
    const f = t - i;

    const offset_i = getLogicalOffset(seg, i);
    const vi = offset_i + visStateValue(seg.movement[i]);

    let nextOffset, nextState;
    if (i === L - 1) {
        nextOffset = getLogicalOffset(seg, 0) + scene.B;
        nextState = seg.movement[0];
    } else {
        nextOffset = getLogicalOffset(seg, i + 1);
        nextState = seg.movement[i + 1];
    }
    const vn = nextOffset + visStateValue(nextState);

    return vi + (vn - vi) * f;
}

function normaliseTime(t) {
    return ((t % scene.L) + scene.L) % scene.L;
}

/* ---------- Freezing / unfreezing ---------- */

function getSegmentInternalTime(seg, globalT) {
    if (seg.frozen) return seg.frozenInternalTime;
    return globalT;
}

function freezeSegment(seg) {
    if (seg.frozen) return;
    seg.frozenInternalTime = normaliseTime(logicalTime);
    seg.frozen = true;
}

function rotateMovementToStartAt(movement, startIndex, L) {
    const rotated = new Array(L);
    for (let t = 0; t < L; t++) {
        rotated[t] = movement[((t - startIndex) % L + L) % L];
    }
    return rotated;
}

/**
 * Shift all frozen segments' blocks down by B when the visual time wraps.
 * This keeps them visually aligned with the grid without any extra visual
 * compensation.
 */
function shiftFrozenBlocksOnWrap() {
    for (const seg of scene.segments) {
        if (seg.frozen) {
            for (const block of seg.blocks) {
                block.y -= scene.B;
            }
        }
    }
}

/**
 * Unfreeze a segment in a given scene (typically a clone).
 * The segment's movement array is rotated so that its new cycle starts at
 * `unfreezeTime`, and its blocks are shifted to keep the same world position.
 */
function unfreezeSegmentInScene(seg, targetScene, unfreezeTime = logicalTime) {
    if (!seg.frozen) return;
    const L = targetScene.L;
    const F = normaliseTime(seg.frozenInternalTime);
    const T = normaliseTime(unfreezeTime);

    const oldOffset = getLogicalOffset(seg, F, L);

    const newMovement = rotateMovementToStartAt(seg.movement, T - F, L);
    const newOffset = getLogicalOffset({ movement: newMovement }, T, L);

    const delta = oldOffset - newOffset;

    seg.movement = newMovement;
    for (const block of seg.blocks) {
        block.y += delta;
    }
    seg.frozen = false;
    delete seg.frozenInternalTime;
}

function unfreezeSegmentNoValidate(seg) {
    if (!seg.frozen) return false;
    unfreezeSegmentInScene(seg, scene);
    return true;
}

function unfreezeSegment(seg) {
    if (!seg.frozen) return false;
    const oldScene = cloneScene(scene);
    if (!unfreezeSegmentNoValidate(seg)) return false;
    const result = validateSceneUnfrozen(scene);
    if (!result.valid) {
        scene = oldScene;
        setConflicts(result.conflicts);
        showStatus('Unfreeze would violate invariants; no changes made.', true);
        updateUI();
        return false;
    }
    return true;
}

function toggleFreezeById(id) {
    const seg = scene.segments.find(s => s.id === id);
    if (!seg) return;
    if (seg.frozen) {
        unfreezeSegmentInScene(seg, scene);
    } else {
        seg.frozenInternalTime = normaliseTime(logicalTime);
        seg.frozen = true;
    }
    updateUI();
}

/* ---------- Conflict resolution ---------- */

/**
 * Try to advance to a target logical time while preserving invariants.
 * The loop:
 *  1. Simulate unfreezing ALL frozen segments at the target time and validate.
 *  2. If valid, stop.
 *  3. Otherwise, unfreeze the conflicting frozen segments at the CURRENT time.
 *  4. Repeat until no frozen segments remain or a valid state is reached.
 * Unfreezing everything at the current time is always valid, so this
 * terminates.
 */
function resolveFreezeConflicts(targetTime) {
    const unfrozenNames = [];
    while (scene.segments.some(s => s.frozen)) {
        const result = validateSceneUnfrozen(scene, targetTime);
        if (result.valid) break;

        let unfrozeAny = false;
        for (const seg of scene.segments) {
            if (seg.frozen && result.conflicts.has(seg.id)) {
                unfreezeSegmentInScene(seg, scene, logicalTime);
                unfrozenNames.push(seg.name || `Segment ${seg.id}`);
                unfrozeAny = true;
            }
        }
        if (!unfrozeAny) return false;
    }
    if (unfrozenNames.length > 0) {
        showStatus(`Auto-unfroze ${unfrozenNames.join(', ')} to avoid an invariant violation.`, true);
    }
    return true;
}

function advanceLogicalTo(target) {
    const wrapped = ((Math.round(target) % scene.L) + scene.L) % scene.L;
    if (wrapped === logicalTime) return;
    if (!resolveFreezeConflicts(wrapped)) {
        showStatus('Cannot move: invariants would be violated and no safe unfreeze is possible.', true);
        return;
    }
    setLogicalTime(wrapped);
}

function animateToLogical(target) {
    if (playing) return;
    advanceLogicalTo(target);
    const startTime = visualTime;
    const startMod = normaliseTime(startTime);
    const targetMod = logicalTime;
    let delta = targetMod - startMod;
    if (delta > scene.L / 2) delta -= scene.L;
    if (delta < -scene.L / 2) delta += scene.L;
    transitionTarget = startTime + delta;
    transitionActive = Math.abs(delta) > 0.000001;
    if (!transitionActive) visualTime = transitionTarget;
}

/* ======================================================
 *  VALIDATION
 * ====================================================== */

/**
 * Raw invariant checker. Assumes all segments are unfrozen.
 */
function validateScene(scene) {
    const conflicts = new Set();
    const errors = [];

    if (2 * scene.B > scene.L) {
        errors.push(`2B <= L violated: B=${scene.B}, L=${scene.L}`);
        scene.segments.forEach(s => conflicts.add(s.id));
        return { valid: false, conflicts, errors };
    }

    let movementValid = true;
    for (const seg of scene.segments) {
        if (seg.movement.length !== scene.L) {
            errors.push(`Segment ${seg.id}: movement length ${seg.movement.length} != L ${scene.L}`);
            conflicts.add(seg.id);
            movementValid = false;
            continue;
        }
        const ones = seg.movement.filter(v => v === 1).length;
        if (ones !== scene.B) {
            errors.push(`Segment ${seg.id}: number of 1s ${ones} != B ${scene.B}`);
            conflicts.add(seg.id);
            movementValid = false;
        }
        for (let i = 0; i < scene.L; i++) {
            if (seg.movement[i] === 1 && seg.movement[(i + 1) % scene.L] !== 2) {
                errors.push(`Segment ${seg.id}: 1 at index ${i} is not followed by 2`);
                conflicts.add(seg.id);
                movementValid = false;
            }
            if (seg.movement[i] === 2 && seg.movement[(i - 1 + scene.L) % scene.L] !== 1) {
                errors.push(`Segment ${seg.id}: 2 at index ${i} is not preceded by 1`);
                conflicts.add(seg.id);
                movementValid = false;
            }
        }
    }
    if (!movementValid) return { valid: false, conflicts, errors };

    for (let t = 0; t < scene.L; t++) {
        const map = new Map();
        let overlap = false;
        for (const seg of scene.segments) {
            const offset = getLogicalOffset(seg, t, scene.L);
            const state = seg.movement[t];
            for (const block of seg.blocks) {
                const y = block.y + offset;
                const key = `${block.x},${y}`;
                if (map.has(key)) {
                    errors.push(`Overlap at time ${t} at (${key}) between segments ${map.get(key).segId} and ${seg.id}`);
                    conflicts.add(seg.id);
                    conflicts.add(map.get(key).segId);
                    overlap = true;
                } else {
                    map.set(key, { segId: seg.id, state, colour: seg.colour });
                }
            }
        }
        if (overlap) continue;
        for (const [key, entry] of map) {
            const [x, y] = key.split(',').map(Number);
            const neighbours = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
            for (const [nx, ny] of neighbours) {
                const nKey = `${nx},${ny}`;
                const nEntry = map.get(nKey);
                if (!nEntry || nEntry.segId === entry.segId || nEntry.colour !== entry.colour) continue;
                const s1 = entry.state, s2 = nEntry.state;
                if (s1 === 0 || s2 === 0 || (s1 === 1 && s2 === 2) || (s1 === 2 && s2 === 1)) {
                    errors.push(`Same-colour adjacency conflict at time ${t} between segments ${entry.segId} and ${nEntry.segId}`);
                    conflicts.add(entry.segId);
                    conflicts.add(nEntry.segId);
                }
            }
        }
    }

    return { valid: errors.length === 0, conflicts, errors };
}

/**
 * Public validator: simulates unfreezing all frozen segments at the given
 * time, then calls validateScene on the clone.
 */
function validateSceneUnfrozen(scene, unfreezeTime = logicalTime) {
    const simulated = cloneScene(scene);
    for (const seg of simulated.segments) {
        if (seg.frozen) {
            unfreezeSegmentInScene(seg, simulated, unfreezeTime);
        }
    }
    return validateScene(simulated);
}

function validateMovementPattern(movement, L, B) {
    if (!Array.isArray(movement) || movement.length !== L) {
        return { valid: false, error: `length must be ${L}` };
    }
    const ones = movement.filter(v => v === 1).length;
    if (ones !== B) {
        return { valid: false, error: `number of 1s must be ${B}` };
    }
    for (let i = 0; i < L; i++) {
        if (movement[i] === 1 && movement[(i + 1) % L] !== 2) {
            return { valid: false, error: `1 at index ${i} is not followed by 2` };
        }
        if (movement[i] === 2 && movement[(i - 1 + L) % L] !== 1) {
            return { valid: false, error: `2 at index ${i} is not preceded by 1` };
        }
    }
    return { valid: true };
}