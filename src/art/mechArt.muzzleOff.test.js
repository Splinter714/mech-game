// #433 (re-architecture): buildMechTextures bakes a GLOW-ONLY overlay texture per weapon-carrying
// part (the four skill slots) for the PLAYER theme — the muzzle glow alone, on a transparent canvas
// the same size as the part — while the part texture itself bakes with the muzzle glow OMITTED
// entirely (transparent where the glow would be, NOT a dark blob — the off phase reads as the colour
// vanishing to nothing). These lock in that the right keys get baked, for the player only (enemy
// mechs have no reload blink / no overlay), using a fake scene that records every generated texture
// key; plus a direct check of the `glowSkip`/`glowOnly` gates that split the glow off from the part.
import { describe, it, expect } from 'vitest';
import { buildMechTextures, MUZZLE_GLOW_SUFFIX, PIVOT_LOCATIONS } from './mechArt.js';
import { scaledGraphics } from './_frames.js';
import { barrel, glowDot, rectC, emissive, NEON } from './mechPrims.js';
import { Mech } from '../data/Mech.js';

// A stub graphics object: every draw call is a no-op; generateTexture records the key. A Proxy
// supplies a no-op for any method the draw code reaches for (fillRoundedRect via `.raw`, etc.).
function fakeScene() {
  const keys = [];
  const g = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'generateTexture') return (key) => keys.push(key);
      if (prop === 'destroy') return () => {};
      return () => {};
    },
  });
  return {
    keys,
    make: { graphics: () => g },
    textures: { exists: () => false },
  };
}

// A player medium with a limited-ammo weapon in each of the four skill slots.
function loadedMech() {
  return new Mech({
    chassisId: 'mediumPlayer',
    mounts: {
      leftArm: ['autocannon'], rightArm: ['pulseLaser'],
      leftTorso: ['machineGun'], rightTorso: ['swarmRack'],
    },
  });
}

describe('buildMechTextures muzzle-glow overlays (#433 re-architecture)', () => {
  it('bakes a glow-only overlay for every weapon-carrying part on the player theme', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    for (const loc of PIVOT_LOCATIONS) {
      expect(scene.keys).toContain(`playerMech_${loc}${MUZZLE_GLOW_SUFFIX}`);
    }
  });

  it('still bakes the (now muzzle-off) base part texture alongside each glow overlay', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    for (const loc of PIVOT_LOCATIONS) {
      expect(scene.keys).toContain(`playerMech_${loc}`);
    }
  });

  it('bakes NO glow overlays for an enemy mech (no reload blink, glow baked into the part)', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'enemyMech', loadedMech(), { theme: 'enemy' });
    expect(scene.keys.some((k) => k.endsWith(MUZZLE_GLOW_SUFFIX))).toBe(false);
  });

  it('adds exactly one glow overlay per weapon-carrying part (four total)', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    const glowKeys = scene.keys.filter((k) => k.endsWith(MUZZLE_GLOW_SUFFIX));
    expect(glowKeys).toHaveLength(PIVOT_LOCATIONS.length);
    expect(PIVOT_LOCATIONS).toHaveLength(4);
  });
});

// A raw graphics recorder for scaledGraphics: counts hardware fills (fillRect/fillEllipse) vs the
// glowDot's own emission (fillCircle), so we can prove which of the two gates keeps which layer.
function recorder() {
  const c = { rect: 0, circle: 0, ellipse: 0, rounded: 0 };
  return {
    counts: c,
    fillStyle() {}, lineStyle() {},
    fillRect() { c.rect++; }, fillCircle() { c.circle++; },
    fillEllipse() { c.ellipse++; }, fillRoundedRect() { c.rounded++; },
    fillTriangle() {}, fillPoints() {},
  };
}
const T = { faceDk: 0x111111, deep: 0x000000, faceMid: 0x222222 };

describe('#433 muzzle-glow bake gates (base part omits the glow; overlay is glow-only)', () => {
  it('glowSkip suppresses the glow layers but keeps the gun hardware (the base part bake)', () => {
    const raw = recorder();
    const sg = scaledGraphics(raw);
    sg.glowSkip = true;
    barrel(sg, T, 0, 0, 2, 8);            // hardware — a rect (non-rounded theme)
    glowDot(sg, 0, -8, 2.6, NEON.energy); // muzzle glow — all fillCircle
    expect(raw.counts.rect).toBeGreaterThan(0);  // hardware still drew
    expect(raw.counts.circle).toBe(0);           // glow OMITTED → transparent, not dark
  });

  it('glowOnly keeps ONLY the glow layers, dropping the gun hardware (the overlay bake)', () => {
    const raw = recorder();
    const sg = scaledGraphics(raw);
    sg.glowOnly = true;
    barrel(sg, T, 0, 0, 2, 8);
    glowDot(sg, 0, -8, 2.6, NEON.energy);
    expect(raw.counts.rect).toBe(0);              // hardware suppressed
    expect(raw.counts.circle).toBeGreaterThan(0); // the muzzle glow is the only thing kept
  });

  it('with neither gate set (enemy bake) both hardware and glow draw into the part', () => {
    const raw = recorder();
    const sg = scaledGraphics(raw);
    barrel(sg, T, 0, 0, 2, 8);
    glowDot(sg, 0, -8, 2.6, NEON.energy);
    expect(raw.counts.rect).toBeGreaterThan(0);
    expect(raw.counts.circle).toBeGreaterThan(0);
  });

  // Fidelity: a coloured muzzle layer that ISN'T a glowDot/glowBar (edge light, rail slit, plasma
  // pool, launch cell, blade edge) must be wrapped in emissive() so the gates treat it like glow —
  // omitted from the base, kept in the overlay — so base + overlay equals the original inline bake.
  it('emissive() puts a non-glow coloured layer on the SAME side of both gates as glow', () => {
    const base = recorder();
    const bsg = scaledGraphics(base);
    bsg.glowSkip = true;                                          // base part
    emissive(bsg, () => rectC(bsg, 0, 0, 2, 8, NEON.energy.edge, 0.7));
    expect(base.counts.rect).toBe(0);                            // omitted → transparent, not dark

    const over = recorder();
    const osg = scaledGraphics(over);
    osg.glowOnly = true;                                         // glow overlay
    emissive(osg, () => rectC(osg, 0, 0, 2, 8, NEON.energy.edge, 0.7));
    expect(over.counts.rect).toBeGreaterThan(0);                // kept in the overlay
  });

  it('an UN-wrapped coloured rect (raw hardware) stays in the base and is dropped from the overlay', () => {
    const base = recorder();
    const bsg = scaledGraphics(base);
    bsg.glowSkip = true;
    rectC(bsg, 0, 0, 2, 8, 0x123456);                            // not emissive → treated as hardware
    expect(base.counts.rect).toBeGreaterThan(0);                // stays in the base
  });
});
