// Input abstraction. The arena reads an "intent" each frame — a world-space move vector
// for the legs, an aim (mouse point OR right-stick direction) for the turret, and a held
// flag per skill slot — instead of touching raw keys. Keyboard+mouse and a gamepad both
// feed the same intent, so binding/feel changes live here, not in the scene.
//
// Twin-stick controls: the left stick / WASD moves the mech omnidirectionally in world
// space (no tank turning), the right stick / mouse aims the turret freely (full 360°, no
// torso-twist arc). Skill slots are body locations, each on a fixed button (SKILL_BINDS):
//   right arm    RT / right-mouse        left arm     LT / left-mouse
//   right torso  RB / E                  left torso   LB / Q
// R3 is no longer a fire bind — the head stopped being a skill slot (#31). #62's R3 "drop the
// current indirect-fire lock" action was removed by #252, which replaced the lock with a live
// mirror of convergence that has no maintained state left to drop. #262 then gave R3 (keyboard:
// F) an enemy-vs-building targeting-focus toggle, and #322 removed that too (Jackson: "we don't
// want to need enemy vs terrain mode anymore" — one rule now scores both pools, so there is
// nothing to flip; see ArenaScene.js). R3 and F are therefore UNBOUND.
//
// #188: L3/Space used to fire the mounted ability (jumpJet/bubbleShield). That slot is gone —
// L3/Space was a hardcoded, always-available Sprint ability (data/sprint.js), never routed
// through mounts. #261: player-initiated Sprint is gone too — L3/Space now triggers a Dash (a
// single-shot burst on a cooldown, data/dash.js) instead. A dash is inherently a discrete
// one-shot activation (not a sustained hold-vs-toggle state), so BOTH devices now use the same
// press-to-trigger semantics: `read()` reports one rising-edge one-shot, `dashPressed`, picked
// from whichever device is currently active. Unlike Sprint's old hold-to-sprint keyboard path
// (which just read the raw down state every frame, no edge needed), a discrete trigger needs an
// actual edge on keyboard too — Space is polled every frame like any other key, it doesn't
// naturally arrive pre-edge-detected the way a Phaser `keydown-*` event would — so keyboard gets
// its own rising-edge tracker here, mirroring the one already used for the pad's L3 button.
// (The old Sprint mechanic itself, data/sprint.js, is untouched — Overclock still force-activates
// it; only the player's own trigger for it is gone, replaced by this Dash bind.)

// Exported so other modules (e.g. arena/locomotion.js's instant-turning facing-angle gate,
// #156) can reuse the same "is this raw input meaningful" threshold instead of inventing one.
// #346: touch is a THIRD source feeding this same intent — an on-screen movement stick on the
// left half of the screen and an aim stick on the right, both floating (they appear where the
// thumb lands). The stick MATH is pure and lives in `touchSticks.js`; this file only routes
// Phaser pointer events into it and folds the result into `read()`'s intent, exactly like the
// pad path. Weapon triggers and dash are deliberately OUT of scope (#346) — on touch the
// player drives and aims but does not fire; `fire` reads all-false and `dashPressed` false.
// Desktop is untouched: touch mode only latches once a genuine TOUCH pointer is seen
// (`pointer.wasTouch`), and the mouse-activity checks below now ignore touch-driven pointers
// so a touch drag can never be mistaken for mouse movement.
import { TouchSticks } from './touchSticks.js';

export const STICK_DEADZONE = 0.25;
const TRIGGER_THRESHOLD = 0.3;

// Standard-gamepad button indices Phaser doesn't name (sticks, d-pad, menu buttons).
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9, L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
};
const PAD_L3 = PAD.L3;

// location → { key (keyboard/mouse label), pad (controller label) }. Order here is the
// display order used by the garage/HUD. #188: four weapon skill slots — the fifth
// (centerTorso, the old ability slot) is gone; Dash's bind (#261, was Sprint's) lives in
// DASH_BIND below, separate from this table since it's not a mountable location at all.
export const SKILL_BINDS = {
  rightArm:    { key: 'RMB',   pad: 'RT' },
  leftArm:     { key: 'LMB',   pad: 'LT' },
  rightTorso:  { key: 'E',     pad: 'RB' },
  leftTorso:   { key: 'Q',     pad: 'LB' },
};

// Dash's fixed bind (#261, was Sprint's bind under #188) — always available, never mounted, so
// it isn't keyed by a body location like SKILL_BINDS. Exported for the HUD's cooldown label.
export const DASH_BIND = { key: 'Space', pad: 'L3' };

// Rising-edge detector for gamepad buttons — call a `pressed(i)` per frame and it returns
// true only on the frame the button goes down. Used for one-shot actions (toggles, scene
// transitions) where the held-flag fire intent isn't appropriate. One instance per scene
// that needs button edges; each button index should be polled at most once per frame.
export class PadEdges {
  constructor(scene) {
    this.scene = scene;
    this.prev = {};
    // #122: same fresh-scene Gamepad-wrapper quirk as Controls (see its constructor comment) —
    // force an immediate resync so a pad already connected/held when this scene starts isn't
    // read as all-zero until its next genuinely new native state-change timestamp.
    for (const pad of scene.input.gamepad?.getAll?.() ?? []) pad._created = 0;
  }
  pad() {
    const gp = this.scene.input.gamepad;
    const p = gp && gp.total ? gp.getPad(0) : null;
    return p && p.connected ? p : null;
  }
  pressed(i) {
    const p = this.pad();
    const down = !!(p && p.buttons[i] && p.buttons[i].pressed);
    // On the first poll of this index, seed the baseline to the current state so a
    // button already held when this PadEdges is constructed (e.g. right after a scene
    // transition) never registers as a fresh press. Real up→down transitions on later
    // polls still fire normally.
    const firstPoll = !(i in this.prev);
    const was = firstPoll ? down : this.prev[i];
    this.prev[i] = down;
    return down && !was;
  }
}

export class Controls {
  constructor(scene) {
    this.scene = scene;
    this.keys = scene.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,Q,E,F,SPACE');
    scene.input.mouse?.disableContextMenu(); // so right-click fires instead of opening a menu

    // #122: each Phaser Scene gets its OWN GamepadPlugin, so a pad already connected (and in
    // active use, e.g. Garage → Arena deploy) is wrapped in a brand-new `Gamepad` instance here
    // whose private `_created` timestamp is "now" (the transition instant). Phaser's
    // `Gamepad.update()` refuses to sync button/axis values whenever the NATIVE pad's
    // `timestamp` is older than that `_created` cutoff — and a real controller's timestamp only
    // advances when its hardware state actually changes. If the player is holding the stick
    // steady (or a button held) right through the transition, no new native timestamp is ever
    // generated, so the freshly-created wrapper reads all-zero forever and this scene's
    // `Controls` never sees `padActive`, latching on 'kbm' until the player happens to move the
    // stick/press a button again (a genuinely new native timestamp). Force every pad this scene
    // already knows about to re-sync unconditionally on the very next poll by clearing that
    // cutoff, so already-held input is picked up immediately rather than waiting for a fresh
    // physical edge that may not come.
    for (const pad of scene.input.gamepad?.getAll?.() ?? []) pad._created = 0;

    // Active input scheme. We latch onto whichever device was used last: once a pad is
    // touched we stay in 'pad' mode (ignoring the mouse, holding the last aim when the
    // right stick is centred) until the mouse/keyboard is used again, and vice-versa.
    this.mode = 'kbm';
    this.aimAngle = -Math.PI / 2;  // remembered turret aim, so a centred stick holds it
    this._px = 0; this._py = 0;    // last pointer position, to detect real mouse movement
    this._padDashDown = false;     // previous frame's raw L3 state, for edge-detecting the dash trigger
    this._kbDashDown = false;      // previous frame's raw Space state, for edge-detecting the dash trigger

    // #346: on-screen sticks. Only wired up when the device can actually produce touches;
    // even then, `mode` doesn't become 'touch' until a real touch pointer arrives, so a
    // touchscreen laptop driven by mouse+keyboard behaves exactly as it always has.
    this.touch = null;
    if (Controls.touchCapable()) this._initTouch();
  }

  // Capability probe only — NOT "is the player using touch". Guarded so the module still
  // imports cleanly under Node/vitest, where there is no window.
  static touchCapable() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  }

  _initTouch() {
    const scene = this.scene;
    const cam = scene.cameras?.main;
    const w = cam?.width ?? scene.scale?.width ?? 0;
    const h = cam?.height ?? scene.scale?.height ?? 0;
    this.touch = new TouchSticks({ width: w, height: h, aimAngle: this.aimAngle });

    // Phaser tracks one pointer by default; two thumbs need two more slots.
    scene.input.addPointer?.(2);

    const isTouch = (p) => !!p && p.wasTouch === true;
    scene.input.on('pointerdown', (p) => {
      if (!isTouch(p)) return;
      this.touch.setViewport(this._viewW(), this._viewH());
      if (this.touch.pointerDown(p.id, p.x, p.y)) this.mode = 'touch';
    });
    scene.input.on('pointermove', (p) => {
      if (!isTouch(p)) return;
      this.touch.pointerMove(p.id, p.x, p.y);
    });
    const up = (p) => { if (isTouch(p)) this.touch.pointerUp(p.id); };
    scene.input.on('pointerup', up);
    scene.input.on('pointerupoutside', up);
    // A scene shutdown / lost focus must not leave a stick latched down.
    scene.events?.once?.('shutdown', () => this.touch.releaseAll());
  }

  _viewW() { return this.scene.cameras?.main?.width ?? this.scene.scale?.width ?? 0; }
  _viewH() { return this.scene.cameras?.main?.height ?? this.scene.scale?.height ?? 0; }

  pad() {
    const gp = this.scene.input.gamepad;
    const p = gp && gp.total ? gp.getPad(0) : null;
    return p && p.connected ? p : null;
  }

  // Read the current frame's intent. `move` is a world-space vector (magnitude <= 1);
  // `fire` is keyed by location; `mode` is the active input scheme ('kbm' | 'pad').
  read() {
    const k = this.keys;
    const p = this.scene.input.activePointer;
    const pad = this.pad();
    const ls = pad?.leftStick, rs = pad?.rightStick;

    // ── Decide which scheme is active (last device used wins) ──
    const padMove = !!(ls && ls.length() > STICK_DEADZONE);
    const padAim = !!(rs && rs.length() > STICK_DEADZONE);
    const padBtn = !!(pad && pad.buttons.some((b) => b && b.pressed));
    const padActive = padMove || padAim || padBtn;

    // #346: a touch drag moves `activePointer` too, so mouse activity must exclude
    // touch-driven pointers or every touch would immediately yank the mode back to 'kbm'.
    // `wasTouch` is false for a real mouse, so this is a no-op on desktop.
    const pointerIsTouch = p.wasTouch === true;
    const mouseMoved = (p.x !== this._px || p.y !== this._py) && !pointerIsTouch;
    this._px = p.x; this._py = p.y;
    const kbDown = ['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'Q', 'E', 'F', 'SPACE']
      .some((key) => k[key].isDown);
    const mouseBtn = !pointerIsTouch && (p.leftButtonDown() || p.rightButtonDown());
    const kbmActive = mouseMoved || mouseBtn || kbDown;

    if (padActive) this.mode = 'pad';
    else if (kbmActive) this.mode = 'kbm';
    // else: no input this frame — stay in the current mode (don't fall back to mouse).
    // (Touch latches `mode = 'touch'` in the pointerdown handler, and nothing above can
    // clear it except genuine pad/mouse/keyboard activity — which is what we want.)

    // ── Touch (#346) ── movement + aim only; no fire, no dash. Handled before the
    // pad/kbm split below so those paths stay byte-for-byte the behaviour they had.
    if (this.mode === 'touch' && this.touch) {
      this.touch.setViewport(this._viewW(), this._viewH());
      const t = this.touch.read();
      this.aimAngle = t.aimAngle;   // keep the shared aim memory in sync across schemes
      return {
        move: t.move,
        aim: { mode: 'angle', angle: t.aimAngle },
        fire: { rightArm: false, leftArm: false, rightTorso: false, leftTorso: false },
        mode: 'touch',
        dashPressed: false,
      };
    }

    // Effective scheme: only use the pad path if a pad is actually present (a disconnect
    // while latched in pad mode falls back to mouse/keyboard).
    const padMode = this.mode === 'pad' && !!pad;

    // ── Movement ──
    let move;
    if (padMode) {
      move = padMove ? { x: ls.x, y: ls.y } : { x: 0, y: 0 };
    } else {
      const mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
      const my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
      move = { x: mx, y: my };
    }
    const mag = Math.hypot(move.x, move.y);
    if (mag > 1) { move.x /= mag; move.y /= mag; }

    // ── Aim ── pad: right stick (hold last angle when centred); kbm: mouse pointer. ──
    let aim;
    if (padMode) {
      if (padAim) this.aimAngle = Math.atan2(rs.y, rs.x);
      aim = { mode: 'angle', angle: this.aimAngle };
    } else {
      aim = { mode: 'pointer', x: p.worldX, y: p.worldY };
    }

    // ── Fire ── only from the active scheme's buttons. ──
    let fire;
    if (padMode) {
      fire = {
        rightArm:    pad.R2 > TRIGGER_THRESHOLD,
        leftArm:     pad.L2 > TRIGGER_THRESHOLD,
        rightTorso:  pad.R1,
        leftTorso:   pad.L1,
      };
    } else {
      fire = {
        rightArm:    p.rightButtonDown(),
        leftArm:     p.leftButtonDown(),
        rightTorso:  k.E.isDown,
        leftTorso:   k.Q.isDown,
      };
    }

    // ── Dash (#261) ── press-to-trigger on BOTH devices now (was Sprint's hold-vs-toggle
    // split, #188). Edge-detect each device's raw button independently every frame (regardless
    // of which scheme is currently active, so a mode switch mid-press can't leave a stale edge
    // from the previously-active device), then report just the ONE edge that matches the
    // currently-active scheme as `dashPressed`.
    const padDashDown = !!(pad && pad.buttons[PAD_L3] && pad.buttons[PAD_L3].pressed);
    const padDashPressed = padDashDown && !this._padDashDown;
    this._padDashDown = padDashDown;
    const kbDashDown = k.SPACE.isDown;
    const kbDashPressed = kbDashDown && !this._kbDashDown;
    this._kbDashDown = kbDashDown;
    const dashPressed = padMode ? padDashPressed : kbDashPressed;

    return { move, aim, fire, mode: padMode ? 'pad' : 'kbm', dashPressed };
  }
}
