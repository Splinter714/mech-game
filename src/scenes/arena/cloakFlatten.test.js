// #500 (fifth pass) — pure-logic coverage for cloakFlatten.js. The RenderTexture compositing
// itself has no meaningful vitest surface (no real Phaser/canvas in this suite's plain-node
// environment — mirrors the existing note in abilities.js's own test file about
// `desaturateTexture` degrading to a safe no-op against a Phaser-free fake scene), so this
// exercises only the two exported PURE functions: the flatten canvas's sizing math, and which of
// a mech view's children get drawn into a given frame's bake. `CloakFlattenMixin`'s actual
// `_updateCloakFlatten`/`_flattenCloakedView`/`_teardownCloakFlatten` methods call real Phaser
// APIs (`this.add.renderTexture`, `RenderTexture#draw/#clear`) end to end and are verified live.
import { describe, it, expect } from 'vitest';
import { flattenCanvasSize, cloakFlattenTargets } from './cloakFlatten.js';
import { DESIGN, ART_SCALE } from '../../art/mechArt.js';
import { ARENA_MECH_SCALE } from './shared.js';

describe('flattenCanvasSize', () => {
  it('is comfortably bigger than a single part\'s own on-screen footprint', () => {
    const partPx = DESIGN * ART_SCALE * ARENA_MECH_SCALE;
    const size = flattenCanvasSize(DESIGN, ART_SCALE, ARENA_MECH_SCALE);
    expect(size).toBeGreaterThan(partPx);
  });

  it('scales linearly with the margin multiplier (within a rounding px of Math.ceil)', () => {
    const size1x = flattenCanvasSize(64, 4, 0.34, 1);
    const size2x = flattenCanvasSize(64, 4, 0.34, 2);
    expect(Math.abs(size2x - size1x * 2)).toBeLessThanOrEqual(1);
  });

  it('is a whole number of pixels (safe to hand straight to a canvas constructor)', () => {
    expect(Number.isInteger(flattenCanvasSize(64, 4, 0.34))).toBe(true);
  });
});

describe('cloakFlattenTargets', () => {
  function fakeView(list) {
    return { list };
  }

  it('returns every child in order when all are visible', () => {
    const a = { visible: true, x: 0, y: 0 };
    const b = { visible: true, x: 1, y: 1 };
    const view = fakeView([a, b]);
    expect(cloakFlattenTargets(view)).toEqual([a, b]);
  });

  it('excludes a hidden child (e.g. a muzzle-glow overlay mid-reload-blink), preserving order of the rest', () => {
    const hull = { visible: true, x: 0, y: 0 };
    const hiddenGlow = { visible: false, x: 2, y: 2 };
    const turret = { visible: true, x: 3, y: 3 };
    const view = fakeView([hull, hiddenGlow, turret]);
    expect(cloakFlattenTargets(view)).toEqual([hull, turret]);
  });

  it('treats a child with visible === undefined as visible (default Phaser state)', () => {
    const child = { x: 0, y: 0 };
    expect(cloakFlattenTargets(fakeView([child]))).toEqual([child]);
  });

  it('is a safe empty array for a view with no list (a bare/older test double)', () => {
    expect(cloakFlattenTargets({})).toEqual([]);
    expect(cloakFlattenTargets(null)).toEqual([]);
    expect(cloakFlattenTargets(undefined)).toEqual([]);
  });

  it('filters out null/undefined entries defensively', () => {
    const a = { visible: true, x: 0, y: 0 };
    expect(cloakFlattenTargets(fakeView([a, null, undefined]))).toEqual([a]);
  });
});
