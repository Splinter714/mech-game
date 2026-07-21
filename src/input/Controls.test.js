import { describe, it, expect } from 'vitest';
import { Controls, PadEdges, PAD } from './Controls.js';

function setKey(scene, name, isDown) {
  scene._keys[name].isDown = isDown;
}

// Minimal fake scene: just enough for PadEdges.pad() to resolve a connected gamepad
// with a mutable `buttons` array we can flip between polls.
function fakeScene(buttons = {}) {
  const pad = {
    connected: true,
    buttons: [],
  };
  for (const [i, pressed] of Object.entries(buttons)) {
    pad.buttons[i] = { pressed };
  }
  return {
    input: {
      gamepad: {
        total: 1,
        getPad: () => pad,
        getAll: () => [pad],
      },
    },
    _pad: pad,
  };
}

function setButton(scene, i, pressed) {
  scene._pad.buttons[i] = { pressed };
}

// Minimal fake scene for Controls: enough keyboard/mouse/gamepad surface for its
// constructor + read() to run without a real Phaser instance.
function fakeControlsScene({ pads = [] } = {}) {
  const keys = {};
  for (const k of ['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'Q', 'E', 'F', 'SPACE']) {
    keys[k] = { isDown: false };
  }
  const pointer = { x: 0, y: 0, worldX: 0, worldY: 0, wasTouch: false, leftButtonDown: () => false, rightButtonDown: () => false };
  const handlers = {};
  return {
    input: {
      keyboard: { addKeys: () => keys, on: () => {} },
      mouse: { disableContextMenu: () => {} },
      activePointer: pointer,
      addPointer: () => {},
      on: (evt, fn) => { (handlers[evt] ||= []).push(fn); },
      gamepad: {
        total: pads.length,
        getPad: (i) => pads[i] ?? null,
        getAll: () => pads,
      },
    },
    cameras: { main: { width: 800, height: 400 } },
    events: { once: () => {} },
    _keys: keys,
    _pointer: pointer,
    _emit: (evt, p) => { for (const fn of handlers[evt] ?? []) fn(p); },
  };
}

describe('PadEdges.pressed — first-poll baseline (issue #79)', () => {
  it('does not fire a press when the button is already held on the very first poll', () => {
    const scene = fakeScene({ [PAD.SELECT]: true });
    const edges = new PadEdges(scene);
    expect(edges.pressed(PAD.SELECT)).toBe(false);
  });

  it('does not re-fire on a later poll while the button stays held', () => {
    const scene = fakeScene({ [PAD.SELECT]: true });
    const edges = new PadEdges(scene);
    expect(edges.pressed(PAD.SELECT)).toBe(false); // first poll: baseline seeded
    expect(edges.pressed(PAD.SELECT)).toBe(false); // still held, no retrigger
    expect(edges.pressed(PAD.SELECT)).toBe(false);
  });

  it('fires exactly once on the real up-to-down transition when not held on first poll', () => {
    const scene = fakeScene({ [PAD.SELECT]: false });
    const edges = new PadEdges(scene);
    expect(edges.pressed(PAD.SELECT)).toBe(false); // first poll: up, baseline = false
    expect(edges.pressed(PAD.SELECT)).toBe(false); // still up

    setButton(scene, PAD.SELECT, true);
    expect(edges.pressed(PAD.SELECT)).toBe(true);  // real rising edge

    expect(edges.pressed(PAD.SELECT)).toBe(false); // held, no repeat
  });

  it('fires once per press across release/re-press after baseline is established', () => {
    const scene = fakeScene({ [PAD.SELECT]: false });
    const edges = new PadEdges(scene);
    expect(edges.pressed(PAD.SELECT)).toBe(false); // baseline: up

    setButton(scene, PAD.SELECT, true);
    expect(edges.pressed(PAD.SELECT)).toBe(true);  // press 1
    expect(edges.pressed(PAD.SELECT)).toBe(false); // still held

    setButton(scene, PAD.SELECT, false);
    expect(edges.pressed(PAD.SELECT)).toBe(false); // released

    setButton(scene, PAD.SELECT, true);
    expect(edges.pressed(PAD.SELECT)).toBe(true);  // press 2
    expect(edges.pressed(PAD.SELECT)).toBe(false); // still held
  });

  it('tracks each button index independently', () => {
    const scene = fakeScene({ [PAD.SELECT]: true, [PAD.A]: false });
    const edges = new PadEdges(scene);
    expect(edges.pressed(PAD.SELECT)).toBe(false); // already held, no false-fresh-press
    expect(edges.pressed(PAD.A)).toBe(false);       // not held yet

    setButton(scene, PAD.A, true);
    expect(edges.pressed(PAD.A)).toBe(true);        // real edge on a different index
    expect(edges.pressed(PAD.SELECT)).toBe(false);  // SELECT still just held, untouched
  });
});

// #122: Garage → Arena (each a fresh Phaser Scene, hence a fresh GamepadPlugin) wraps an
// already-connected, already-in-use pad in a brand-new `Gamepad` instance whose private
// `_created` timestamp is the transition instant. Phaser's `Gamepad.update()` silently drops
// button/axis sync whenever the native pad's `timestamp` is older than that cutoff — which is
// exactly what happens if the player is holding the stick/a button steady right through the
// transition (a real controller's timestamp only advances on an actual state change). Controls
// and PadEdges both force every already-known pad's `_created` back to 0 on construction so the
// very next poll re-syncs unconditionally instead of waiting for a fresh physical edge.
describe('Controls / PadEdges — resync a carried-over pad on scene transition (issue #122)', () => {
  it('Controls resets _created on every pad already known to this scene\'s GamepadPlugin', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 }, _created: performance.now() + 10000 };
    const scene = fakeControlsScene({ pads: [pad] });
    new Controls(scene);
    expect(pad._created).toBe(0);
  });

  it('PadEdges resets _created on every pad already known to this scene\'s GamepadPlugin', () => {
    const pad = { connected: true, buttons: [], _created: performance.now() + 10000 };
    const scene = fakeControlsScene({ pads: [pad] });
    new PadEdges(scene);
    expect(pad._created).toBe(0);
  });

  it('does not throw when the scene has no gamepad plugin or no pads connected', () => {
    const scene = fakeControlsScene({ pads: [] });
    expect(() => new Controls(scene)).not.toThrow();
    expect(() => new PadEdges(scene)).not.toThrow();
  });
});

// #261: Dash replaced player-facing Sprint — both devices now report the SAME press-to-trigger
// semantics via a single `dashPressed` rising-edge one-shot, picked from whichever device is
// currently the active scheme (unlike #188's old device split, sprintHeld vs. sprintPressed).
describe('Controls.read — dash intent, press-to-trigger on both devices (#261)', () => {
  it('dashPressed is a rising-edge one-shot on keyboard Space (kbm mode)', () => {
    const scene = fakeControlsScene();
    const controls = new Controls(scene);

    expect(controls.read().dashPressed).toBe(false);
    setKey(scene, 'SPACE', true);
    expect(controls.read().dashPressed).toBe(true);    // fresh press
    expect(controls.read().dashPressed).toBe(false);   // still held, no repeat
    setKey(scene, 'SPACE', false);
    expect(controls.read().dashPressed).toBe(false);   // released
    setKey(scene, 'SPACE', true);
    expect(controls.read().dashPressed).toBe(true);    // press again
  });

  it('dashPressed is a rising-edge one-shot on gamepad L3 (pad mode)', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);

    pad.buttons[PAD.L3] = { pressed: true };
    expect(controls.read().dashPressed).toBe(true);    // fresh press (also switches mode to pad)
    expect(controls.read().dashPressed).toBe(false);   // still held, no repeat
    pad.buttons[PAD.L3] = { pressed: false };
    expect(controls.read().dashPressed).toBe(false);   // released
    pad.buttons[PAD.L3] = { pressed: true };
    expect(controls.read().dashPressed).toBe(true);    // press again
  });

  it('only reports the edge from the currently-active device, even if the other device also has a fresh press the same frame', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);
    // Establish kbm as the active scheme first (no pad input yet).
    expect(controls.read().mode).toBe('kbm');

    setKey(scene, 'SPACE', true);            // fresh press on the ACTIVE device (kbm)...
    pad.buttons[PAD.L3] = { pressed: true };  // ...and a fresh pad press too, same frame — but
                                               // that pad press also switches mode to 'pad'.
    const intent = controls.read();
    expect(intent.mode).toBe('pad');          // pad activity wins mode arbitration this frame
    expect(intent.dashPressed).toBe(true);    // reports the PAD edge, since pad is now active
  });

  it('a mode switch mid-press does not leave a stale edge from the previously-active device', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);

    setKey(scene, 'SPACE', true);
    expect(controls.read().dashPressed).toBe(true);   // kbm edge fires
    expect(controls.read().dashPressed).toBe(false);  // still held, no repeat

    // Switch to pad by moving the stick (not the dash button) — kbm's Space is still held.
    pad.leftStick = { x: 1, y: 0, length: () => 1 };
    expect(controls.read().mode).toBe('pad');
    // Pad's L3 was never pressed, so no dash edge leaks through from the stale kbm hold.
    expect(controls.read().dashPressed).toBe(false);
  });
});

// #402: manual reload — the same rising-edge one-shot as the dash above, on R3 / F.
describe('Controls.read — reload intent, press-to-trigger on both devices (#402)', () => {
  it('reloadPressed is a rising-edge one-shot on keyboard F (kbm mode)', () => {
    const scene = fakeControlsScene();
    const controls = new Controls(scene);

    expect(controls.read().reloadPressed).toBe(false);
    setKey(scene, 'F', true);
    expect(controls.read().reloadPressed).toBe(true);    // fresh press
    expect(controls.read().reloadPressed).toBe(false);   // still held, no repeat
    setKey(scene, 'F', false);
    expect(controls.read().reloadPressed).toBe(false);   // released
    setKey(scene, 'F', true);
    expect(controls.read().reloadPressed).toBe(true);    // press again
  });

  it('reloadPressed is a rising-edge one-shot on gamepad R3 (pad mode)', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);

    pad.buttons[PAD.R3] = { pressed: true };
    expect(controls.read().reloadPressed).toBe(true);    // fresh press (also switches mode to pad)
    expect(controls.read().reloadPressed).toBe(false);   // still held, no repeat
    pad.buttons[PAD.R3] = { pressed: false };
    expect(controls.read().reloadPressed).toBe(false);   // released
    pad.buttons[PAD.R3] = { pressed: true };
    expect(controls.read().reloadPressed).toBe(true);    // press again
  });
});

// #346: touch is a third source feeding the same intent. These tests drive Controls'
// pointer handlers directly (the capability probe is stubbed, since vitest runs in Node
// where there is no window) and — just as importantly — pin down that the desktop paths
// are unchanged.
function touchPointer(id, x, y) {
  return { id, x, y, wasTouch: true };
}

function touchControls() {
  const scene = fakeControlsScene();
  const controls = new Controls(scene);
  controls._initTouch();   // force the touch wiring on, bypassing the capability probe
  return { scene, controls };
}

describe('Controls — touch sticks feed the same intent (#346)', () => {
  it('does not wire touch up at all in a non-touch environment', () => {
    const controls = new Controls(fakeControlsScene());
    expect(controls.touch).toBeNull();
    expect(Controls.touchCapable()).toBe(false);
  });

  // #386: the TOUCH_STICKS_ENABLED gate is OFF, so even on a genuine touch device the
  // capability probe reports false and no touch is wired — the sticks no longer hijack
  // input away from a Bluetooth controller on iPad. (Emulate a touch device by stubbing
  // the globals touchCapable() reads.)
  it('the #386 gate suppresses touch even on a touch-capable device', () => {
    const savedWindow = globalThis.window;
    const savedNav = globalThis.navigator;
    try {
      globalThis.window = { ontouchstart: null };
      globalThis.navigator = { maxTouchPoints: 5 };
      // Without the gate this would be true; with TOUCH_STICKS_ENABLED = false it stays false.
      expect(Controls.touchCapable()).toBe(false);
      const controls = new Controls(fakeControlsScene());
      expect(controls.touch).toBeNull();   // no TouchSticks, so ArenaScene builds no TouchStickHud
    } finally {
      if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
      if (savedNav === undefined) delete globalThis.navigator; else globalThis.navigator = savedNav;
    }
  });

  it('stays in kbm mode until a genuine touch pointer arrives', () => {
    const { scene, controls } = touchControls();
    expect(controls.read().mode).toBe('kbm');
    scene._emit('pointerdown', { id: 1, x: 100, y: 200, wasTouch: false }); // a mouse click
    expect(controls.read().mode).toBe('kbm');
    expect(controls.touch.used).toBe(false);
  });

  it('latches touch mode on a real touch and drives from the left-half stick', () => {
    const { scene, controls } = touchControls();
    scene._emit('pointerdown', touchPointer(1, 100, 200));
    scene._emit('pointermove', touchPointer(1, 100, 200 + 90));  // full deflection down
    const intent = controls.read();
    expect(intent.mode).toBe('touch');
    expect(intent.move.y).toBeCloseTo(1, 5);
    expect(intent.move.x).toBeCloseTo(0, 5);
  });

  it('aims by angle from the right-half stick and holds it after release', () => {
    const { scene, controls } = touchControls();
    scene._emit('pointerdown', touchPointer(2, 600, 200));
    scene._emit('pointermove', touchPointer(2, 600 + 90, 200));
    expect(controls.read().aim).toEqual({ mode: 'angle', angle: expect.closeTo(0, 5) });
    scene._emit('pointerup', touchPointer(2, 690, 200));
    expect(controls.read().aim.angle).toBeCloseTo(0, 5);   // held, not snapped back
  });

  it('reports no fire and no dash — triggers are out of scope (#346)', () => {
    const { scene, controls } = touchControls();
    scene._emit('pointerdown', touchPointer(1, 100, 200));
    const intent = controls.read();
    expect(intent.fire).toEqual({ rightArm: false, leftArm: false, rightTorso: false, leftTorso: false });
    expect(intent.dashPressed).toBe(false);
  });

  it('a touch drag is not mistaken for mouse movement (mode does not flip back to kbm)', () => {
    const { scene, controls } = touchControls();
    scene._emit('pointerdown', touchPointer(1, 100, 200));
    expect(controls.read().mode).toBe('touch');
    // The touch also drags Phaser's activePointer around, flagged as a touch.
    scene._pointer.wasTouch = true;
    scene._pointer.x = 140; scene._pointer.y = 260;
    expect(controls.read().mode).toBe('touch');
  });

  it('real mouse movement still takes the mode back from touch', () => {
    const { scene, controls } = touchControls();
    scene._emit('pointerdown', touchPointer(1, 100, 200));
    expect(controls.read().mode).toBe('touch');
    scene._pointer.wasTouch = false;
    scene._pointer.x = 400; scene._pointer.y = 400;
    expect(controls.read().mode).toBe('kbm');
  });

  it('a gamepad still takes the mode back from touch', () => {
    const scene = fakeControlsScene({ pads: [] });
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    scene.input.gamepad.total = 1;
    scene.input.gamepad.getPad = () => pad;
    const controls = new Controls(scene);
    controls._initTouch();
    scene._emit('pointerdown', touchPointer(1, 100, 200));
    expect(controls.read().mode).toBe('touch');
    pad.leftStick = { x: 1, y: 0, length: () => 1 };
    expect(controls.read().mode).toBe('pad');
  });
});

describe('Controls — desktop input is unchanged by #346', () => {
  it('mouse aim is still a world-space pointer aim', () => {
    const scene = fakeControlsScene();
    scene._pointer.worldX = 42; scene._pointer.worldY = -7;
    const intent = new Controls(scene).read();
    expect(intent.mode).toBe('kbm');
    expect(intent.aim).toEqual({ mode: 'pointer', x: 42, y: -7 });
  });

  it('WASD still produces the same normalised move vector', () => {
    const scene = fakeControlsScene();
    const controls = new Controls(scene);
    setKey(scene, 'D', true);
    expect(controls.read().move).toEqual({ x: 1, y: 0 });
    setKey(scene, 'W', true);
    const diag = controls.read().move;
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1, 6);
  });

  it('mouse buttons and Q/E still map to the four fire slots', () => {
    const scene = fakeControlsScene();
    const controls = new Controls(scene);
    scene._pointer.leftButtonDown = () => true;
    setKey(scene, 'E', true);
    const fire = controls.read().fire;
    expect(fire).toEqual({ rightArm: false, leftArm: true, rightTorso: true, leftTorso: false });
  });

  it('mouse movement still switches the active scheme back from pad', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 1, y: 0, length: () => 1 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);
    expect(controls.read().mode).toBe('pad');
    pad.leftStick = { x: 0, y: 0, length: () => 0 };
    scene._pointer.x = 10; scene._pointer.y = 10;
    expect(controls.read().mode).toBe('kbm');
  });
});
