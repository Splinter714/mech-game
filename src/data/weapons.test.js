import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_IDS, catalogMaxRange, previewRangeFrac } from './weapons.js';

// #120: the weapon catalog card preview scales its shot/beam travel distance by each
// weapon's range relative to the rest of the catalog, instead of every card maxing out its
// own stage width. These pure helpers (src/ui/weaponCardList.js consumes them) are what make
// that scaling actually reflect real range differences — cover them directly rather than only
// through the Phaser-only UI component that isn't unit-testable in this project's node/Vitest
// setup (no DOM/`navigator`).
describe('catalogMaxRange', () => {
  it('is the farthest opt (falling back to max) range among the given ids', () => {
    const max = catalogMaxRange(WEAPON_IDS);
    const expected = Math.max(...WEAPON_IDS.map((id) => {
      const r = WEAPONS[id].range;
      return r.opt || r.max || 0;
    }));
    expect(max).toBe(expected);
  });

  it('defaults to the player-facing WEAPON_IDS set, not every shelved weapon', () => {
    // Siege Shell is shelved (enemy-only) with a much longer range than anything on the
    // player-facing catalog — it must not be allowed to flatten the visible spread among the
    // weapons players actually see side by side in the garage/weapon lab.
    expect(WEAPON_IDS).not.toContain('siegeShell');
    expect(catalogMaxRange()).toBeLessThan(WEAPONS.siegeShell.range.opt);
  });
});

describe('previewRangeFrac', () => {
  it('gives a short-range weapon a visibly smaller fraction than a long-range one', () => {
    const catalogMax = catalogMaxRange(WEAPON_IDS);
    // Repeater (opt 180) is much shorter-range than Cluster Salvo (opt 660), the farthest
    // weapon on the player-facing catalog.
    const shortFrac = previewRangeFrac(WEAPONS.machineGun, catalogMax);
    const longFrac = previewRangeFrac(WEAPONS.clusterRocket, catalogMax);
    expect(shortFrac).toBeLessThan(longFrac);
    expect(longFrac).toBeCloseTo(1, 5);
  });

  it('floors the fraction so an extremely short-range weapon stays visible', () => {
    const tinyWeapon = { range: { opt: 1, max: 1 } };
    expect(previewRangeFrac(tinyWeapon, 1000)).toBeGreaterThanOrEqual(0.15);
  });

  it('falls back to range.max when opt is absent, and to 1 with no catalog max', () => {
    expect(previewRangeFrac({ range: { max: 500 } }, 1000)).toBeCloseTo(0.5, 5);
    expect(previewRangeFrac({ range: { opt: 100 } }, 0)).toBe(1);
  });
});
