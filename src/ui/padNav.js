// Pure gamepad-navigation helpers (no Phaser) — the logic behind the garage's pad focus
// cursors (#70): turning a held stick/d-pad into discrete steps with auto-repeat, stepping
// a focus index through a row or list, and scrolling a list so the focused item stays in
// view. The Phaser glue (reading pad buttons, painting the highlight) stays in the scene /
// WeaponCardList; everything here is unit-tested.

// Auto-repeat cadence for held directions: a step fires immediately, again after INITIAL,
// then every INTERVAL while held. Snappier than the old 360/150 stick stepping.
export const REPEAT_INITIAL = 300;
export const REPEAT_INTERVAL = 110;

// Dominant 4-way direction of an analog stick, or null inside the deadzone.
export function dominantDir(x, y, deadzone = 0.55) {
  if (Math.hypot(x, y) < deadzone) return null;
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
}

// Turns a per-frame held direction ('up'|'down'|'left'|'right'|null) into discrete steps
// with auto-repeat. Call step(dir, now) every frame; it returns the direction on the frames
// a step should fire, else null. A direction change (or release) resets the repeat timer,
// so flicking always steps instantly.
export class DirRepeater {
  constructor({ initial = REPEAT_INITIAL, interval = REPEAT_INTERVAL } = {}) {
    this.initial = initial;
    this.interval = interval;
    this._dir = null;
    this._next = 0;
  }

  step(dir, now) {
    if (!dir) { this._dir = null; return null; }
    if (dir !== this._dir) { this._dir = dir; this._next = now + this.initial; return dir; }
    if (now >= this._next) { this._next = now + this.interval; return dir; }
    return null;
  }
}

// Step a focus index by `delta` through `n` items. Wrapping (the tile row) or clamped
// (a scrolling list). Returns -1 for an empty collection.
export function stepIndex(i, delta, n, { wrap = true } = {}) {
  if (n <= 0) return -1;
  const j = i + delta;
  if (wrap) return ((j % n) + n) % n;
  return Math.min(n - 1, Math.max(0, j));
}

// Step `currentId` to the next/previous entry in `ids` (wrapping both ways). Used by pad-only
// "cycle the mounted item" controls (the simultaneous garage prototype's A/X mount-cycle) — the
// same wrap-and-step shape as data/mechColors.js's cycleSwatch, but with no distinctness
// constraint (two players' slots may hold the same weapon, unlike two players' colours). An empty
// list returns null; a `currentId` not found in the list (nothing mounted yet) starts a forward
// cycle at the first entry and a backward cycle at the last, so the first press always lands
// somewhere real rather than needing a prior selection.
export function cycleListId(ids, currentId, dir = 1) {
  if (!ids.length) return null;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return dir < 0 ? ids[ids.length - 1] : ids[0];
  const n = ids.length;
  return ids[((idx + (dir < 0 ? -1 : 1)) % n + n) % n];
}

// Minimal scroll adjustment so [itemTop, itemTop+itemH] (content coords) is visible in a
// viewport of height viewH scrolled to scrollY. Result clamped to [0, maxScroll].
export function scrollToShow(scrollY, itemTop, itemH, viewH, maxScroll) {
  let y = scrollY;
  if (itemTop < y) y = itemTop;
  else if (itemTop + itemH > y + viewH) y = itemTop + itemH - viewH;
  return Math.max(0, Math.min(Math.max(0, maxScroll), y));
}
