// #433: buildMechTextures bakes a "muzzle-off" VARIANT of every weapon-carrying part (arms + side
// torsos) for the player theme, so the reload blink can swap a part sprite to its extinguished-muzzle
// twin. These lock in that the right keys get baked — for the PLAYER only (enemy mechs have no reload
// blink, so no extra textures) — using a fake scene that records every generated texture key rather
// than a real Phaser canvas.
import { describe, it, expect } from 'vitest';
import { buildMechTextures, MUZZLE_OFF_SUFFIX, PIVOT_LOCATIONS } from './mechArt.js';
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

describe('buildMechTextures muzzle-off variants (#433)', () => {
  it('bakes a muzzle-off variant for every weapon-carrying part on the player theme', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    for (const loc of PIVOT_LOCATIONS) {
      expect(scene.keys).toContain(`playerMech_${loc}${MUZZLE_OFF_SUFFIX}`);
    }
  });

  it('still bakes the normal part texture alongside each muzzle-off variant', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    for (const loc of PIVOT_LOCATIONS) {
      expect(scene.keys).toContain(`playerMech_${loc}`);
    }
  });

  it('bakes NO muzzle-off variants for an enemy mech (no reload blink)', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'enemyMech', loadedMech(), { theme: 'enemy' });
    expect(scene.keys.some((k) => k.endsWith(MUZZLE_OFF_SUFFIX))).toBe(false);
  });

  it('adds exactly one muzzle-off texture per weapon-carrying part (four total)', () => {
    const scene = fakeScene();
    buildMechTextures(scene, 'playerMech', loadedMech(), { theme: 'player' });
    const offKeys = scene.keys.filter((k) => k.endsWith(MUZZLE_OFF_SUFFIX));
    expect(offKeys).toHaveLength(PIVOT_LOCATIONS.length);
    expect(PIVOT_LOCATIONS).toHaveLength(4);
  });
});
