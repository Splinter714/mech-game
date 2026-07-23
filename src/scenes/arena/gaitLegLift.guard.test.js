// #479: pins that the leg-MOVEMENT (lift) cue is fired from locomotion's gait loop at the OPPOSITE
// stride phase from the foot-plant. `_stepGait` is a Phaser scene mixin (needs a live ArenaScene
// with textures/tweens/a player view) so a behavioural unit test would stand up most of a scene —
// this repo reserves that for the Playwright smoke test (see CLAUDE.md). A source-text assertion
// (same technique as sfxCallSites.guard.test.js / architecture.guard.test.js) is the practical way
// to lock the wiring: the footfall fires at the phase 0/0.5 plant, and the leg-lift fires on a
// SEPARATE beat that flips at phase 0.25 and 0.75 — the peak-swing crossings where the legs are
// maximally split and the body bob is highest (the visible leg pickup).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const locomotion = readFileSync(join(DIR, 'locomotion.js'), 'utf8');

describe('#479 leg-lift gait wiring', () => {
  it('still fires the footstep on the plant beat (phase < 0.5)', () => {
    expect(locomotion).toMatch(/const beat = phase < 0\.5 \? 0 : 1;/);
    expect(locomotion).toMatch(/Audio\.footstep\(beat\)/);
  });

  it('#485 fires Audio.legLift on a SWUNG beat offset shortly before each plant', () => {
    // The lift beat spans [0.5 − GAIT_SWING_OFFSET, 1.0 − GAIT_SWING_OFFSET) — its two transitions
    // land just before the phase 0.5/1.0 plants (~0.34/~0.84), so the rhythm reads lift-plant…space
    // rather than the old even 0.25/0.75 spacing. The offset is a named, tunable constant.
    expect(locomotion).toMatch(/const GAIT_SWING_OFFSET = 0\.16;/);
    expect(locomotion).toMatch(/liftBeat = \(phase >= 0\.5 - GAIT_SWING_OFFSET && phase < 1\.0 - GAIT_SWING_OFFSET\) \? 1 : 0/);
    expect(locomotion).toMatch(/Audio\.legLift\(liftBeat\)/);
  });

  it('arms the lift beat without firing on the first frame (no lift cue at the phase-0 start)', () => {
    // Unlike the footfall (which fires immediately when _gaitBeat is undefined), the lift guards on
    // a defined previous beat, so the restart frame only arms it — the first lift comes at ~0.34.
    expect(locomotion).toMatch(/p\._gaitLiftBeat !== undefined && liftBeat !== p\._gaitLiftBeat/);
  });

  it('re-arms the lift beat when the mech stops, alongside the footfall beat', () => {
    expect(locomotion).toMatch(/p\._gaitLiftBeat = undefined;/);
  });

  it('fires footstep and legLift on SEPARATE beats (they alternate, never together)', () => {
    // Two distinct beat trackers — _gaitBeat (plant) and _gaitLiftBeat (lift) — so a single frame
    // never triggers both cues at the same phase.
    expect(locomotion).toMatch(/p\._gaitBeat/);
    expect(locomotion).toMatch(/p\._gaitLiftBeat/);
  });
});
