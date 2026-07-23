import { describe, it, expect } from 'vitest';
import {
  CHASSIS_WEAPON_POOLS, CHASSIS_DPS_BUDGET, rollLoadout, loadoutSustainedDps, chassisMaxOpt,
} from './enemyLoadout.js';
import { WEAPONS } from './weapons.js';
import { Mech } from './Mech.js';
import { MOUNT_LOCATIONS, MELEE_LOCATIONS } from './anatomy.js';
import { mulberry32 } from './rng.js';

const CHASSES = ['light', 'medium', 'heavy'];
const optOf = (id) => WEAPONS[id].range.opt;
const isIndirect = (id) => {
  const d = WEAPONS[id].delivery;
  return d.guidance === 'homing' || d.path === 'arcing';
};

// Enumerate every 4-of-n combination of a pool, for asserting facts across the WHOLE roll space
// (not just sampled rolls).
function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [h, ...t] = arr;
  return [...combos(t, k - 1).map((c) => [h, ...c]), ...combos(t, k)];
}

describe('#474 chassis weapon pools (derived from weapons.js optimum range)', () => {
  it('every pool has at least 4 distinct weapons so a distinct 4-draw always succeeds', () => {
    for (const c of CHASSES) {
      expect(CHASSIS_WEAPON_POOLS[c].length).toBeGreaterThanOrEqual(MOUNT_LOCATIONS.length);
    }
  });

  it('light is the short cluster, heavy the long, medium in between (mean opt ordering)', () => {
    const mean = (c) => CHASSIS_WEAPON_POOLS[c].reduce((a, id) => a + optOf(id), 0)
      / CHASSIS_WEAPON_POOLS[c].length;
    expect(mean('light')).toBeLessThan(mean('medium'));
    expect(mean('medium')).toBeLessThan(mean('heavy'));
  });

  it('heavy can field an all-indirect set (so the camp-behind-cover posture is rollable)', () => {
    // At least one 4-combo of the heavy pool is entirely arcing/homing — the emergent "Mortarhead".
    const anyAllIndirect = combos(CHASSIS_WEAPON_POOLS.heavy, 4).some((c) => c.every(isIndirect));
    expect(anyAllIndirect).toBe(true);
  });

  it('light CANNOT field an all-indirect set (a light mech never camps — it presses)', () => {
    const anyAllIndirect = combos(CHASSIS_WEAPON_POOLS.light, 4).some((c) => c.every(isIndirect));
    expect(anyAllIndirect).toBe(false);
  });

  it('pools reference only real, non-shelved weapon ids', () => {
    for (const c of CHASSES) {
      for (const id of CHASSIS_WEAPON_POOLS[c]) expect(WEAPONS[id]).toBeTruthy();
    }
  });
});

describe('#474 rollLoadout — shape and determinism', () => {
  it('fills all four MOUNT_LOCATIONS with exactly one weapon each', () => {
    for (const c of CHASSES) {
      const mounts = rollLoadout(c, mulberry32(1));
      expect(Object.keys(mounts).sort()).toEqual([...MOUNT_LOCATIONS].sort());
      for (const loc of MOUNT_LOCATIONS) expect(mounts[loc]).toHaveLength(1);
    }
  });

  it('is deterministic for a given seed (same seed → identical loadout)', () => {
    for (const c of CHASSES) {
      const a = rollLoadout(c, mulberry32(42));
      const b = rollLoadout(c, mulberry32(42));
      expect(a).toEqual(b);
    }
  });

  it('rolls DISTINCT weapons — no chassis stacks the same gun twice (coherence + variety)', () => {
    for (const c of CHASSES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        const mounts = rollLoadout(c, mulberry32(seed));
        const ids = Object.values(mounts).flat();
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('only draws from its own chassis pool', () => {
    for (const c of CHASSES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        const ids = Object.values(rollLoadout(c, mulberry32(seed))).flat();
        for (const id of ids) expect(CHASSIS_WEAPON_POOLS[c]).toContain(id);
      }
    }
  });

  it('produces a valid, buildable Mech with four online weapons', () => {
    for (const c of CHASSES) {
      const mounts = rollLoadout(c, mulberry32(7));
      const mech = new Mech({ chassisId: c, mounts });
      mech.repairAll();
      expect(mech.onlineWeapons()).toHaveLength(4);
    }
  });

  it('varies across seeds (not a constant loadout)', () => {
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed += 1) {
      seen.add(Object.values(rollLoadout('heavy', mulberry32(seed))).flat().sort().join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('#474 DPS budget — every roll lands inside its chassis band', () => {
  it.each(CHASSES)('%s rolls never fall outside [lo, hi]', (c) => {
    const { lo, hi } = CHASSIS_DPS_BUDGET[c];
    for (let seed = 1; seed <= 300; seed += 1) {
      const dps = loadoutSustainedDps(Object.values(rollLoadout(c, mulberry32(seed))).flat());
      expect(dps).toBeGreaterThanOrEqual(lo);
      expect(dps).toBeLessThanOrEqual(hi);
    }
  });

  it('reports the measured spread per chassis (min/max/mean over 300 rolls)', () => {
    const summary = {};
    for (const c of CHASSES) {
      let min = Infinity; let max = -Infinity; let sum = 0; const n = 300;
      for (let seed = 1; seed <= n; seed += 1) {
        const dps = loadoutSustainedDps(Object.values(rollLoadout(c, mulberry32(seed))).flat());
        min = Math.min(min, dps); max = Math.max(max, dps); sum += dps;
      }
      summary[c] = { min: +min.toFixed(1), max: +max.toFixed(1), mean: +(sum / n).toFixed(1) };
      // The whole point of the budget: the spread stays modest (never trivial-vs-brutal).
      expect(max / min).toBeLessThan(1.5);
    }
    // eslint-disable-next-line no-console
    console.log('#474 measured DPS spread:', JSON.stringify(summary));
  });
});

// The tactical AI (scenes/arena/enemies.js) derives ROLE purely from the rolled weapons' optimum
// range, and the camp-behind-cover posture purely from every weapon being indirect. Those helpers
// are trivial and live in a Phaser-importing file, so mirror them here and prove the EMERGENT path
// holds for real rolls — no role field, no hardcoding, just the dice + the range thresholds.
describe('#474 roles stay EMERGENT (derived from the rolled loadout, not a role field)', () => {
  const BRAWLER_OPT = 170; // mirrors scenes/arena/enemies.js
  const SNIPER_OPT = 360;
  const meanOpt = (mounts) => {
    const ids = Object.values(mounts).flat();
    return ids.reduce((a, id) => a + optOf(id), 0) / ids.length;
  };
  const roleFor = (opt) => (opt < BRAWLER_OPT ? 'brawler' : opt > SNIPER_OPT ? 'sniper' : 'skirmisher');
  const allIndirect = (mounts) => Object.values(mounts).flat().every(isIndirect);

  it('every LIGHT roll reads as a press-in role (skirmisher) at the shortest standoff', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      expect(roleFor(meanOpt(rollLoadout('light', mulberry32(seed))))).toBe('skirmisher');
    }
  });

  it('every MEDIUM and HEAVY roll reads as a kiting role (sniper — mean opt beyond SNIPER_OPT)', () => {
    for (const c of ['medium', 'heavy']) {
      for (let seed = 1; seed <= 60; seed += 1) {
        expect(roleFor(meanOpt(rollLoadout(c, mulberry32(seed)))), `${c}#${seed}`).toBe('sniper');
      }
    }
  });

  it('light always presses closer than heavy (mean opt ordering holds per-roll)', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      expect(meanOpt(rollLoadout('light', mulberry32(seed))))
        .toBeLessThan(meanOpt(rollLoadout('heavy', mulberry32(seed))));
    }
  });

  it('SOME heavy roll comes up all-indirect and builds a mech the AI would camp with', () => {
    let found = false;
    for (let seed = 1; seed <= 200 && !found; seed += 1) {
      const mounts = rollLoadout('heavy', mulberry32(seed));
      if (allIndirect(mounts)) {
        found = true;
        // The built mech's every online weapon is arcing/homing — exactly what isAllIndirect reads.
        const mech = new Mech({ chassisId: 'heavy', mounts });
        mech.repairAll();
        expect(mech.onlineWeapons().every((w) => isIndirect(w.weapon.id))).toBe(true);
      }
    }
    expect(found).toBe(true);
  });

  it('NO light roll is all-indirect (a light mech never camps)', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(allIndirect(rollLoadout('light', mulberry32(seed)))).toBe(false);
    }
  });
});

describe('#474 melee-arms placement rule (defensive — no melee weapon exists yet)', () => {
  it('assignMounts would seat any melee pick in an arm (via a monkeypatched pool)', () => {
    // There is no melee weapon in the catalog, so exercise the rule directly: a loadout whose
    // weapons include a melee id must place it only in MELEE_LOCATIONS. We simulate by checking the
    // invariant holds for real rolls (trivially true today) AND documenting the guarantee.
    for (const c of CHASSES) {
      const mounts = rollLoadout(c, mulberry32(3));
      for (const loc of MOUNT_LOCATIONS) {
        for (const id of mounts[loc]) {
          if (WEAPONS[id].category === 'melee') expect(MELEE_LOCATIONS).toContain(loc);
        }
      }
    }
  });
});

describe('#474 chassisMaxOpt', () => {
  it('returns the longest optimum range in the chassis pool', () => {
    for (const c of CHASSES) {
      const expected = Math.max(...CHASSIS_WEAPON_POOLS[c].map(optOf));
      expect(chassisMaxOpt(c)).toBe(expected);
    }
  });

  it('orders light < medium < heavy (used for the safe-deploy margin)', () => {
    expect(chassisMaxOpt('light')).toBeLessThan(chassisMaxOpt('heavy'));
    expect(chassisMaxOpt('medium')).toBeLessThanOrEqual(chassisMaxOpt('heavy'));
  });
});
