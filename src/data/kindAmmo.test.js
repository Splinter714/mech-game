// #375 — turret ammo made REAL. Two things under test here:
//   1. the pure magazine model (scope gate, init/consume/regen semantics), and
//   2. the TAPER these values actually produce, simulated against each kind's own cadence.
// (2) is the point of the issue: the pre-#375 numbers were written for a mechanic that never
// ran, and both of them regenerated FASTER than their gun could spend — so even once wired up
// they could never have tapered at all. These tests pin the corrected shape.
import { describe, it, expect } from 'vitest';
import { ENEMY_KINDS } from './enemyKinds.js';
import { kindWeaponSlot, DEFAULT_SLOT } from './kindWeapons.js';
import { resolveWeapon } from './weapons.js';
import { slotAmmoSpec, initKindAmmo, slotHasAmmo, consumeSlotAmmo, regenKindAmmo } from './kindAmmo.js';

// The kinds that ride the vehicle fire path. Only the two EMPLACED ones are ammo-limited (the
// scope decision recorded in kindAmmo.js's header).
const EMPLACED = ['turret', 'wallTurret'];
const MOBILE = ['tank', 'drone', 'helicopter', 'carrier', 'infantry'];

// Mirrors the production loop for ONE slot: `_updateVehicle` ticks the cooldown and calls
// regenKindAmmo every frame; `_fireVehicleWeapon` fires when the cooldown has expired AND a
// whole round is available, then spends one round and re-arms the cadence. Returns the shot
// TIMES so a test can ask both "how many shots before it runs dry" and "how long was it quiet".
function simulate(kindId, seconds, stepMs = 20) {
  const def = ENEMY_KINDS[kindId];
  const mount = kindWeaponSlot(def);
  const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
  const interval = weapon.cycleTime;       // every emplaced kind is a single-shot cycleTime weapon
  const ammo = initKindAmmo(def);
  const shots = [];
  let cd = 0;
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    if (cd <= 0 && slotHasAmmo(ammo, DEFAULT_SLOT)) {
      shots.push(t / 1000);
      consumeSlotAmmo(ammo, DEFAULT_SLOT, 1);
      cd = interval;
    }
    cd = Math.max(0, cd - stepMs);
    regenKindAmmo(def, ammo, stepMs / 1000);
  }
  return { shots, ammo, interval };
}

// The OPENING BURST: the run of shots fired back-to-back at the free cadence, before the
// magazine gives out. Everything after the first oversized gap is post-taper trickle.
function openingBurst({ shots, interval }) {
  let n = 1;
  while (n < shots.length && shots[n] - shots[n - 1] <= interval / 1000 + 0.1) n++;
  return { count: n, endsAt: shots[n - 1], gapAfter: shots[n] - shots[n - 1] };
}

describe('#375 scope: ammo limits the EMPLACED kinds only', () => {
  it.each(EMPLACED)('%s opts in and gets a real magazine', (id) => {
    expect(ENEMY_KINDS[id].ammoLimited).toBe(true);
    const ammo = initKindAmmo(ENEMY_KINDS[id]);
    expect(Object.keys(ammo)).toEqual([DEFAULT_SLOT]);
    expect(ammo[DEFAULT_SLOT]).toBeGreaterThan(0);
  });

  it.each(MOBILE)('%s is NOT ammo-limited — a mobile enemy pausing mid-fight is out of scope', (id) => {
    expect(ENEMY_KINDS[id].ammoLimited).toBeFalsy();
    expect(initKindAmmo(ENEMY_KINDS[id])).toEqual({});
  });

  it('a kind with no magazine reads as unlimited everywhere (no behaviour change off the opt-in)', () => {
    const ammo = initKindAmmo(ENEMY_KINDS.tank);
    expect(slotHasAmmo(ammo, DEFAULT_SLOT)).toBe(true);
    consumeSlotAmmo(ammo, DEFAULT_SLOT, 99);
    expect(slotHasAmmo(ammo, DEFAULT_SLOT)).toBe(true);   // still unlimited, still fires
  });

  it('the opt-in flag, not "the weapon happens to have ammoMax", is the gate', () => {
    // The multi-weapon gunship's base weapons carry magazines of their own, but it never opts in.
    expect(initKindAmmo(ENEMY_KINDS.helicopter)).toEqual({});
    const mount = kindWeaponSlot(ENEMY_KINDS.helicopter, 'flank');
    expect(slotAmmoSpec(ENEMY_KINDS.helicopter, mount)).toBeNull();
    // Flip the flag on a copy and the same slot DOES resolve a spec — proving the flag is what
    // decides, and that widening scope later is one field per kind.
    const optedIn = { ...ENEMY_KINDS.helicopter, ammoLimited: true };
    expect(slotAmmoSpec(optedIn, kindWeaponSlot(optedIn, 'flank'))).not.toBeNull();
  });
});

describe('#375 magazine mechanics', () => {
  it('spends one round per TRIGGER PULL and never goes below zero', () => {
    const ammo = { main: 2 };
    consumeSlotAmmo(ammo, 'main', 1);
    expect(ammo.main).toBe(1);
    consumeSlotAmmo(ammo, 'main', 5);
    expect(ammo.main).toBe(0);
  });

  it('needs a WHOLE round to fire — a fractional magazine is dry', () => {
    expect(slotHasAmmo({ main: 0.9 }, 'main')).toBe(false);
    expect(slotHasAmmo({ main: 1 }, 'main')).toBe(true);
  });

  it('regen is continuous and CLAMPS at ammoMax (a long lull cannot bank extra rounds)', () => {
    const def = ENEMY_KINDS.wallTurret;
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const ammo = { [DEFAULT_SLOT]: 0 };
    regenKindAmmo(def, ammo, 10);
    expect(ammo[DEFAULT_SLOT]).toBeCloseTo(0.45, 5);      // 0.045/s * 10s
    regenKindAmmo(def, ammo, 10_000);
    expect(ammo[DEFAULT_SLOT]).toBe(max);
  });
});

describe('#375 the taper these values actually produce', () => {
  it('every ammo-limited kind SPENDS faster than it regenerates — otherwise it could never run dry', () => {
    // This is exactly what was broken before #375: wallTurret spent 1/5.2s = 0.192 rounds/s
    // against a 0.25/s trickle, and turret spent 0.385/s against 0.6/s. Both out-regenerated
    // their own guns, so the "taper" the comments described was arithmetically impossible.
    for (const id of EMPLACED) {
      const def = ENEMY_KINDS[id];
      const mount = kindWeaponSlot(def);
      const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
      const spend = 1000 / weapon.cycleTime;
      expect(spend, id).toBeGreaterThan(weapon.ammoRegen);
    }
  });

  it('wallTurret: ~7 shots over ~31s of sustained contact, then a real quiet window', () => {
    const sim = simulate('wallTurret', 90);
    const burst = openingBurst(sim);
    expect(burst.count).toBe(7);                     // 7 shots at the free 5.2s cadence…
    expect(burst.endsAt).toBeCloseTo(31.2, 1);
    // …and then it is DRY: no 8th shot for over ten seconds. That silence is the suppression
    // window the issue is buying — bait the wall, break contact, approach quieter.
    expect(burst.gapAfter).toBeGreaterThan(10);
    expect(burst.gapAfter).toBeCloseTo(13.3, 0);
  });

  it('turret: ~11 shells over ~26s of bombardment, then dry', () => {
    const burst = openingBurst(simulate('turret', 90));
    expect(burst.count).toBe(11);
    expect(burst.endsAt).toBeCloseTo(26, 1);
    expect(burst.gapAfter).toBeGreaterThan(5);
    expect(burst.gapAfter).toBeCloseTo(7.3, 0);
  });

  it.each(EMPLACED)('%s is SUPPRESSED, never silenced — sustained volume drops several-fold but stays nonzero', (id) => {
    // #356 (clear every enemy and dock per base) must stay achievable, and a base still needs
    // fixed guns that matter (#287 made wall turrets the only ones). So the steady state after
    // the magazine is spent is a slow trickle of fire, not a dead emplacement.
    const { shots, interval } = simulate(id, 240);
    const free = 240_000 / interval;                       // shots an unlimited gun would land
    expect(shots.length).toBeLessThan(free * 0.5);         // meaningfully quieter…
    const late = shots.filter((t) => t > 60);
    expect(late.length).toBeGreaterThan(3);                // …but still shooting, long after dry
  });

  it('a suppressed emplacement RECOVERS once contact is broken — the lever is reversible', () => {
    const def = ENEMY_KINDS.wallTurret;
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const ammo = { [DEFAULT_SLOT]: 0 };                    // just ran dry
    regenKindAmmo(def, ammo, 60);                          // a minute out of its arc
    expect(ammo[DEFAULT_SLOT]).toBeGreaterThan(1);         // shooting again
    expect(ammo[DEFAULT_SLOT]).toBeLessThan(max);          // but not yet a full magazine
  });

  it('per-unit magazines, so co-op\'s doubled enemy COUNT (#350) scales volume linearly with no shared pool', () => {
    const def = ENEMY_KINDS.wallTurret;
    const a = initKindAmmo(def);
    const b = initKindAmmo(def);
    consumeSlotAmmo(a, DEFAULT_SLOT, 3);
    expect(b[DEFAULT_SLOT]).toBe(initKindAmmo(def)[DEFAULT_SLOT]);   // b untouched by a's fire
    expect(a[DEFAULT_SLOT]).not.toBe(b[DEFAULT_SLOT]);
  });
});
