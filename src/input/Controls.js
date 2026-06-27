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
  }

  pad() {
    const gp = this.scene.input.gamepad;
    const p = gp && gp.total ? gp.getPad(0) : null;
    return p && p.connected ? p : null;
  }

  // Read the current frame's intent. `move` is a world-space vector (magnitude <= 1);
  // `fire` is keyed by location.
  read() {
    const k = this.keys;
    const p = this.scene.input.activePointer;

    // World-space movement: x right, y down (matches screen/world axes). W = up = -y.
    let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);

    // Aim: default to the mouse pointer (absolute world point).
    let aim = { mode: 'pointer', x: p.worldX, y: p.worldY };

    const fire = {
      rightArm:    p.rightButtonDown(),
      leftArm:     p.leftButtonDown(),
      rightTorso:  k.E.isDown,
      leftTorso:   k.Q.isDown,
      centerTorso: k.SPACE.isDown,
      head:        k.F.isDown,
    };

    // Gamepad augments/overrides when one is connected and active.
    const pad = this.pad();
    if (pad) {
      const ls = pad.leftStick, rs = pad.rightStick;
      if (ls.length() > STICK_DEADZONE) { mx = ls.x; my = ls.y; }
      if (rs.length() > STICK_DEADZONE) {
        aim = { mode: 'stick', angle: Math.atan2(rs.y, rs.x) };
      }
      const btn = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      fire.rightArm    = fire.rightArm    || pad.R2 > TRIGGER_THRESHOLD;
      fire.leftArm     = fire.leftArm     || pad.L2 > TRIGGER_THRESHOLD;
      fire.rightTorso  = fire.rightTorso  || pad.R1;
      fire.leftTorso   = fire.leftTorso   || pad.L1;
      fire.centerTorso = fire.centerTorso || btn(PAD_L3);
      fire.head        = fire.head        || btn(PAD_R3);
    }

    // Clamp the move vector to unit length so diagonals aren't faster.
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    return { move: { x: mx, y: my }, aim, fire };
  }
}
