import { describe, it, expect } from 'vitest';
import { PadEdges, PAD } from './Controls.js';

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
      },
    },
    _pad: pad,
  };
}

function setButton(scene, i, pressed) {
  scene._pad.buttons[i] = { pressed };
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
