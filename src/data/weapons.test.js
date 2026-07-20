import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_IDS, catalogMaxRange, previewRangeFrac, getWeapon, resolveWeapon } from './weapons.js';

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

  it('defaults to the player-facing WEAPON_IDS set (#244: the shelve list is empty — every weapon is mountable)', () => {
    // #244 un-shelved everything: WEAPON_IDS is the whole registry, so the garage/weapon-lab
    // catalog and the shop see every weapon.
    expect(WEAPON_IDS).toEqual(Object.keys(WEAPONS));
    expect(catalogMaxRange()).toBe(catalogMaxRange(WEAPON_IDS));
  });

  it('#244: only BASE registry ranges feed the catalog — the turret\'s artillery napalm override never leaks in', async () => {
    // The old siegeShell entry (range.opt 1600 / max 2400) now lives only as the turret kind's
    // weaponOverride on napalm. The catalog scales cards by base entries, so napalm reads as
    // its base 500-opt lobber, and nothing in the catalog reaches the override's 1600/2400.
    const { ENEMY_KINDS } = await import('./enemyKinds.js');
    const turretWeapon = resolveWeapon(ENEMY_KINDS.turret.weaponId, ENEMY_KINDS.turret.weaponOverride);
    expect(turretWeapon.id).toBe('napalm');           // base id preserved (SFX keys off it)
    expect(turretWeapon.range).toEqual({ min: 300, opt: 1600, max: 2400 });
    expect(WEAPONS.napalm.range).toEqual({ min: 50, opt: 500, max: 780 });   // base untouched
    expect(catalogMaxRange()).toBeLessThan(turretWeapon.range.opt);
  });
});

describe('previewRangeFrac', () => {
  it('gives a short-range weapon a visibly smaller fraction than a long-range one', () => {
    const catalogMax = catalogMaxRange(WEAPON_IDS);
    // Repeater (opt 338) is much shorter-range than Swarm Rack (opt 1050), the farthest
    // weapon on the player-facing catalog (#244: the homing missiles are un-shelved).
    const shortFrac = previewRangeFrac(WEAPONS.machineGun, catalogMax);
    const longFrac = previewRangeFrac(WEAPONS.swarmRack, catalogMax);
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

// #243 (absorbing #242): per-owner weapon overrides — a partial delta shallow-merged onto the
// shared base WEAPONS entry (with the nested `delivery` also field-merged), so a unit can mount
// "the same weapon, but tuned" without forking a near-duplicate registry entry. The base entry
// must never be mutated; the player's mount always resolves the untouched original.
describe('resolveWeapon (#243)', () => {
  it('returns the base entry itself (same reference) with no override', () => {
    expect(resolveWeapon('machineGun')).toBe(WEAPONS.machineGun);
    expect(resolveWeapon('machineGun', null)).toBe(WEAPONS.machineGun);
  });

  it('returns undefined for an unknown base id (mirrors getWeapon)', () => {
    expect(resolveWeapon('noSuchWeapon', { damage: 1 })).toBeUndefined();
    expect(getWeapon('noSuchWeapon')).toBeUndefined();
  });

  it('shallow-merges top-level fields — overridden fields win, everything else passes through', () => {
    const r = resolveWeapon('machineGun', { damage: 1 });
    expect(r.damage).toBe(1);
    // Untouched fields come straight from the base entry.
    expect(r.id).toBe(WEAPONS.machineGun.id);
    expect(r.name).toBe(WEAPONS.machineGun.name);
    expect(r.category).toBe(WEAPONS.machineGun.category);
    expect(r.range).toEqual(WEAPONS.machineGun.range);
    expect(r.ammoMax).toBe(WEAPONS.machineGun.ammoMax);
  });

  it('shallow-merges the nested delivery object field by field (not wholesale replacement)', () => {
    const r = resolveWeapon('machineGun', { delivery: { fireRate: 9 } });
    expect(r.delivery.fireRate).toBe(9);
    // Every other delivery field survives from the base profile.
    expect(r.delivery.pattern).toBe('stream');
    expect(r.delivery.count).toBe(WEAPONS.machineGun.delivery.count);
    expect(r.delivery.velocity).toBe(WEAPONS.machineGun.delivery.velocity);
    expect(r.delivery.kind).toBe(WEAPONS.machineGun.delivery.kind);
    expect(r.delivery.hit).toBe(WEAPONS.machineGun.delivery.hit);
  });

  it('never mutates the base WEAPONS entry (or its delivery)', () => {
    const before = JSON.parse(JSON.stringify(WEAPONS.machineGun));
    const r = resolveWeapon('machineGun', { damage: 1, delivery: { fireRate: 9, count: 1 } });
    expect(r).not.toBe(WEAPONS.machineGun);
    expect(r.delivery).not.toBe(WEAPONS.machineGun.delivery);
    expect(JSON.parse(JSON.stringify(WEAPONS.machineGun))).toEqual(before);
    // And a later plain resolve still yields the pristine base values.
    expect(resolveWeapon('machineGun').damage).toBe(before.damage);
    expect(resolveWeapon('machineGun').delivery.fireRate).toBe(before.delivery.fireRate);
  });

  it('keeps the base weapon id unless explicitly overridden (SFX/fire-cue systems key off it)', () => {
    expect(resolveWeapon('machineGun', { damage: 1 }).id).toBe('machineGun');
  });
});

// #252 playtest follow-up: "lobbed weapons should actually seek, not just fly to the spot
// targeted when the shot was initiated." Plasma Cannon and Napalm opt into `tracksLock`
// (firing.js `_spawnProjectile` reads this) instead of `guidance: 'homing'` — the latter would
// flip targetlock.js's `canFireWeapon` no-lock-no-fire gate on for them, which Jackson's design
// call (data/targetlock.js's own comment) explicitly says should NOT happen: these are
// "arcing-but-unguided lobs... fire unconditionally on trigger, lock or no lock."
describe('lobbed-weapon live tracking (#252 follow-up)', () => {
  it('plasmaCannon and napalm opt into tracksLock, NOT guidance: homing', () => {
    expect(WEAPONS.plasmaCannon.delivery.tracksLock).toBe(true);
    expect(WEAPONS.napalm.delivery.tracksLock).toBe(true);
    expect(WEAPONS.plasmaCannon.delivery.guidance).not.toBe('homing');
    expect(WEAPONS.napalm.delivery.guidance).not.toBe('homing');
  });

  it('both are still arcing lobs (the arc/apex flight logic is unchanged)', () => {
    expect(WEAPONS.plasmaCannon.delivery.path).toBe('arcing');
    expect(WEAPONS.napalm.delivery.path).toBe('arcing');
  });

  it('tunes a wider (lazier) turn radius than the missile family default, so seeking reads as ' +
     'a heavy lob nudging in, not a missile snapping on', () => {
    // Swarm Rack/Streak Pod (real homing missiles) rely on the shared 64px default.
    expect(WEAPONS.swarmRack.delivery.homingTurnRadius).toBeUndefined();
    expect(WEAPONS.streakPod.delivery.homingTurnRadius).toBeUndefined();
    expect(WEAPONS.plasmaCannon.delivery.homingTurnRadius).toBeGreaterThan(64);
    expect(WEAPONS.napalm.delivery.homingTurnRadius).toBeGreaterThan(64);
  });
});

// ── #372: every weapon reloads slower than it fires ──────────────────────────────────────
// Jackson: "it's time we implement actual limits to the reload rate that is lower than the
// fire rate for all weapons." Target ~6 seconds of continuous fire on EVERY weapon, matching
// plasmaLance — the one weapon that already did this and the one he has actually felt in
// play. The refill model is continuous (never stop-to-reload): regen keeps ticking, it is
// just meaningfully below consumption, so a held trigger nets out to a drain.
//
// These assertions ARE the merge gate for #372. They are pure arithmetic over the data — no
// Phaser, no frame timing — but they mirror the real runtime rules exactly:
//   * consumption is ONE round per TRIGGER PULL, not per emitted shot (firing.js fireWeapon
//     spends 1 regardless of delivery.count);
//   * the interval between pulls is `_fireInterval` (firing.js): 1000/fireRate for a stream
//     pattern, max(120, cycleTime) otherwise;
//   * a weapon can only fire with ammo >= 1 (Mech.weapons()'s `ready`), and regen is capped
//     at ammoMax (Mech.regenAmmo). The >= 1 gate is why this is simulated per shot rather
//     than solved as `ammoMax / (rate - regen)`: for a slow cycled weapon the last fraction
//     of a round is not spendable, and the continuous approximation is off by a whole cycle.
// AMMO_EMPTY_COOLDOWN (#238) is deliberately NOT modelled here — it starts once the magazine
// is already dry, so it governs recovery, not the burst window being measured.
describe('#372 ammo economy — every weapon runs dry in ~6s of continuous fire', () => {
  // ms between trigger pulls — mirrors firing.js `_fireInterval` with identity (no-buff) mods.
  const fireIntervalMs = (w) => (w.delivery.pattern === 'stream' && w.delivery.fireRate > 0
    ? 1000 / w.delivery.fireRate
    : Math.max(120, w.cycleTime));

  // Seconds of held trigger, from a full magazine, until the first pull that ammo can't cover.
  const burstSeconds = (w) => {
    const step = fireIntervalMs(w) / 1000;
    let ammo = w.ammoMax;
    for (let shot = 0; shot < 100000; shot += 1) {
      if (ammo < 1) return shot * step;          // dry: this pull is refused
      ammo = Math.min(w.ammoMax, Math.max(0, ammo - 1) + w.ammoRegen * step);
    }
    return Infinity;
  };

  const limited = Object.entries(WEAPONS).filter(([, w]) => w.ammoMax != null);

  it('covers the whole catalog — no weapon slipped through with a null magazine (melee is the ' +
     'only legal unlimited case and there is no melee weapon in the table today)', () => {
    expect(limited.length).toBe(Object.keys(WEAPONS).length);
    for (const [, w] of limited) expect(w.category).not.toBe('melee');
  });

  // #376 — DELIBERATE, NARROW WIDENING OF #372's UPPER BOUND for the four slow-cycled arcing
  // weapons. Jackson asked for "slightly more ammo" on all missiles (they were hitting #238's
  // 3s empty lockout constantly). Because a magazine only ever buys WHOLE trigger pulls, and
  // these weapons cycle at 1.5-1.8s, one extra pull is worth a full 1.5-1.8s of burst — there
  // is no way to grant a single extra shot and stay under 7.0s. The choice was: bump the
  // magazine and let these four land at 7.2-8.0s, or bump the magazine and cut regen to hold
  // the pull count (a pure downgrade — same burst, slower recovery). We took the extra shot.
  // clusterRocket's faster 1.1s cycle DID let its extra pull land inside the original window
  // (6.6s), so it is not listed here. #372's rule and its intent stand for everything else.
  const BURST_MAX_SECONDS = {
    swarmRack: 8.0, streakPod: 7.2, napalm: 7.5, plasmaCannon: 8.0,
  };

  it.each(limited)('%s holds fire for ~6s before running dry', (id, w) => {
    const secs = burstSeconds(w);
    expect(secs).toBeGreaterThanOrEqual(5.0);
    expect(secs).toBeLessThanOrEqual(BURST_MAX_SECONDS[id] ?? 7.0);
  });

  it.each(limited)('%s regenerates meaningfully SLOWER than it consumes (the actual ask)', (id, w) => {
    const consumePerSec = 1000 / fireIntervalMs(w);
    // Strictly below, and not by a token amount — a held trigger must be a real net drain.
    expect(w.ammoRegen).toBeLessThan(consumePerSec * 0.65);
    // ...but regen is never zero: the refill is CONTINUOUS, not a stop-to-reload. Easing off
    // the trigger always buys some ammo back.
    expect(w.ammoRegen).toBeGreaterThan(0);
  });

  it('leaves plasmaLance — the template Jackson already felt — exactly as it was', () => {
    expect(WEAPONS.plasmaLance.ammoMax).toBe(60);
    expect(WEAPONS.plasmaLance.ammoRegen).toBe(10);
    expect(WEAPONS.plasmaLance.ammoRegen).toBe(WEAPONS.plasmaLance.delivery.fireRate / 2);
  });

  it('gives beamLaser plasmaLance\'s economy, since they share the 20/s cadence (it was the ' +
     'worst offender pre-#372 at ~60s of continuous fire)', () => {
    expect(WEAPONS.beamLaser.ammoMax).toBe(WEAPONS.plasmaLance.ammoMax);
    expect(WEAPONS.beamLaser.ammoRegen).toBe(WEAPONS.plasmaLance.ammoRegen);
  });

  it('no longer lets any weapon out-regen its own fire rate (autocannon/napalm/swarmRack/' +
     'flamethrower could all previously be held forever)', () => {
    for (const id of ['autocannon', 'napalm', 'swarmRack', 'flamethrower', 'clusterRocket', 'pulseLaser']) {
      expect(burstSeconds(WEAPONS[id])).toBeLessThan(Infinity);
    }
  });

  it('a trigger pull costs ONE round no matter how many things it emits, so a multi-emission ' +
     'weapon is not double-charged by delivery.count (see firing.js fireWeapon)', () => {
    // Documents the assumption burstSeconds() is built on. shotgun emits 7 pellets and
    // swarmRack 6 missiles per pull, yet both are budgeted at 1 round per pull like the
    // single-slug autocannon — which is why their magazines are the same size (3).
    expect(WEAPONS.shotgun.delivery.count).toBe(7);
    expect(WEAPONS.swarmRack.delivery.count).toBe(6);
    expect(WEAPONS.autocannon.delivery.count).toBe(1);
    expect(WEAPONS.shotgun.ammoMax).toBe(WEAPONS.autocannon.ammoMax);
  });
});
