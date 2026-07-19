// #305: the multi-weapon seam for non-mech enemy kinds (data/kindWeapons.js).
//
// Two things are load-bearing here and both are tested against the LIVE data, not just synthetic
// defs: (1) every pre-existing single-weapon kind still normalises to exactly the loadout it had
// before, so this change is invisible to them; (2) the gunship really does resolve a DIFFERENT
// weapon per slot, which is the behaviour #305 exists to deliver.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SLOT, kindWeaponSlots, kindWeaponSlot, kindMaxFireRange } from './kindWeapons.js';
import { ENEMY_KINDS, ENEMY_KIND_IDS } from './enemyKinds.js';
import { resolveWeapon } from './weapons.js';

describe('kindWeaponSlots — normalising single- and multi-weapon kinds', () => {
  it('synthesises ONE slot from a kind\'s top-level weapon fields (the pre-#305 shape)', () => {
    const def = {
      weaponId: 'autocannon', weaponOverride: { cycleTime: 1700 },
      fireRange: 380, burstShots: 2, burstRestMs: 800,
    };
    const slots = kindWeaponSlots(def);
    expect(Object.keys(slots)).toEqual([DEFAULT_SLOT]);
    expect(slots[DEFAULT_SLOT]).toEqual({
      slot: DEFAULT_SLOT, weaponId: 'autocannon', weaponOverride: { cycleTime: 1700 },
      fireRange: 380, burstShots: 2, burstRestMs: 800,
    });
  });

  it('returns each declared slot for a multi-weapon kind, with its OWN override + discipline', () => {
    const def = {
      weapons: {
        a: { weaponId: 'clusterRocket', fireRange: 520, burstShots: 3, burstRestMs: 1400 },
        b: { weaponId: 'machineGun', weaponOverride: { delivery: { count: 2 } }, fireRange: 460 },
      },
    };
    const slots = kindWeaponSlots(def);
    expect(Object.keys(slots).sort()).toEqual(['a', 'b']);
    expect(slots.a.weaponId).toBe('clusterRocket');
    expect(slots.a.burstShots).toBe(3);
    // A slot with no override normalises to null, never to the other slot's.
    expect(slots.a.weaponOverride).toBeNull();
    expect(slots.b.weaponOverride).toEqual({ delivery: { count: 2 } });
    expect(slots.b.burstShots).toBeUndefined();
  });
});

describe('kindWeaponSlot — which gun is live', () => {
  const def = {
    weapons: { nose: { weaponId: 'clusterRocket' }, flank: { weaponId: 'machineGun' } },
    defaultWeaponSlot: 'flank',
  };

  it('honours an explicit request', () => {
    expect(kindWeaponSlot(def, 'nose').weaponId).toBe('clusterRocket');
    expect(kindWeaponSlot(def, 'flank').weaponId).toBe('machineGun');
  });

  it('falls back to defaultWeaponSlot when nothing is asked for or the request is unknown', () => {
    expect(kindWeaponSlot(def, undefined).slot).toBe('flank');
    expect(kindWeaponSlot(def, null).slot).toBe('flank');
    expect(kindWeaponSlot(def, 'tailGun').slot).toBe('flank');
  });

  it('falls back to the first declared slot when the kind names no default', () => {
    const d = { weapons: { nose: { weaponId: 'clusterRocket' }, flank: { weaponId: 'machineGun' } } };
    expect(kindWeaponSlot(d, undefined).slot).toBe('nose');
  });

  it('a single-weapon kind resolves its one gun no matter what a behaviour asks for — which is why\n'
    + '     every pre-#305 behaviour (which sets no slot at all) is unchanged', () => {
    const d = { weaponId: 'plasmaLance', fireRange: 460 };
    expect(kindWeaponSlot(d, undefined).weaponId).toBe('plasmaLance');
    expect(kindWeaponSlot(d, 'nose').weaponId).toBe('plasmaLance');
  });
});

describe('kindMaxFireRange', () => {
  it('is the single kind\'s own fireRange', () => {
    expect(kindMaxFireRange({ weaponId: 'x', fireRange: 380 })).toBe(380);
  });
  it('is the WIDEST slot\'s range for a multi-weapon kind (awareness must key off longest reach)', () => {
    expect(kindMaxFireRange({ weapons: { a: { fireRange: 520 }, b: { fireRange: 460 } } })).toBe(520);
  });
  it('is undefined when nothing declares a range (callers fall back to the weapon\'s own)', () => {
    expect(kindMaxFireRange({ weaponId: 'x' })).toBeUndefined();
  });
});

describe('the LIVE roster through the seam', () => {
  it('every kind but the gunship is still single-weapon, and resolves exactly what it did before', () => {
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'helicopter') continue;
      const k = ENEMY_KINDS[id];
      const slots = kindWeaponSlots(k);
      expect(Object.keys(slots), id).toEqual([DEFAULT_SLOT]);
      // The resolved weapon is byte-identical to the pre-#305 `resolveWeapon(def.weaponId,
      // def.weaponOverride)` call site.
      expect(resolveWeapon(slots[DEFAULT_SLOT].weaponId, slots[DEFAULT_SLOT].weaponOverride))
        .toEqual(resolveWeapon(k.weaponId, k.weaponOverride));
      expect(slots[DEFAULT_SLOT].fireRange, id).toBe(k.fireRange);
    }
  });

  it('the gunship carries TWO distinct weapons — the dumbfire nose salvo and the door gun', () => {
    const heli = ENEMY_KINDS.helicopter;
    const slots = kindWeaponSlots(heli);
    expect(Object.keys(slots).sort()).toEqual(['flank', 'nose']);

    // NOSE — Cluster Salvo. Deliberately the DUMBFIRE option (Jackson picked it over the homing
    // seeker) so a nose-on run can be sidestepped: assert it really is unguided.
    const nose = resolveWeapon(slots.nose.weaponId, slots.nose.weaponOverride);
    expect(nose.id).toBe('clusterRocket');
    expect(nose.delivery.guidance).toBe('dumbfire');

    // FLANK — the twin-lane Repeater, carried over verbatim from the pre-#305 loadout.
    const flank = resolveWeapon(slots.flank.weaponId, slots.flank.weaponOverride);
    expect(flank.id).toBe('machineGun');
    expect(flank.delivery.count).toBe(2);
    expect(slots.flank.burstShots).toBe(15);
    expect(slots.flank.burstRestMs).toBe(1200);

    // Two genuinely different guns with genuinely different cadences — which is exactly why the
    // cooldowns had to become per-slot.
    expect(nose.id).not.toBe(flank.id);
  });

  it('the gunship\'s flat strafeRange is GONE — standoff is randomised per cycle instead', () => {
    expect(ENEMY_KINDS.helicopter.strafeRange).toBeUndefined();
  });
});
