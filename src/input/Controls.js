import Phaser from 'phaser';

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
//   centre torso L3 / Space              head         R3 / F

const STICK_DEADZONE = 0.25;
const TRIGGER_THRESHOLD = 0.3;
// Standard-gamepad button indices for the stick clicks (Phaser has no named L3/R3).
const PAD_L3 = 10, PAD_R3 = 11;

// location → { key (keyboard/mouse label), pad (controller label) }. Order here is the
// display order used by the garage/HUD.
export const SKILL_BINDS = {
  rightArm:    { key: 'RMB',   pad: 'RT' },
  leftArm:     { key: 'LMB',   pad: 'LT' },
  rightTorso:  { key: 'E',     pad: 'RB' },
  leftTorso:   { key: 'Q',     pad: 'LB' },
  centerTorso: { key: 'Space', pad: 'L3' },
  head:        { key: 'F',     pad: 'R3' },
};

export class Controls {
  constructor(scene) {
    this.scene = scene;
    this.keys = scene.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,Q,E,F,SPACE');
    scene.input.mouse?.disableContextMenu(); // so right-click fires instead of opening a menu

    // Active input scheme. We latch onto whichever device was used last: once a pad is
    // touched we stay in 'pad' mode (ignoring the mouse, holding the last aim when the
    // right stick is centred) until the mouse/keyboard is used again, and vice-versa.
    this.mode = 'kbm';
    this.aimAngle = -Math.PI / 2;  // remembered turret aim, so a centred stick holds it
    this._px = 0; this._py = 0;    // last pointer position, to detect real mouse movement
  }

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

    const mouseMoved = p.x !== this._px || p.y !== this._py;
    this._px = p.x; this._py = p.y;
    const kbDown = ['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'Q', 'E', 'F', 'SPACE']
      .some((key) => k[key].isDown);
    const kbmActive = mouseMoved || p.leftButtonDown() || p.rightButtonDown() || kbDown;

    if (padActive) this.mode = 'pad';
    else if (kbmActive) this.mode = 'kbm';
    // else: no input this frame — stay in the current mode (don't fall back to mouse).

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
      const btn = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      fire = {
        rightArm:    pad.R2 > TRIGGER_THRESHOLD,
        leftArm:     pad.L2 > TRIGGER_THRESHOLD,
        rightTorso:  pad.R1,
        leftTorso:   pad.L1,
        centerTorso: btn(PAD_L3),
        head:        btn(PAD_R3),
      };
    } else {
      fire = {
        rightArm:    p.rightButtonDown(),
        leftArm:     p.leftButtonDown(),
        rightTorso:  k.E.isDown,
        leftTorso:   k.Q.isDown,
        centerTorso: k.SPACE.isDown,
        head:        k.F.isDown,
      };
    }

    return { move, aim, fire, mode: padMode ? 'pad' : 'kbm' };
  }
}
