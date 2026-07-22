import { describe, it, expect } from 'vitest';
import { ENEMY_KINDS, ENEMY_KIND_IDS, SWARM_SIZE, TURRET_CLUSTER_SIZE, INFANTRY_MOB_SIZE, isEnemyKind } from './enemyKinds.js';
import { getWeapon, resolveWeapon, WEAPONS } from './weapons.js';
// #305: a kind may now declare MULTIPLE weapon slots (`weapons: {...}`) instead of a single
// top-level `weaponId`. `kindWeaponSlots` normalises both forms into the same slot map, so these
// invariants now hold per SLOT — which is stronger than before: a multi-weapon kind's every gun
// is checked, not just its first.
import { kindWeaponSlots, kindMaxFireRange } from './kindWeapons.js';
import { HpBody } from './HpBody.js';
import { Mech } from './Mech.js';
import { ENEMIES } from './enemies.js';

describe('ENEMY_KINDS — non-mech enemy data', () => {
  it('defines the seven expected kinds', () => {
    expect(ENEMY_KIND_IDS.sort()).toEqual(['carrier', 'drone', 'helicopter', 'infantry', 'tank', 'turret', 'wallTurret']);
  });

  // #328: an UNARMED kind (the Carrier) resolves to ZERO weapon slots, so this loop simply has
  // nothing to check for it — no weapon id to be wrong. The armed kinds are still all covered.
  it('every kind names a REAL weapon id (so no scene ever hardcodes one)', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      for (const s of Object.values(kindWeaponSlots(k))) {
        expect(getWeapon(s.weaponId), `${id}.${s.slot} weapon ${s.weaponId}`).toBeTruthy();
      }
    }
  });

  it('every kind is buildable into a valid HpBody with a part layout', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      const body = new HpBody(k);
      expect(body.hp).toBe(k.hp);
      expect(body.locations().length).toBeGreaterThan(0);
      expect(body.isDestroyed()).toBe(false);
      // Damaging any part draws down the pool. #246: some kinds now layer a shield/armor pool
      // in FRONT of hp (tank/helicopter/carrier — see enemyKinds.js), so a killing blow must
      // clear those layers too, not just k.hp — one hit for the full stack plus a margin.
      const loc = body.locations()[0];
      const overkill = (k.hp || 0) + (k.armor || 0) + (k.shield?.max || 0) + 1;
      body.applyDamage(loc, overkill);
      expect(body.isDestroyed()).toBe(true);
    }
  });

  it('marks turret static and the flyers as flying (ignore ground cover)', () => {
    expect(ENEMY_KINDS.turret.move.maxSpeed).toBe(0);
    expect(ENEMY_KINDS.turret.flying).toBe(false);
    expect(ENEMY_KINDS.tank.flying).toBe(false);
    expect(ENEMY_KINDS.drone.flying).toBe(true);
    expect(ENEMY_KINDS.helicopter.flying).toBe(true);
  });

  it('#97: infantry is a GROUND unit (not flying), unlike the drone it swarms like', () => {
    expect(ENEMY_KINDS.infantry.flying).toBe(false);
  });

  it('#294: tank hull hitbox reads clearly longer-than-wide (a rectangular tank profile, not '
    + 'a near-square), matching the narrowed/lengthened art/vehicles/tank.js silhouette', () => {
    const { w, h } = ENEMY_KINDS.tank.parts.hull;
    expect(h).toBeGreaterThan(w);
    expect(h / w).toBeGreaterThan(1.3);
  });

  it('#97: infantry is smaller and weaker than the drone — the weakest unit in the game', () => {
    expect(ENEMY_KINDS.infantry.scale).toBeLessThan(ENEMY_KINDS.drone.scale);
    // #299 put infantry and drone on the same floor (3 each), so this is now <=, not <.
    expect(ENEMY_KINDS.infantry.hp).toBeLessThanOrEqual(ENEMY_KINDS.drone.hp);
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'infantry') continue;
      expect(ENEMY_KINDS.infantry.hp, `infantry vs ${id}`).toBeLessThanOrEqual(ENEMY_KINDS[id].hp);
    }
  });

  // #269 (ground-unit size-tier design doc, section 2): every kind carries a formal 'small' |
  // 'large' size tier, queried in gameplay code via shared.js's `unitSize`/`isSmallUnit` rather
  // than read directly off this table.
  it('#269: every kind has a size field that is small or large', () => {
    for (const id of ENEMY_KIND_IDS) {
      expect(['small', 'large']).toContain(ENEMY_KINDS[id].size);
    }
  });

  it('#269: small is exactly tank + infantry (the pre-#269 crushable-on-contact scope); '
    + 'turret/drone/helicopter/carrier are large', () => {
    expect(ENEMY_KINDS.tank.size).toBe('small');
    expect(ENEMY_KINDS.infantry.size).toBe('small');
    expect(ENEMY_KINDS.turret.size).toBe('large');
    expect(ENEMY_KINDS.drone.size).toBe('large');
    expect(ENEMY_KINDS.helicopter.size).toBe('large');
    expect(ENEMY_KINDS.carrier.size).toBe('large');
  });

  it('each kind wires an art + behavior registry key', () => {
    for (const id of ENEMY_KIND_IDS) {
      expect(typeof ENEMY_KINDS[id].art).toBe('string');
      expect(typeof ENEMY_KINDS[id].behavior).toBe('string');
    }
  });

  it('#75/#89: every kind carries a positive per-kind display scale', () => {
    for (const id of ENEMY_KIND_IDS) {
      const s = ENEMY_KINDS[id].scale;
      expect(typeof s, `${id} scale`).toBe('number');
      expect(s, `${id} scale`).toBeGreaterThan(0);
    }
    // #89 retune: every vehicle shrank further from its #75 size — tank/drone/helicopter/turret
    // all read noticeably smaller now (turret especially, since it now spawns in clusters).
    expect(ENEMY_KINDS.tank.scale).toBeLessThan(0.82);
    expect(ENEMY_KINDS.drone.scale).toBeLessThan(0.72);
    expect(ENEMY_KINDS.helicopter.scale).toBeLessThan(1.0);
    expect(ENEMY_KINDS.turret.scale).toBeLessThan(1.15);
    expect(ENEMY_KINDS.turret.scale).toBeLessThanOrEqual(0.6);
    // #91 retune: drones and tanks nudged smaller again (further than #89's already-reduced size).
    expect(ENEMY_KINDS.tank.scale).toBeLessThan(0.6);
    expect(ENEMY_KINDS.drone.scale).toBeLessThan(0.62);
  });

  it('#93: drone swarmRadius nudged out from the too-close 150 (playtest feedback)', () => {
    expect(ENEMY_KINDS.drone.swarmRadius).toBeGreaterThanOrEqual(190);
    expect(ENEMY_KINDS.drone.swarmRadius).toBeLessThanOrEqual(210);
  });

  it('#91: tank is noticeably slower/heavier than its #89 speed', () => {
    expect(ENEMY_KINDS.tank.move.maxSpeed).toBeLessThan(78);
    expect(ENEMY_KINDS.tank.move.maxSpeed).toBeGreaterThan(0);
  });

  it('#104: infantry is noticeably slower than its #97 launch speed (85)', () => {
    expect(ENEMY_KINDS.infantry.move.maxSpeed).toBeLessThan(85);
    expect(ENEMY_KINDS.infantry.move.maxSpeed).toBeGreaterThan(0);
  });

  it('#151: infantry avoids voluntarily wandering into water; no other kind is flagged', () => {
    expect(ENEMY_KINDS.infantry.avoidWater).toBe(true);
    // Explicitly infantry-only per the #151 report: turret is static (N/A), drone/helicopter fly
    // over water regardless, tank/carrier are bulkier and read fine wading through it.
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'infantry') continue;
      expect(ENEMY_KINDS[id].avoidWater, id).toBeFalsy();
    }
  });

  it('#94: turret is an artillery emplacement — arcing indirect weapon at an insane range', () => {
    const t = ENEMY_KINDS.turret;
    // #244: the turret's artillery tuning lives in its weaponOverride on napalm (the dedicated
    // siegeShell entry was consolidated away), so the RESOLVED weapon is what must satisfy the
    // #94 envelope — the base napalm entry keeps its short player-facing range.
    const weapon = resolveWeapon(t.weaponId, t.weaponOverride);
    // Indirect: arcing (or homing) delivery never needs line-of-sight (mirrors the "all-indirect"
    // detection in scenes/arena/enemies.js isIndirectWeapon).
    expect(weapon.delivery.path === 'arcing' || weapon.delivery.guidance === 'homing').toBe(true);
    // INSANE range: meaningfully farther than every other weapon's max range in the catalog.
    const otherMaxRanges = Object.values(WEAPONS)
      .filter((w) => w.id !== t.weaponId)
      .map((w) => w.range?.max ?? 0);
    expect(t.fireRange).toBeGreaterThan(Math.max(...otherMaxRanges));
    // The weapon's own max range must comfortably cover the turret's fireRange, or shells fired
    // right at the edge of engagement would fizzle short of the target (see arcMaxDist in
    // scenes/arena/firing.js, which bounds an arcing round's travel to weapon.range.max + 40).
    expect(weapon.range.max).toBeGreaterThanOrEqual(t.fireRange);
  });

  it('#130/#328: carrier (Broodhauler) is a slow, tanky, UNARMED ground unit with a deploy mechanic', () => {
    const q = ENEMY_KINDS.carrier;
    expect(q.flying).toBe(false);
    // #328: "movement feel should match the tank, but maybe slower" — slower than the tank on
    // EVERY axis now, not just top speed (the old 0.35 turnRate was a legged-lurch tune).
    expect(q.move.maxSpeed).toBeLessThan(ENEMY_KINDS.tank.move.maxSpeed);
    expect(q.move.maxSpeed).toBeGreaterThan(0);
    expect(q.move.accel).toBeLessThan(ENEMY_KINDS.tank.move.accel);
    expect(q.move.turnRate).toBeLessThan(ENEMY_KINDS.tank.move.turnRate);
    // ...but still recognisably tank-like, not the old sub-0.5 lumbering-legs turn rate.
    expect(q.move.turnRate).toBeGreaterThan(0.5);
    // #299 rebalance, UNCHANGED by #328: the comparison is on TOTAL toughness, not the bare hp
    // pool — the Broodhauler's 50 structure ties the tank's, and its lead comes from its armor
    // stacked on top (150 vs 80). It sits BELOW a light mech (200), which was an explicit,
    // confirmed owner decision. #436 moved the old shield's 50 points onto armor (no more
    // regenerating layer) without changing this total.
    expect(new HpBody(q).toughness).toBeGreaterThan(new HpBody(ENEMY_KINDS.tank).toughness);
    expect(new HpBody(q).toughness).toBeLessThan(new Mech(ENEMIES.raider).toughness);
    // #328: NO weapon at all. Jackson: "unarmed — pure carrier" — its only threat is what it
    // unloads, so every weapon-shaped field is gone and the seam resolves zero slots.
    expect(q.weaponId).toBeUndefined();
    expect(q.weaponOverride).toBeUndefined();
    expect(q.weapons).toBeUndefined();
    expect(q.fireRange).toBeUndefined();
    expect(q.muzzlePart).toBeUndefined();
    expect(Object.keys(kindWeaponSlots(q))).toEqual([]);
    expect(kindMaxFireRange(q)).toBeUndefined();
    // #147: the deploy mechanic is a SWARM — a batch of several units per tick, a fast cadence.
    // Cadence/batch size stay untouched by the #328 follow-up so the cap removal is felt alone.
    expect(q.deployEveryMs).toBeGreaterThanOrEqual(2000);
    expect(q.deployEveryMs).toBeLessThanOrEqual(8000);
    expect(q.deployBatchMin).toBeGreaterThan(1);   // more than one unit per tick — a real "batch"
    expect(q.deployBatchMax).toBeGreaterThanOrEqual(q.deployBatchMin);
  });

  it('#436: the carrier has ARMOR instead of a SHIELD — same value, no regenerating layer', () => {
    const q = ENEMY_KINDS.carrier;
    expect(q.armor).toBe(100);       // was 50 armor + a separate 50-max shield pool
    expect(q.shield).toBeUndefined();
    const body = new HpBody(q);
    expect(body.maxArmor).toBe(100);
    expect(body.hasShield()).toBe(false);
    expect(body.toughness).toBe(150); // total unchanged: 50 structure + 100 armor
  });

  it('#328 follow-up: the carrier is an INFINITE spawner — no lifetime deploy cap', () => {
    // Jackson: "yes make broodhauler an infinite spawner, yes". `deployCap: 24` used to stop it
    // dead after ~12-16s; killing it is now the only lever, exactly as docks work post-#326.
    expect(ENEMY_KINDS.carrier.deployCap).toBeUndefined();
  });

  it('#416: carrier deploy batch is a small burst (cadence slowed to cut the drone-flood)', () => {
    // #152's original floor was 5-8; #416 shrinks the burst (and slows the cadence, see
    // deployEveryMs) so the brood reads as a steady trickle rather than a self-reloading swarm,
    // on top of carrierDeployTick's new live-drone cap. Still a real multi-unit batch, not a drip.
    const q = ENEMY_KINDS.carrier;
    expect(q.deployBatchMin).toBeGreaterThanOrEqual(2);
    expect(q.deployBatchMax).toBeGreaterThanOrEqual(q.deployBatchMin);
    // Batch max stays modest so a single launch never overshoots carrierDeployTick's live cap
    // (CARRIER_MAX_LIVE_DRONES = 12, enemyBehaviors.js).
    expect(q.deployBatchMax).toBeLessThanOrEqual(12);
  });

  it('#328: the carrier is drawn on the TANK\'s art, visibly bigger than a tank', () => {
    const q = ENEMY_KINDS.carrier, t = ENEMY_KINDS.tank;
    // Same art builder family: the carrier's own module reuses tank.js's `drawTankHull`, so the
    // two kinds' `scale` values are finally directly comparable (they weren't before #328 —
    // the old quadruped art had a much larger intrinsic size).
    expect(q.art).toBe('carrier');
    expect(q.behavior).toBe('carrier');
    // "make the whole thing bigger" — 1.5x a tank's on-screen footprint.
    expect(q.scale).toBeCloseTo(t.scale * 1.5, 5);
    expect(q.size).toBe('large');
    // No turret to slew — the bay door is deck-mounted, pinned to the hull by carrierBehavior.
    expect(q.move.turretSlew).toBeUndefined();
    // The legged walk cycle went away with the legs.
    expect(q.legFrames).toBeUndefined();
    expect(q.move.stepInterval).toBeUndefined();
  });

  it('#328: the carrier declares a two-frame BAY DOOR for its launch animation', () => {
    const q = ENEMY_KINDS.carrier;
    // Mirrors the retired `legFrames` convention on the other sprite: the art builds
    // `<key>_turret_0` (shut) and `<key>_turret_1` (open), and carrierBehavior flips the live
    // frame for a beat on each launch.
    // (art/vehicles/carrier.js CARRIER_DOOR_FRAMES — not imported here, this file stays
    // Phaser-free like the rest of the pure data layer.)
    expect(q.turretFrames).toBe(2);
    expect(q.turretFrames).toBeGreaterThanOrEqual(2);
  });

  it('isEnemyKind distinguishes kinds from mech loadouts', () => {
    expect(isEnemyKind('tank')).toBe(true);
    expect(isEnemyKind('helicopter')).toBe(true);
    expect(isEnemyKind('raider')).toBe(false);   // a mech loadout
    expect(isEnemyKind('nope')).toBe(false);
  });

  it('isEnemyKind does not recognize the swarm/turretNest/infantryMob cluster-expansion ids', () => {
    // 'swarm', 'turretNest', and 'infantryMob' are squad-composition ids the arena expands into
    // several real kind spawns (drone / turret / infantry) — none is itself an ENEMY_KINDS entry.
    expect(isEnemyKind('swarm')).toBe(false);
    expect(isEnemyKind('turretNest')).toBe(false);
    expect(isEnemyKind('infantryMob')).toBe(false);
  });

  it('#89: SWARM_SIZE is a much larger swarm count ("waaaaaay more")', () => {
    expect(SWARM_SIZE).toBeGreaterThan(14);
    expect(SWARM_SIZE).toBeLessThan(30);
  });

  it('#89: TURRET_CLUSTER_SIZE is a small positive count', () => {
    expect(TURRET_CLUSTER_SIZE).toBeGreaterThan(1);
    expect(TURRET_CLUSTER_SIZE).toBeLessThan(6);
  });

  it('#97: INFANTRY_MOB_SIZE is a bigger volume than the drone SWARM_SIZE ("large volumes")', () => {
    expect(INFANTRY_MOB_SIZE).toBeGreaterThan(SWARM_SIZE);
    expect(INFANTRY_MOB_SIZE).toBeLessThan(50);
  });

  // #243 further playtest follow-up: the drone swapped off Pulse Laser onto Plasma Lance at
  // FULL player damage (no damage override) — Plasma Lance's own native cadence (a 20/sec
  // stream) already reads as rapid-fire-appropriate for a swarm unit, so no weaponOverride is
  // needed at all; the shaping comes entirely from trigger discipline. Latest playtest ask:
  // fire one bolt at a time (was a 7-bolt stutter), with a short 400ms rest between shots.
  describe('drone Plasma Lance loadout (#243 further playtest follow-up)', () => {
    it('drone mounts the bare plasmaLance base entry (no weaponOverride, no damage delta)', () => {
      expect(ENEMY_KINDS.drone.weaponId).toBe('plasmaLance');
      expect(ENEMY_KINDS.drone.weaponOverride).toBeUndefined();
    });

    it('resolves to the SAME per-bolt damage and cadence as the player\'s Plasma Lance', () => {
      const resolved = resolveWeapon(ENEMY_KINDS.drone.weaponId, ENEMY_KINDS.drone.weaponOverride);
      const base = WEAPONS.plasmaLance;
      expect(resolved).toBe(base);   // no override ⇒ resolveWeapon returns the base object itself
      expect(resolved.damage).toBe(base.damage);
      // Still a genuine plasma projectile stream — same identity as the player's mount.
      expect(resolved.delivery.hit).toBe('projectile');
      expect(resolved.delivery.pattern).toBe('stream');
      expect(resolved.delivery.fireRate).toBe(20);
      expect(resolved.id).toBe('plasmaLance');
    });

    it('opts into trigger discipline: 1 bolt at a time, then a short rest', () => {
      expect(ENEMY_KINDS.drone.burstShots).toBe(1);
      expect(ENEMY_KINDS.drone.burstRestMs).toBeGreaterThan(0);
      expect(ENEMY_KINDS.drone.burstRestMs).toBe(400);
    });

    it('has NO per-kind cadence timer — cadence derives entirely from the resolved weapon (#241/#243)', () => {
      expect(ENEMY_KINDS.drone.fireEveryMs).toBeUndefined();
    });

    it('drone fireRange stays inside the Plasma Lance\'s own envelope (280 ≤ opt 460 ≤ max 620)', () => {
      expect(ENEMY_KINDS.drone.fireRange).toBeLessThanOrEqual(WEAPONS.plasmaLance.range.opt);
      expect(ENEMY_KINDS.drone.fireRange).toBeLessThanOrEqual(WEAPONS.plasmaLance.range.max);
    });
  });

  it('#243: every kind\'s weaponOverride (when present) resolves to a valid weapon', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      for (const s of Object.values(kindWeaponSlots(k))) {
        const resolved = resolveWeapon(s.weaponId, s.weaponOverride);
        expect(resolved, `${id}.${s.slot} resolved weapon`).toBeTruthy();
        expect(resolved.delivery, `${id}.${s.slot} resolved delivery`).toBeTruthy();
        expect(resolved.damage, `${id}.${s.slot} resolved damage`).toBeGreaterThan(0);
      }
    }
  });

  it('#243 playtest follow-up: NO kind overrides damage — enemy rounds always match the player\'s weapon', () => {
    // #244 exception: the turret. Its override isn't an enemy-side retune of a weapon the
    // player also mounts — it's the old DEDICATED siegeShell entry (damage 10, a distinct
    // weapon with its own damage identity) consolidated into a napalm override, preserved
    // byte-identical. Every other kind fires its weapon at the player's own per-round damage.
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'turret') continue;
      const k = ENEMY_KINDS[id];
      for (const s of Object.values(kindWeaponSlots(k))) {
        expect(s.weaponOverride?.damage, `${id}.${s.slot}`).toBeUndefined();
        const resolved = resolveWeapon(s.weaponId, s.weaponOverride);
        expect(resolved.damage, `${id}.${s.slot} resolved damage`).toBe(WEAPONS[s.weaponId].damage);
      }
    }
    // The turret's consolidated artillery shell keeps the old siegeShell numbers exactly.
    const t = resolveWeapon(ENEMY_KINDS.turret.weaponId, ENEMY_KINDS.turret.weaponOverride);
    expect(t.damage).toBe(10);
    expect(WEAPONS.napalm.damage).toBe(27);   // the player's napalm (#259-retuned) is untouched by the override
  });
});

// #379 (playtest): "make drones even smaller". The absolute number is a playtest dial, but the
// ORDERING it has to respect isn't: a drone must stay visibly bigger than the infantry trooper,
// which #97 explicitly asked to be the smallest thing on the field, and must have actually
// shrunk from #91's 0.52.
describe('drone sprite scale (#379)', () => {
  it('is smaller than #91 left it but still above the infantry trooper', () => {
    expect(ENEMY_KINDS.drone.scale).toBeLessThan(0.52);
    expect(ENEMY_KINDS.drone.scale).toBeGreaterThan(ENEMY_KINDS.infantry.scale);
  });
});
