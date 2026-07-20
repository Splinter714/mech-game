// #346: on-screen touch sticks — the PURE model, no Phaser.
//
// Touch is a THIRD input source feeding the SAME per-frame intent object `Controls.read()`
// already produces for keyboard+mouse and for a gamepad. Nothing below the intent layer
// (locomotion, firing, targeting) knows touch exists. This file owns only the math:
// which half of the screen a finger landed on, where that stick's origin is, the
// origin→finger vector turned into a deadzoned/curved magnitude, and the aim stick's
// hold-last-angle memory. `TouchStickHud.js` draws it; `Controls.js` wires the events.
//
// SCOPE (#346, confirmed): movement stick + aim stick ONLY. Weapon triggers and dash are
// deliberately out of scope — the player drives and aims but does not fire.
//
// Movement mapping note: the issue describes "throttle and turn", but the game moved to
// twin-stick omnidirectional locomotion (`intent.move` is a world-space vector, magnitude
// <= 1) — tank throttle/turn is gone. So the movement stick maps its vector STRAIGHT to
// `intent.move`, exactly like the gamepad left stick does, which is the correct "matches
// the existing controls" behaviour for the code as it stands.

// ── Playtest dials (#346 flagged both of these as taste-only, settled by playing) ──
export const TOUCH_STICK = {
  // Radius in screen px from the stick origin at which the stick reads full deflection.
  // ~90px ≈ 12mm of thumb travel on a typical phone — comfortable without re-gripping.
  radius: 90,
  // Fraction of `radius` ignored around the origin. Smaller than the gamepad's 0.25: a
  // finger has no spring return and no mechanical slop, so a large deadzone just feels dead.
  deadzone: 0.12,
  // DIAL: response curve on the MOVEMENT magnitude. A thumb has far less precision than a
  // physical stick, so the low end is expanded — exponent > 1 means small deflections give
  // proportionally smaller speed, making a gentle nudge actually gentle. 1.0 = linear.
  moveCurve: 1.6,
  // DIAL: floating (stick appears where the thumb lands) vs fixed anchors. Floating is the
  // build Jackson accepted; flip this to false to get fixed anchors placed by
  // `fixedOrigins()` below — no other code changes needed.
  floating: true,
  // Used only when `floating` is false: anchor insets as a fraction of viewport width/height.
  fixedInsetX: 0.18,
  fixedInsetY: 0.72,
};

const TAU = Math.PI * 2;

// Fixed-mode anchor points for both sticks, given a viewport. Exported so the HUD can draw
// the resting rings in fixed mode without duplicating the placement rule.
export function fixedOrigins(width, height, cfg = TOUCH_STICK) {
  const y = height * cfg.fixedInsetY;
  return {
    move: { x: width * cfg.fixedInsetX, y },
    aim: { x: width * (1 - cfg.fixedInsetX), y },
  };
}

// Which stick a touch at screen x belongs to. Left half drives, right half aims.
export function stickSideFor(x, width) {
  return x < width / 2 ? 'move' : 'aim';
}

// origin → point, as a clamped, deadzoned, curved stick reading.
// Returns { x, y, mag, angle } where x/y are the unit direction scaled by `mag` (0..1),
// and `angle` is the raw direction in radians (meaningful only when mag > 0).
export function stickVector(origin, point, { radius = TOUCH_STICK.radius, deadzone = TOUCH_STICK.deadzone, curve = 1 } = {}) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { x: 0, y: 0, mag: 0, angle: 0 };
  const angle = Math.atan2(dy, dx);
  const raw = Math.min(1, dist / radius);
  if (raw <= deadzone) return { x: 0, y: 0, mag: 0, angle };
  // Rescale past the deadzone so the very first meaningful movement starts at 0, not at a
  // step of `deadzone` — then bend the low end with the response curve.
  const t = (raw - deadzone) / (1 - deadzone);
  const mag = Math.pow(t, curve);
  return { x: Math.cos(angle) * mag, y: Math.sin(angle) * mag, mag, angle };
}

// Normalise an angle to (-PI, PI]. Kept here so the hold-last-angle memory and the HUD
// agree on representation.
export function normalizeAngle(a) {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

// The two-stick model. Fed raw pointer down/move/up (screen coords + a stable pointer id)
// and read once per frame. Entirely pure — construct one, poke it, assert on `read()`.
export class TouchSticks {
  constructor({ width = 0, height = 0, config = TOUCH_STICK, aimAngle = -Math.PI / 2 } = {}) {
    this.cfg = config;
    this.width = width;
    this.height = height;
    // Hold-last-angle: the turret keeps pointing where it was last aimed when the thumb
    // lifts, rather than snapping back — the SAME semantics the gamepad right stick has.
    this.aimAngle = aimAngle;
    // side → { pointerId, origin: {x,y}, point: {x,y} } for the finger currently owning it.
    this.sticks = { move: null, aim: null };
    // Set once a genuine touch has been seen, so desktop is never affected.
    this.used = false;
  }

  setViewport(width, height) {
    this.width = width;
    this.height = height;
  }

  // A finger touched down. Claims the stick for the half of the screen it landed on; a
  // second finger on an already-owned half is ignored (the first finger keeps control).
  pointerDown(id, x, y) {
    const side = stickSideFor(x, this.width);
    if (this.sticks[side]) return null;
    const origin = this.cfg.floating
      ? { x, y }
      : { ...fixedOrigins(this.width, this.height, this.cfg)[side] };
    this.sticks[side] = { pointerId: id, origin, point: { x, y } };
    this.used = true;
    return side;
  }

  // A finger moved. A stick belongs to the finger that claimed it until that finger lifts,
  // so dragging across the screen's midline does NOT hand control to the other stick.
  pointerMove(id, x, y) {
    for (const side of ['move', 'aim']) {
      const s = this.sticks[side];
      if (s && s.pointerId === id) { s.point = { x, y }; return side; }
    }
    return null;
  }

  pointerUp(id) {
    for (const side of ['move', 'aim']) {
      const s = this.sticks[side];
      if (s && s.pointerId === id) { this.sticks[side] = null; return side; }
    }
    return null;
  }

  // Drop every finger — used when the scene loses focus/shuts down so a stick can't latch on.
  releaseAll() {
    this.sticks.move = null;
    this.sticks.aim = null;
  }

  // True while any finger is on a stick.
  isActive() {
    return !!(this.sticks.move || this.sticks.aim);
  }

  // Live geometry for one stick, or null if no finger owns it — what the HUD draws.
  // `knob` is the origin-relative offset of the drawn thumb, clamped to the stick radius.
  stickState(side) {
    const s = this.sticks[side];
    if (!s) return null;
    const curve = side === 'move' ? this.cfg.moveCurve : 1;
    const v = stickVector(s.origin, s.point, {
      radius: this.cfg.radius, deadzone: this.cfg.deadzone, curve,
    });
    const dx = s.point.x - s.origin.x;
    const dy = s.point.y - s.origin.y;
    const dist = Math.hypot(dx, dy);
    const k = dist > this.cfg.radius ? this.cfg.radius / dist : 1;
    return { origin: s.origin, vector: v, knob: { x: dx * k, y: dy * k } };
  }

  // The per-frame contribution to the input intent.
  //   move     — world-space vector, magnitude <= 1 (same shape the pad's left stick gives)
  //   aimAngle — held from the last meaningful aim deflection (never snaps back)
  read() {
    const mv = this.stickState('move');
    const move = mv ? { x: mv.vector.x, y: mv.vector.y } : { x: 0, y: 0 };

    const am = this.stickState('aim');
    if (am && am.vector.mag > 0) this.aimAngle = normalizeAngle(am.vector.angle);

    return { move, aimAngle: this.aimAngle, active: this.isActive() };
  }
}
