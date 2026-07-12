import { describe, it, expect } from 'vitest';
import { ENEMY_KINDS, ENEMY_KIND_IDS, SWARM_SIZE, TURRET_CLUSTER_SIZE, INFANTRY_MOB_SIZE, isEnemyKind } from './enemyKinds.js';
import { getWeapon, WEAPONS } from './weapons.js';
import { HpBody } from './HpBody.js';

describe('ENEMY_KINDS — non-mech enemy data', () => {
  it('defines the six expected kinds', () => {
    expect(ENEMY_KIND_IDS.sort()).toEqual(['drone', 'helicopter', 'infantry', 'quadruped', 'tank', 'turret']);
  });

  it('every kind names a REAL weapon id (so no scene ever hardcodes one)', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      expect(getWeapon(k.weaponId), `${id} weapon ${k.weaponId}`).toBeTruthy();
    }
  });

  it('every kind is buildable into a valid HpBody with a part layout', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      const body = new HpBody(k);
      expect(body.hp).toBe(k.hp);
      expect(body.locations().length).toBeGreaterThan(0);
      expect(body.isDestroyed()).toBe(false);
      // Damaging any part draws down the pool.
      const loc = body.locations()[0];
      body.applyDamage(loc, k.hp + 1);
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

  it('#97: infantry is smaller and weaker than the drone — the weakest unit in the game', () => {
    expect(ENEMY_KINDS.infantry.scale).toBeLessThan(ENEMY_KINDS.drone.scale);
    expect(ENEMY_KINDS.infantry.hp).toBeLessThan(ENEMY_KINDS.drone.hp);
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'infantry') continue;
      expect(ENEMY_KINDS.infantry.hp, `infantry vs ${id}`).toBeLessThanOrEqual(ENEMY_KINDS[id].hp);
    }
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
    // over water regardless, tank/quadruped are bulkier and read fine wading through it.
    for (const id of ENEMY_KIND_IDS) {
      if (id === 'infantry') continue;
      expect(ENEMY_KINDS[id].avoidWater, id).toBeFalsy();
    }
  });

  it('#94: turret is an artillery emplacement — arcing indirect weapon at an insane range', () => {
    const t = ENEMY_KINDS.turret;
    const weapon = getWeapon(t.weaponId);
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

  it('#130: quadruped (Broodwalker) is a slow, tanky ground unit with a deploy mechanic', () => {
    const q = ENEMY_KINDS.quadruped;
    expect(q.flying).toBe(false);
    // "comparable to or slower than tank" — tank's own maxSpeed is 52.
    expect(q.move.maxSpeed).toBeLessThanOrEqual(ENEMY_KINDS.tank.move.maxSpeed);
    expect(q.move.maxSpeed).toBeGreaterThan(0);
    // Tougher than tank (160) but well under a heavy mech's ~616-hp pool — a real but beatable
    // objective target, not a brick wall.
    expect(q.hp).toBeGreaterThan(ENEMY_KINDS.tank.hp);
    expect(q.hp).toBeLessThan(616);
    // A real weapon mount, same as every other kind.
    expect(getWeapon(q.weaponId)).toBeTruthy();
    // #147: the deploy mechanic was reworked into a SWARM — a batch of several units per tick,
    // a faster cadence, and a much higher lifetime cap — rather than #130's original 1-per-8s
    // trickle capped at 5. Cadence still sane (not so fast it floods the arena instantly), and
    // the batch/cap numbers are internally consistent (batch bounds positive and ordered, cap
    // comfortably larger than a single batch so it actually reads as multiple bursts).
    expect(q.deployEveryMs).toBeGreaterThanOrEqual(2000);
    expect(q.deployEveryMs).toBeLessThanOrEqual(8000);
    expect(q.deployBatchMin).toBeGreaterThan(1);   // more than one unit per tick — a real "batch"
    expect(q.deployBatchMax).toBeGreaterThanOrEqual(q.deployBatchMin);
    expect(q.deployCap).toBeGreaterThan(q.deployBatchMax);   // room for multiple bursts, not just one
    expect(q.deployCap).toBeLessThanOrEqual(30);   // generous, but still a bounded lifetime cap
  });

  it('#152: quadruped deploy batch minimum is at least 5 (round-2 playtest floor)', () => {
    const q = ENEMY_KINDS.quadruped;
    expect(q.deployBatchMin).toBeGreaterThanOrEqual(5);
    expect(q.deployBatchMax).toBeGreaterThanOrEqual(q.deployBatchMin);
  });

  it('#152: quadruped body turnRate is now much slower, while turretSlew is UNCHANGED at 2.0', () => {
    const q = ENEMY_KINDS.quadruped;
    // Dropped hard from the #130/#147 value of 1.1 — well under a third of it, and under even the
    // heavy player chassis's already-ponderous 1.0 body turnRate (chassis/heavy.js) — so the body
    // reads as struggling to reorient.
    expect(q.move.turnRate).toBeLessThan(0.5);
    expect(q.move.turnRate).toBeGreaterThan(0);
    // The turret must keep tracking responsively regardless — explicitly untouched.
    expect(q.move.turretSlew).toBe(2.0);
    expect(q.move.turretSlew).toBeGreaterThan(q.move.turnRate * 3);
  });

  it('#152: quadruped carries a walk-cycle leg-frame count for its animated gait', () => {
    const q = ENEMY_KINDS.quadruped;
    expect(q.legFrames).toBeGreaterThanOrEqual(2);
    expect(q.move.stepInterval).toBeGreaterThan(0);
    // A slow, heavy, LURCHING cadence — not a brisk trot — so noticeably slower than the heavy
    // player chassis's own already-ponderous stepInterval (460ms, chassis/heavy.js).
    expect(q.move.stepInterval).toBeGreaterThan(460);
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
});
