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
  const pointer = { x: 0, y: 0, worldX: 0, worldY: 0, leftButtonDown: () => false, rightButtonDown: () => false };
  return {
    input: {
      keyboard: { addKeys: () => keys, on: () => {} },
      mouse: { disableContextMenu: () => {} },
      activePointer: pointer,
      gamepad: {
        total: pads.length,
        getPad: (i) => pads[i] ?? null,
        getAll: () => pads,
      },
    },
    _keys: keys,
    _pointer: pointer,
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

// #188 device split: keyboard Space reports a raw HOLD state (`sprintHeld`), gamepad L3
// still reports a rising-edge TOGGLE one-shot (`sprintPressed`) — both present every frame,
// regardless of which scheme is currently active, so the arena's `_handleSprint` can pick
// the one matching `intent.mode`.
describe('Controls.read — sprint intent split by device (#188)', () => {
  it('sprintHeld tracks the raw Space key state every frame, with no edge-detection', () => {
    const scene = fakeControlsScene();
    const controls = new Controls(scene);

    expect(controls.read().sprintHeld).toBe(false);
    setKey(scene, 'SPACE', true);
    expect(controls.read().sprintHeld).toBe(true);
    expect(controls.read().sprintHeld).toBe(true);   // still held: stays true, not a one-shot
    expect(controls.read().sprintHeld).toBe(true);
    setKey(scene, 'SPACE', false);
    expect(controls.read().sprintHeld).toBe(false);
  });

  it('sprintPressed is a rising-edge one-shot on gamepad L3, unaffected by Space', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);

    pad.buttons[PAD.L3] = { pressed: true };
    expect(controls.read().sprintPressed).toBe(true);   // fresh press
    expect(controls.read().sprintPressed).toBe(false);  // still held, no repeat
    pad.buttons[PAD.L3] = { pressed: false };
    expect(controls.read().sprintPressed).toBe(false);  // released
    pad.buttons[PAD.L3] = { pressed: true };
    expect(controls.read().sprintPressed).toBe(true);   // press again
  });

  it('reports both signals in the same read() regardless of which device is active', () => {
    const pad = { connected: true, buttons: [], leftStick: { x: 0, y: 0, length: () => 0 }, rightStick: { x: 0, y: 0, length: () => 0 } };
    const scene = fakeControlsScene({ pads: [pad] });
    const controls = new Controls(scene);

    setKey(scene, 'SPACE', true);          // keyboard held...
    pad.buttons[PAD.L3] = { pressed: true }; // ...and a fresh pad press, same frame
    const intent = controls.read();
    expect(intent.sprintHeld).toBe(true);
    expect(intent.sprintPressed).toBe(true);
  });
});
