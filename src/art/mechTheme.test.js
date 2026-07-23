// #446: the enemy mech theme, de-bubbled. It used to draw every part as a glossy ellipse with a
// highlight spot (the `bubbly` mode) — inflated pods rather than armour. That whole mode is gone;
// enemies now take the standard `rounded` plate path with a HARD corner radius, which also means
// they pick up the flat panel furniture (top rim light, bottom AO band, seam) the player has
// always had. These are palette/flag assertions rather than pixel checks — the geometry itself is
// judged in the art preview gallery's ENEMY MECHS row.
import { describe, it, expect } from 'vitest';
import { themeFor, ROUNDED_CORNER_R } from './mechPrims.js';
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

  it('draws hard-cornered plates: rounded, but far tighter than the old default radius', () => {
    expect(enemy.rounded).toBe(true);
    expect(enemy.cornerR).toBeLessThan(ROUNDED_CORNER_R / 2);
    expect(enemy.cornerR).toBeGreaterThan(0);
  });

  it('keeps the two factions apart the way they always were — angular player, pale enemy', () => {
    expect(player.rounded).toBe(false);
    expect(enemy.face).toBeGreaterThan(player.face);      // pale panels vs dark gunmetal
    expect(enemy.legibilityHalo).toBe(true);              // #129 silhouette ring is untouched
  });

  it('still honours a per-owner rim accent on top of the palette (#348/#404)', () => {
    const tinted = themeFor({ theme: 'enemy', accent: 0x123456 });
    expect(tinted.rim).toBe(0x123456);
    expect(tinted.cornerR).toBe(enemy.cornerR);
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
