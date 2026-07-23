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

// ── #402: burst length is set by MAGAZINE SIZE, with no passive trickle ───────────────────
// #402 (owner decision) removed the continuous `ammoRegen` refill entirely: a weapon only refills
// by RELOADING (a fixed 1s lockout that ends with a full magazine — Mech.js). So sustained fire is
// balanced purely by `ammoMax`: a held trigger fires `ammoMax ÷ consumption-per-second` seconds,
// then reloads. Each weapon's magazine was re-tuned to keep the same ~6s burst intent the old
// #372/#376/#377 economy targeted (a few weapons deliberately longer — see BURST_MAX_SECONDS).
//
// These assertions ARE the merge gate for #402's balance. They are pure arithmetic over the data —
// no Phaser, no frame timing — but they mirror the real runtime rules exactly:
//   * consumption is ONE round per TRIGGER PULL, not per emitted shot (firing.js fireWeapon
//     spends 1 regardless of delivery.count);
//   * the interval between pulls is `_fireInterval` (firing.js): 1000/fireRate for a stream
//     pattern, max(120, cycleTime) otherwise;
//   * a weapon can only fire with ammo >= 1 (Mech.weapons()'s `ready`) and gets NO ammo back until
//     it reloads, so a full magazine's burst is exactly its whole-round count of pulls.
describe('#402 ammo economy — magazine size sets each weapon\'s ~6s burst (no trickle)', () => {
  // ms between trigger pulls — mirrors firing.js `_fireInterval` with identity (no-buff) mods.
  const fireIntervalMs = (w) => (w.delivery.pattern === 'stream' && w.delivery.fireRate > 0
    ? 1000 / w.delivery.fireRate
    : Math.max(120, w.cycleTime));

  // Seconds of held trigger, from a full magazine, until the first pull that ammo can't cover.
  // #402: no regen — ammo only ever goes down until a reload, so this is just whole-round pulls.
  // #434: a per-bolt-ammo volley weapon (Plasma Arc) spends `count` rounds per pull, not one — so
  // its magazine empties `count`× faster. Every other weapon still spends exactly one round per pull.
  const roundsPerPull = (w) => (w.delivery.ammoPerShot ? Math.max(1, w.delivery.count ?? 1) : 1);
  const burstSeconds = (w) => {
    const step = fireIntervalMs(w) / 1000;
    const perPull = roundsPerPull(w);
    let ammo = w.ammoMax;
    for (let shot = 0; shot < 100000; shot += 1) {
      if (ammo < perPull) return shot * step;    // dry: this pull can't be covered
      ammo = Math.max(0, ammo - perPull);
    }
    return Infinity;
  };

  const limited = Object.entries(WEAPONS).filter(([, w]) => w.ammoMax != null);

  it('covers the whole catalog — no weapon slipped through with a null magazine (melee is the ' +
     'only legal unlimited case and there is no melee weapon in the table today)', () => {
    expect(limited.length).toBe(Object.keys(WEAPONS).length);
    for (const [, w] of limited) expect(w.category).not.toBe('melee');
  });

  it.each(limited)('%s carries a finite, positive magazine and NO leftover ammoRegen field', (id, w) => {
    expect(w.ammoMax).toBeGreaterThan(0);
    expect(Number.isFinite(w.ammoMax)).toBe(true);
    // #402 removed the trickle from the player model — the field is gone from the base entries.
    expect(w.ammoRegen).toBeUndefined();
  });

  // A few weapons deliberately hold fire LONGER than the ~6s norm, carried over from earlier feel
  // passes: napalm (#376, 7.5s), streakPod (#376, 7.2s), and swarmRack (#377) which is an explicit
  // big-magazine carve-out at ~15s. plasmaCannon (#434) is now a 6-volley carve-out at ~14.4s — a
  // 30-round mag spending 5 rounds/pull (ammoPerShot) over a 2.4s cadence. Everything else ~5.5-6.6s.
  const BURST_MAX_SECONDS = {
    swarmRack: 15.5, streakPod: 7.2, napalm: 7.5, plasmaCannon: 14.5,
  };

  it.each(limited)('%s holds fire for a few seconds before its reload', (id, w) => {
    const secs = burstSeconds(w);
    expect(secs).toBeGreaterThanOrEqual(5.0);      // never a fraction-of-a-second burst
    expect(secs).toBeLessThanOrEqual(BURST_MAX_SECONDS[id] ?? 6.7);
    expect(secs).toBeLessThan(Infinity);           // and never effectively unlimited
  });

  it('sizes the stream weapons\' magazines to their 20/s or 18/s cadence (plasmaLance the ~6s ' +
     'template, beamLaser matched to it)', () => {
    expect(WEAPONS.plasmaLance.ammoMax).toBe(120);   // 120 ÷ 20/s = 6.0s
    expect(WEAPONS.beamLaser.ammoMax).toBe(WEAPONS.plasmaLance.ammoMax);   // shares the 20/s cadence
    expect(WEAPONS.machineGun.ammoMax).toBe(108);    // 108 ÷ 18/s = 6.0s
    expect(WEAPONS.flamethrower.ammoMax).toBe(108);
  });

  it('a trigger pull costs ONE round no matter how many things it emits, so a multi-emission ' +
     'weapon is not double-charged by delivery.count (see firing.js fireWeapon)', () => {
    // Documents the assumption burstSeconds() is built on. shotgun emits 7 pellets and
    // swarmRack 6 missiles per pull, yet both are budgeted at 1 round per pull like the
    // single-slug autocannon — which is why shotgun and autocannon carry the same magazine (5).
    expect(WEAPONS.shotgun.delivery.count).toBe(7);
    expect(WEAPONS.swarmRack.delivery.count).toBe(6);
    expect(WEAPONS.autocannon.delivery.count).toBe(1);
    expect(WEAPONS.shotgun.ammoMax).toBe(WEAPONS.autocannon.ammoMax);
  });
});

// ── #377/#402: Swarm Rack feel pass, in isolation ────────────────────────────────────────
// Jackson tuned this ONE weapon by feel: half the flight speed, a faster cycle, a steep-dropping
// arc, and a deliberately big magazine. The point of this block is the word "isolation" — the
// other missiles must be exactly where they were left. (#402 dropped the old fast-regen half of the
// #377 buff along with every weapon's trickle; the big magazine that keeps its long burst stays.)
describe('#377/#402 Swarm Rack feel pass', () => {
  it('flies far slower than it did (cut twice, 1000 -> 500 -> 320, then nudged 320 -> 400) and ' +
     'fires noticeably more often — a deliberate crawl next to the other missiles, not an oversight', () => {
    expect(WEAPONS.swarmRack.delivery.velocity).toBe(400);
    expect(WEAPONS.swarmRack.cycleTime).toBe(1100);
    expect(WEAPONS.swarmRack.delivery.velocity).toBeLessThan(WEAPONS.streakPod.delivery.velocity);
    expect(WEAPONS.swarmRack.delivery.velocity).toBeLessThan(WEAPONS.clusterRocket.delivery.velocity);
  });

  it('warbles lazier — a per-weapon wobble RATE override, with the width left alone and the ' +
     'shared jostle default untouched for anything that adopts it later', () => {
    expect(WEAPONS.swarmRack.delivery.wobble).toBe('jostle');
    expect(WEAPONS.swarmRack.delivery.wobbleFrequency).toBe(6.5);
    expect(WEAPONS.swarmRack.delivery.wobbleFrequency).toBeLessThan(11);   // the shared default
    expect(WEAPONS.swarmRack.delivery.wobbleAmplitude).toBeUndefined();    // width unchanged
  });

  it('opts into the steepDrop arc profile', () => {
    expect(WEAPONS.swarmRack.delivery.arcProfile).toBe('steepDrop');
  });

  it('carries a deliberately big magazine — a ~15s burst, far past the ~6s norm', () => {
    expect(WEAPONS.swarmRack.ammoMax).toBe(14);   // 14 pulls × 1.1s ≈ 15.4s
    expect(WEAPONS.swarmRack.ammoMax).toBeGreaterThan(WEAPONS.clusterRocket.ammoMax);
  });

  it('keeps a slightly narrower in-flight salvo spread', () => {
    expect(WEAPONS.swarmRack.delivery.salvoSpread).toBe(40);
  });

  it('leaves every OTHER missile exactly where it was — speed, cycle and arc shape', () => {
    // #434: plasmaCannon dropped out of this list — its volley rework gives it its own salvoSpread
    // (a PERSISTENT, non-converging scatter, not Swarm Rack's late-converge). Its own dedicated
    // coverage lives in the #434 block below.
    for (const id of ['clusterRocket', 'streakPod', 'napalm']) {
      expect(WEAPONS[id].delivery.arcProfile).toBeUndefined();   // still the default lob
      expect(WEAPONS[id].delivery.salvoSpread).toBeUndefined();  // no late-converge offset
      expect(WEAPONS[id].delivery.wobbleFrequency).toBeUndefined();
    }
    expect(WEAPONS.clusterRocket.delivery.velocity).toBe(1140);
    expect(WEAPONS.streakPod.delivery.velocity).toBeGreaterThan(500);
  });
});

// ── #408: pulseLaser & railLance cadence brought under the 2s reload ──────────────────────
// Both weapons cycled SLOWER than the fixed 2s reload (pulseLaser 3000ms, railLance 2200ms), so
// their magazine never emptied mid-fight and the reload mechanic did nothing. #408 dropped both
// cycleTimes clearly under 2000ms so the mag empties and the 2s reload creates real downtime.
// The per-pull damage has since been raised to hit the 24 SUSTAINED-DPS floor (see the sustained
// checks below); these assertions guard the cadence and the current burst DPS.
describe('#408 pulseLaser/railLance cadence under the 2s reload', () => {
  it('pulseLaser cycles under the 2s reload; burst DPS 33.3', () => {
    const w = WEAPONS.pulseLaser;
    expect(w.cycleTime).toBe(1800);
    expect(w.cycleTime).toBeLessThan(2000);            // the reload now actually gates it
    expect(w.totalDamage).toBeCloseTo(60, 6);
    expect(w.ammoMax).toBe(3);
    // DPS = totalDamage / cycleTime(s)
    expect((w.totalDamage / (w.cycleTime / 1000))).toBeCloseTo(33.333, 3);
  });

  it('railLance cycles under the 2s reload; burst DPS 31.5', () => {
    const w = WEAPONS.railLance;
    expect(w.cycleTime).toBe(1650);
    expect(w.cycleTime).toBeLessThan(2000);            // the reload now actually gates it
    expect(w.damage).toBeCloseTo(52, 6);
    expect(w.ammoMax).toBe(4);
    // DPS = damage / cycleTime(s)
    expect((w.damage / (w.cycleTime / 1000))).toBeCloseTo(31.515, 3);
  });
});
