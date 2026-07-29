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
// #188: L3/Space used to fire the mounted ability (jumpJet/bubbleShield). That slot was removed,
// then #261 gave L3/Space a hardcoded Dash instead. #506 removed the hardcoding a second time,
// properly that time: independently-mounted ABILITY slots (data/abilities.js, Dash is the first
// entry), one per gamepad face button with a keyboard row alongside. A later pass cut that down
// to just two (Jackson, confirmed): "active core abilities should just be two and bound to X and
// Y, leaving A for a generic interact we may need, and maybe B for reload." So today: Y and X are
// the only mountable ability slots; A is RESERVED (no bind at all — left free for a future
// concrete use, not repurposed); B is the manual-RELOAD bind (moved off L3, see RELOAD_BIND).
// Each ability is a discrete one-shot activation (not a sustained hold-vs-toggle state), so both
// devices use the same press-to-trigger semantics: `read()` reports one rising edge per slot in
// `ability`, picked from whichever device is currently active. Keyboard needs its own edge
// tracker (a key is polled every frame, it doesn't arrive pre-edge-detected the way a Phaser
// `keydown-*` event would) — same pattern the old dash/reload trackers used.

// Exported so other modules (e.g. arena/locomotion.js's instant-turning facing-angle gate,
// #156) can reuse the same "is this raw input meaningful" threshold instead of inventing one.
// #346: touch is a THIRD source feeding this same intent — an on-screen movement stick on the
// left half of the screen and an aim stick on the right, both floating (they appear where the
// thumb lands). The stick MATH is pure and lives in `touchSticks.js`; this file only routes
// Phaser pointer events into it and folds the result into `read()`'s intent, exactly like the
// pad path. Weapon triggers and dash are deliberately OUT of scope (#346) — on touch the
// player drives and aims but does not fire; `fire` reads all-false and every `ability` slot false.
// Desktop is untouched: touch mode only latches once a genuine TOUCH pointer is seen
// (`pointer.wasTouch`), and the mouse-activity checks below now ignore touch-driven pointers
// so a touch drag can never be mistaken for mouse movement.
import { TouchSticks } from './touchSticks.js';
import { ABILITY_SLOTS } from '../data/anatomy.js';

export const STICK_DEADZONE = 0.25;
const TRIGGER_THRESHOLD = 0.3;

// #565: rescale a raw stick (x, y) so its output magnitude ramps smoothly from 0 at the
// deadzone edge up to 1 at full deflection, instead of the old hard on/off snap (zero inside
// the deadzone, then an instant jump to the raw value the moment it's crossed). Direction is
// preserved exactly — only magnitude is reshaped — so this is a drop-in replacement for the
// previous "is magnitude > deadzone ? raw value : 0" gating.
function applyStickDeadzone(x, y, deadzone) {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
  return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled };
}

// #386: master switch for the on-screen touch sticks. OFF — on an iPad they activated even
// with a Bluetooth controller attached (touchCapable() is true on any touch device) and
// hijacked input, breaking the gamepad; the owner also concluded touch controls aren't viable
// for this game. With this false, touchCapable() returns false, so _initTouch() never runs and
// no TouchStickHud is built — touch devices now behave exactly like desktop. The whole touch
// implementation is intact; flip this back to true to restore it.
export const TOUCH_STICKS_ENABLED = false;

// Standard-gamepad button indices Phaser doesn't name (sticks, d-pad, menu buttons).
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9, L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
};

// location → { key (keyboard/mouse label), pad (controller label) }. Order here is the
// display order used by the garage/HUD. #188: four weapon skill slots — the fifth
// (centerTorso, the old ability slot) is gone; abilities now live in their own ABILITY_SLOTS
// (anatomy.js) with their own ABILITY_BINDS below, separate from this table.
export const SKILL_BINDS = {
  rightArm:    { key: 'RMB',   pad: 'RT' },
  leftArm:     { key: 'LMB',   pad: 'LT' },
  rightTorso:  { key: 'E',     pad: 'RB' },
  leftTorso:   { key: 'Q',     pad: 'LB' },
};

// Manual-RELOAD bind: B on pad (moved off L3 now that the ability diamond shrank to two slots —
// see the file header), F on keyboard (unchanged). B was the ability diamond's old "shield burst"
// corner; now that only Y/X are mountable abilities, B is free for reload instead.
export const RELOAD_BIND = { key: 'F', pad: 'B' };
const PAD_RELOAD = PAD.B;

// #517: pad A was left explicitly RESERVED "for a generic interact we may need" (see the file
// header) — this is the first concrete use of it. T on keyboard (unused by any existing bind).
// Scene-level, one-shot (ArenaScene's own `keydown-T` + `padEdges.pressed(PAD.A)`, same pattern
// as the G/SELECT return-to-garage bind), not part of the per-frame `read()` intent below — there
// is currently exactly one thing it does (answer the #517 post-clear base-capture choice), so it
// doesn't need a slot in the intent object the way a sustained held action would.
export const INTERACT_BIND = { key: 'T', pad: 'A' };

// The two mountable ability slots, one per gamepad face button, with a keyboard row alongside.
// A is deliberately UNBOUND (reserved, no ability, no other function — see the file header); B
// went to RELOAD_BIND above instead of an ability.
export const ABILITY_BINDS = {
  abilityY: { key: '1', pad: 'Y' },
  abilityX: { key: '4', pad: 'X' },
};
// L3/R3 are alternate bindings for X/Y respectively (quick add, no other function on either).
const ABILITY_PAD_INDEX = { abilityY: [PAD.Y, PAD.R3], abilityX: [PAD.X, PAD.L3] };
const ABILITY_KEY_NAME = { abilityY: 'ONE', abilityX: 'FOUR' };

// #524: the #122 fix below (both here and in Controls' constructor) only un-sticks pads that
// are ALREADY known to this scene's GamepadPlugin at the moment the reset loop runs — the
// SCENE-TRANSITION case, where the pad was already recognized by the browser and just needed
// its fresh per-scene wrapper re-synced. It does NOT cover a pad that connects to the BROWSER
// for the very first time DURING this scene's life: that wrapper is created later, off the
// native 'gamepadconnected' event, with `_created` stamped at essentially the same instant as
// the native state that triggered it — so if the player then holds the stick/button steady
// with no further state change, that wrapper is frozen at all-zero forever, exactly like #122,
// just arriving after construction instead of before it.
//
// This is what actually bit BaseScene (#524): it's the game's entry point (#509) and its whole
// interaction — walking to a trigger hex — needs nothing but the analog stick, no button. A
// browser will not expose an already-OS-connected-but-untouched gamepad via
// `navigator.getGamepads()` until it sees real input on it, so BaseScene is commonly the FIRST
// place all session a live pad is seen at all. A player who starts driving immediately and
// holds one direction the whole walk never generates a second native timestamp, so the
// freshly-connected wrapper never leaves its frozen zero state — the controller reads as dead.
// GarageScene isn't doing anything special: by the time a player reaches it the pad has
// already been recognized (from that very drive), so ITS fresh per-scene wrapper is already
// known at PadEdges/Controls construction time and the existing #122 reset catches it — which
// is why "visiting the garage" appears to wake the controller up.
//
// Fix: also listen for the plugin's own 'connected' event and zero out `_created` on whatever
// pad arrives, so a pad that shows up mid-scene gets the same unconditional-resync treatment as
// one that was already known at construction.
function _unstickLateConnectingPads(scene) {
  scene.input.gamepad?.on?.('connected', (pad) => { pad._created = 0; });
}

// Rising-edge detector for gamepad buttons — call a `pressed(i)` per frame and it returns
// true only on the frame the button goes down. Used for one-shot actions (toggles, scene
// transitions) where the held-flag fire intent isn't appropriate. One instance per scene
// that needs button edges; each button index should be polled at most once per frame.
export class PadEdges {
  // #348: `padIndex` selects which physical pad's edges these are — the arena watches pad 1's
  // START button to know when a second player wants in.
  constructor(scene, padIndex = 0) {
    this.scene = scene;
    this.padIndex = padIndex;
    this.prev = {};
    // #122: same fresh-scene Gamepad-wrapper quirk as Controls (see its constructor comment) —
    // force an immediate resync so a pad already connected/held when this scene starts isn't
    // read as all-zero until its next genuinely new native state-change timestamp.
    for (const pad of scene.input.gamepad?.getAll?.() ?? []) pad._created = 0;
    _unstickLateConnectingPads(scene);   // #524: also catch a pad that connects mid-scene
    // Grace window: even with the resync above, a BRAND NEW scene's own per-scene gamepad
    // wrapper can still read stale/cold for its first frame or two before catching up to the
    // real held-button state — worst right when a scene launches as an overlay on top of one
    // that's pausing in the same beat (PauseMenuScene on Arena/Base/Garage), because the
    // opener's own edge-detector JUST saw the real press-edge that opened it, and this new
    // instance's first read can then see that same physical hold as ANOTHER fresh edge a
    // frame or two later once the wrapper syncs — closing the menu instantly after opening
    // it. `prev` still tracks every poll during the window (so once it ends, a still-held
    // button is already correctly baselined); only the returned edge is held back.
    this._graceUntil = (scene.time?.now ?? 0) + 120;
  }
  pad() {
    const gp = this.scene.input.gamepad;
    const p = gp && gp.total > this.padIndex ? gp.getPad(this.padIndex) : null;
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
    const now = this.scene.time?.now ?? 0;
    const inGrace = now < this._graceUntil;
    const edge = down && !was;
    // TEMP DEBUG (pause-menu flicker investigation) — remove once root-caused.
    if (import.meta.env.DEV && edge) {
      console.log(`[PadEdges] btn ${i} edge — scene=${this.scene.scene?.key} pad=${this.padIndex} t=${now.toFixed(0)} graceUntil=${this._graceUntil.toFixed(0)} suppressed=${inGrace}`);
    }
    if (inGrace) return false;
    return edge;
  }
}

export class Controls {
  // #348 (local co-op): one Controls per PLAYER, not one per scene.
  //   `padIndex`  — which physical gamepad this player reads. Player 1 is pad 0, player 2 pad 1.
  //   `keyboard`  — whether this player also owns the keyboard + mouse.
  //
  // How the mixed case resolves, which is the part that was NOT obvious (and which Jackson has
  // not been asked about — see the report): only ONE player can own the keyboard+mouse, and it
  // is always player 1. So the arrangements are: one pad + kbm (P1 latches between its pad and
  // kbm exactly as it always has, P2 is pad-only), or two pads (same thing, P1 simply never
  // touches the keyboard). Player 2 is deliberately never keyboard-capable — sharing one
  // keyboard between two drivers needs a whole second bind table, and picking one unasked
  // would be a real design decision rather than a conservative default. Gamepad-only for the
  // joiner is the reversible choice: adding a keyboard scheme later is additive.
  //
  // Defaults reproduce the single-player instance exactly (pad 0 + keyboard), so every existing
  // caller and test is unchanged.
  constructor(scene, { padIndex = 0, keyboard = true } = {}) {
    this.scene = scene;
    this.padIndex = padIndex;
    this.hasKeyboard = keyboard;
    this.keys = scene.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,Q,E,F,ONE,FOUR');
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
    // #524: the loop above only catches pads already known at construction time — see
    // _unstickLateConnectingPads' comment for the mid-scene-first-connection case it misses
    // (the actual BaseScene bug: the game's stick-only entry point is often the first place a
    // pad is EVER seen this session, so its wrapper is frequently created well after this
    // constructor already ran).
    _unstickLateConnectingPads(scene);

    // Active input scheme. We latch onto whichever device was used last: once a pad is
    // touched we stay in 'pad' mode (ignoring the mouse, holding the last aim when the
    // right stick is centred) until the mouse/keyboard is used again, and vice-versa.
    // #348: a pad-only player (player 2) starts and stays in 'pad' — there is no kbm to fall
    // back to, and latching it to 'kbm' would aim its turret at player 1's mouse.
    this.mode = keyboard ? 'kbm' : 'pad';
    this.aimAngle = -Math.PI / 2;  // remembered turret aim, so a centred stick holds it
    this._px = 0; this._py = 0;    // last pointer position, to detect real mouse movement
    this._padReloadDown = false;   // previous frame's raw B state, for edge-detecting reload
    this._kbReloadDown = false;    // previous frame's raw F state, for edge-detecting reload
    // #506: previous frame's raw per-slot ability button state, one pair per device, for
    // edge-detecting each ability's press exactly like dash/reload above.
    this._padAbilityDown = {}; this._kbAbilityDown = {};
    for (const slot of ABILITY_SLOTS) { this._padAbilityDown[slot] = false; this._kbAbilityDown[slot] = false; }

    // #346: on-screen sticks. Only wired up when the device can actually produce touches;
    // even then, `mode` doesn't become 'touch' until a real touch pointer arrives, so a
    // touchscreen laptop driven by mouse+keyboard behaves exactly as it always has.
    // #348: on-screen sticks are a SINGLE-touchscreen affordance — there is one screen, so only
    // the keyboard-owning player (player 1) can have them. A second pad-only player never gets
    // touch sticks, which would otherwise both grab the same thumbs.
    this.touch = null;
    if (keyboard && Controls.touchCapable()) this._initTouch();
  }

  // Capability probe only — NOT "is the player using touch". Guarded so the module still
  // imports cleanly under Node/vitest, where there is no window.
  // #386: touch sticks are DISABLED behind this one flag. They hijacked input on iPad even
  // with a Bluetooth controller attached, and the owner concluded touch controls aren't
  // viable for this game. Flip TOUCH_STICKS_ENABLED back to true to restore them — the whole
  // implementation (touchSticks.js, TouchStickHud.js, the wiring below) is intact.
  static touchCapable() {
    if (!TOUCH_STICKS_ENABLED) return false;
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

  // #348: THIS player's pad, by index — player 1 reads pad 0, player 2 pad 1.
  pad() {
    const gp = this.scene.input.gamepad;
    const p = gp && gp.total > this.padIndex ? gp.getPad(this.padIndex) : null;
    return p && p.connected ? p : null;
  }

  // Read the current frame's intent. `move` is a world-space vector (magnitude <= 1);
  // `fire` is keyed by location; `mode` is the active input scheme ('kbm' | 'pad').
  read() {
    const k = this.keys;
    const p = this.scene.input.activePointer;
    const pad = this.pad();
    const ls = pad?.leftStick, rs = pad?.rightStick;
    // #565: the aim stick's deadzone is rescaled (not just gated) so fine aiming near the edge
    // ramps in smoothly instead of popping straight to the raw value.
    const rsDz = rs ? applyStickDeadzone(rs.x, rs.y, STICK_DEADZONE) : null;

    // ── Decide which scheme is active (last device used wins) ──
    const padMove = !!(ls && ls.length() > STICK_DEADZONE);
    const padAim = !!(rsDz && rsDz.mag > 0);
    const padBtn = !!(pad && pad.buttons.some((b) => b && b.pressed));
    const padActive = padMove || padAim || padBtn;

    // #346: a touch drag moves `activePointer` too, so mouse activity must exclude
    // touch-driven pointers or every touch would immediately yank the mode back to 'kbm'.
    // `wasTouch` is false for a real mouse, so this is a no-op on desktop.
    const pointerIsTouch = p.wasTouch === true;
    const mouseMoved = (p.x !== this._px || p.y !== this._py) && !pointerIsTouch;
    this._px = p.x; this._py = p.y;
    const kbDown = ['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'Q', 'E', 'F', 'ONE', 'FOUR']
      .some((key) => k[key].isDown);
    const mouseBtn = !pointerIsTouch && (p.leftButtonDown() || p.rightButtonDown());
    // #348: a pad-only player ignores the keyboard/mouse entirely — those belong to player 1.
    const kbmActive = this.hasKeyboard && (mouseMoved || mouseBtn || kbDown);

    // TEMP DEBUG (pause-menu flicker investigation) — remove once root-caused.
    if (import.meta.env.DEV && this.mode !== (padActive ? 'pad' : (kbmActive ? 'kbm' : this.mode))) {
      console.log(`[Controls] mode ${this.mode} -> ${padActive ? 'pad' : 'kbm'} — scene=${this.scene.scene?.key} t=${this.scene.time?.now?.toFixed?.(0)}`);
    }
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
        ability: this._noAbilityPressed(),
        reloadPressed: false,   // #402: touch reports no reload, same as no fire/dash/ability
        movementTogglePressed: false, // #501: pad-only toggle, nothing to report on touch
      };
    }

    // #348: a pad-only player (player 2) whose pad has gone away has no fallback device — the
    // keyboard belongs to player 1, so falling through to the kbm path below would have BOTH
    // mechs driven by the same WASD/mouse. Report a neutral intent instead: the mech just
    // stands still until the pad comes back, holding its last aim.
    if (!this.hasKeyboard && !pad) {
      return {
        move: { x: 0, y: 0 },
        aim: { mode: 'angle', angle: this.aimAngle },
        fire: { rightArm: false, leftArm: false, rightTorso: false, leftTorso: false },
        mode: 'pad',
        ability: this._noAbilityPressed(),
        reloadPressed: false,   // #402: no pad, no reload edge to report
        movementTogglePressed: false, // #501: no pad, no toggle edge to report
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
      if (padAim) this.aimAngle = Math.atan2(rsDz.y, rsDz.x);
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

    // Manual reload (B / F) — edge-detected on each device independently every frame
    // (regardless of which scheme is currently active, so a mode switch mid-press can't leave a
    // stale edge from the previously-active device), then only the currently-active scheme's
    // edge is reported.
    const padReloadDown = !!(pad && pad.buttons[PAD_RELOAD] && pad.buttons[PAD_RELOAD].pressed);
    const padReloadPressed = padReloadDown && !this._padReloadDown;
    this._padReloadDown = padReloadDown;
    const kbReloadDown = k.F.isDown;
    const kbReloadPressed = kbReloadDown && !this._kbReloadDown;
    this._kbReloadDown = kbReloadDown;
    const reloadPressed = padMode ? padReloadPressed : kbReloadPressed;

    // The two ability slots — same press-to-trigger edge-detection pattern as reload above, one
    // independent tracker per slot per device.
    const ability = {};
    for (const slot of ABILITY_SLOTS) {
      const padDown = !!(pad && ABILITY_PAD_INDEX[slot].some((i) => pad.buttons[i]?.pressed));
      const padPressed = padDown && !this._padAbilityDown[slot];
      this._padAbilityDown[slot] = padDown;
      const kbDown = k[ABILITY_KEY_NAME[slot]].isDown;
      const kbPressed = kbDown && !this._kbAbilityDown[slot];
      this._kbAbilityDown[slot] = kbDown;
      ability[slot] = padMode ? padPressed : kbPressed;
    }

    // #556: the D-pad-down live-toggle shortcut was removed — the pause-menu "MOVEMENT FEEL"
    // row (PauseMenuScene.js, calling `applyMovementToggle` directly) is now the only way to
    // change movement feel, so there's no per-frame pad edge to report here.
    return { move, aim, fire, mode: padMode ? 'pad' : 'kbm', ability, reloadPressed, movementTogglePressed: false };
  }

  // A neutral "nothing pressed" ability map, for the early-return branches (touch, pad-only
  // with no pad connected) where there's no real input to read.
  _noAbilityPressed() {
    const out = {};
    for (const slot of ABILITY_SLOTS) out[slot] = false;
    return out;
  }
}
