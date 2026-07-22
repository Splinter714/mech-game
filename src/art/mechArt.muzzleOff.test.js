// #433 (re-architecture): buildMechTextures bakes a GLOW-ONLY overlay texture per weapon-carrying
// part (the four skill slots) for the PLAYER theme — the muzzle glow alone, on a transparent canvas
// the same size as the part — while the part texture itself is baked muzzle-OFF (no swap variant).
// These lock in that the right keys get baked, for the player only (enemy mechs have no reload blink /
// no overlay), using a fake scene that records every generated texture key.
import { describe, it, expect } from 'vitest';
import { buildMechTextures, MUZZLE_GLOW_SUFFIX, PIVOT_LOCATIONS } from './mechArt.js';
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
