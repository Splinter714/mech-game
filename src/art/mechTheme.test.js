// #446: the enemy mech theme. Pass 1 de-bubbled it (the glossy-ellipse `bubbly` mode is gone).
// Pass 2 answers the owner's "a bit more angular instead of blocky": the rounded-rect fallback is
// gone too, and the enemy draws a FACETED plate — a tapered wedge with cut corners and diagonal
// surface furniture. These are flag/palette/geometry assertions rather than pixel checks — the
// look itself is judged in the art preview gallery's ENEMY MECHS row.
import { describe, it, expect } from 'vitest';
import { themeFor, facet, chamfer, plateOutline, FACET_TAPER } from './mechPrims.js';
import { buildMechTextures, PIVOT_LOCATIONS } from './mechArt.js';
import { mechPreviewKeys } from './preview.js';
import { Mech } from '../data/Mech.js';
import { ENEMIES } from '../data/enemies.js';

const enemy = themeFor({ theme: 'enemy' });
const player = themeFor({ theme: 'player' });

describe('#446 enemy mech theme is no longer bubbly', () => {
  it('carries no bubbly flag at all — the mode was deleted, not just switched off', () => {
    expect(enemy.bubbly).toBeUndefined();
    expect(player.bubbly).toBeUndefined();
  });

  it('carries no rounded-plate mode either — pass 2 deleted it rather than tightening cornerR', () => {
    expect(enemy.rounded).toBeUndefined();
    expect(enemy.cornerR).toBeUndefined();
    expect(enemy.faceted).toBe(true);
  });

  it('keeps gun barrels capsule-ended — a tube really is round (its own flag, not the plate mode)', () => {
    expect(enemy.roundBarrel).toBe(true);
    expect(player.roundBarrel).toBeUndefined();
  });

  it('keeps the two factions apart the way they always were — pale enemy, dark player', () => {
    expect(player.faceted).toBe(false);
    expect(enemy.face).toBeGreaterThan(player.face);      // pale panels vs dark gunmetal
    expect(enemy.legibilityHalo).toBe(true);              // #129 silhouette ring is untouched
  });

  it('still honours a per-owner rim accent on top of the palette (#348/#404)', () => {
    const tinted = themeFor({ theme: 'enemy', accent: 0x123456 });
    expect(tinted.rim).toBe(0x123456);
    expect(tinted.faceted).toBe(true);
  });
});

describe('#446 pass 2: the enemy plate outline is angular, not blocky', () => {
  const W = 20, H = 12, C = 3;
  const f = facet(0, 0, W, H, C);

  it('is an eight-point outline, same as the player chamfer (drops into every ring)', () => {
    expect(f).toHaveLength(8);
    expect(chamfer(0, 0, W, H, C)).toHaveLength(8);
  });

  it('TAPERS: the top edge is narrower than the bottom, so the sides slant', () => {
    const topW = f[1][0] - f[0][0];                    // the flat run along y = -h/2
    const botW = f[4][0] - f[5][0];                    // the flat run along y = +h/2
    expect(topW).toBeLessThan(botW);
    // No two opposite side points share an x — that would be a vertical (blocky) edge.
    expect(Math.abs(f[2][0])).toBeLessThan(Math.abs(f[3][0]));
  });

  it('cuts the top corners deeper than the bottom ones (a wedge, not a symmetric bevel)', () => {
    const topCut = W / 2 * (1 - FACET_TAPER) - f[1][0];
    const botCut = W / 2 - f[4][0];
    expect(topCut).toBeGreaterThan(botCut * 2);
  });

  it('never produces a right angle: every corner is a real cut', () => {
    // A blocky rect would put two points at exactly (±W/2, ±H/2). None of ours land on a corner.
    for (const [x, y] of f) {
      expect(Math.abs(Math.abs(x) - W / 2) < 1e-9 && Math.abs(Math.abs(y) - H / 2) < 1e-9).toBe(false);
    }
  });

  it('plateOutline routes each faction to its own silhouette', () => {
    expect(plateOutline(enemy, 0, 0, W, H, C)).toEqual(f);
    expect(plateOutline(player, 0, 0, W, H, C)).toEqual(chamfer(0, 0, W, H, C));
  });
});

// A stub graphics object (same shape as mechArt.muzzleOff.test.js's): every draw call is a no-op,
// generateTexture records the key. Enough to actually RUN the whole enemy draw path — the point is
// that the de-bubbled branches execute for every real enemy loadout, not just that a flag changed.
function fakeScene() {
  const keys = [];
  const g = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'generateTexture') return (key) => keys.push(key);
      if (prop === 'destroy') return () => {};
      return () => {};
    },
  });
  return { keys, make: { graphics: () => g }, textures: { exists: (k) => keys.includes(k) } };
}

describe('#446 every enemy mech still bakes its full texture set', () => {
  // The owner judges this in the art preview gallery's ENEMY MECHS row, which builds exactly this
  // way (ArtPreviewScene `theme: 'enemy'`) and then looks the keys up via mechPreviewKeys — so a
  // missing key would show as an empty cell there.
  for (const id of Object.keys(ENEMIES)) {
    it(`${id}: hull frames, turret and all four pivoting parts`, () => {
      const scene = fakeScene();
      const mech = new Mech(ENEMIES[id]);
      mech.repairAll();
      buildMechTextures(scene, `e_${id}`, mech, { theme: 'enemy' });
      expect(scene.keys).toContain(`e_${id}_hull_0`);
      expect(scene.keys).toContain(`e_${id}_turret`);
      for (const loc of PIVOT_LOCATIONS) expect(scene.keys).toContain(`e_${id}_${loc}`);
      expect(mechPreviewKeys(scene.textures, `e_${id}`).length).toBeGreaterThan(0);
    });
  }
});

// #472: an ENEMY mech no longer shows its ARMOR state on the body. The player still does (the
// #401 torn-open-panel look, `exposedInternals`) — that question stays with #401. This runs the
// real part-draw path twice, fully armored and armor-stripped, and compares the emitted draw
// calls: identical for an enemy (nothing about armor reaches the sprite), different for the
// player (the panel tears open).
function recordingScene() {
  const calls = [];
  const g = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'generateTexture' || prop === 'destroy') return () => {};
      return (...args) => { calls.push(`${String(prop)}(${args.join(',')})`); };
    },
  });
  return { calls, make: { graphics: () => g }, textures: { exists: () => false } };
}

function armorStates(theme) {
  const draw = (strip) => {
    const mech = new Mech(ENEMIES[Object.keys(ENEMIES)[0]]);
    mech.repairAll();
    if (strip) {
      // Drain the arm's ARMOR only — the location must still be alive, which is exactly the
      // state the torn-panel look exists for.
      while (mech.hasArmor('rightArm')) mech.applyDamage('rightArm', 1);
      expect(mech.isPartDestroyed('rightArm')).toBe(false);
    }
    const scene = recordingScene();
    buildMechTextures(scene, 'k', mech, { theme });
    return scene.calls.join('|');
  };
  return { full: draw(false), stripped: draw(true) };
}

describe('#472 the enemy armor visual is gone from the mech body', () => {
  it('an enemy mech draws IDENTICALLY whether its armor holds or is stripped', () => {
    const { full, stripped } = armorStates('enemy');
    expect(stripped).toBe(full);
  });

  it('the player mech still tears open when a location loses its armor (#401, untouched)', () => {
    const { full, stripped } = armorStates('player');
    expect(stripped).not.toBe(full);
  });
});
