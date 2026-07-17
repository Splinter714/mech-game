// #123 — non-mech enemy KINDS (turret/tank/drone/helicopter/infantry) fire through their own
// path, `_fireVehicleWeapon`, which — until this fix — unconditionally called `_spawnProjectile`
// regardless of the weapon's delivery type. That is the exact latent bug #117 fixed for enemy
// MECHS (see enemies.js's mech fire loop + delivery.test.js): a hitscan or contact weapon would
// silently misrender as a travelling projectile. Every live kind loadout is `hit: 'projectile'`
// today, so this is proactive hardening — these tests prove the dispatch now branches by
// delivery type, and that the existing projectile kinds are byte-for-byte unaffected.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so we stub the module out (same as enemyFireAngle.test.js).
// `getWeapon` is partial-mocked: real weapons pass through untouched (so the projectile-kind
// regression check exercises the genuine registry entry a live kind mounts), plus one synthetic
// CONTACT weapon id — no `hit: 'contact'` weapon exists in WEAPONS yet, and the contact branch
// still must be proven, exactly as #117's smoke test used a synthetic melee fixture for mechs.
// (Note: as of #117's follow-up temporary test change, the `drone` kind now genuinely mounts
// pulseLaser — a real hitscan weapon — so this proactive hardening is now also exercised live in
// the actual game, not just by this synthetic fixture.)
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

const SYNTH_CONTACT_ID = '__testContactVehicleWeapon';
const SYNTH_CONTACT_WEAPON = {
  id: SYNTH_CONTACT_ID, name: 'Test Ram', category: 'ballistic',
  damage: 12, range: { min: 0, opt: 32, max: 32 },
  delivery: { hit: 'contact', pattern: 'single' },
};

// Partial mock: keep every real export (WEAPONS, SHELVED_WEAPON_IDS, …) and the real getWeapon
// for real ids, but resolve the one synthetic contact id to the fixture above.
vi.mock('../../data/weapons.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getWeapon: (id) => (id === SYNTH_CONTACT_ID ? SYNTH_CONTACT_WEAPON : actual.getWeapon(id)),
  };
});

// #200: spy on the shared fire-cue scheduler so we can prove _fireVehicleWeapon now calls it
// (it never did before — enemies landed hits with an impact sound but fired silently).
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn() }));

import { EnemiesMixin } from './enemies.js';
import { WEAPONS } from '../../data/weapons.js';
import { scheduleFireCues } from '../../audio/fireCues.js';
import { SOUND_THROTTLE_MS } from '../../data/hitFx.js';
import { ARENA_MECH_SCALE, partMuzzle } from './shared.js';
import { ART_SCALE } from '../../art/index.js';

// Referenced via WEAPONS.<id>.id (not string literals) so this file respects the architecture
// guard's "arena/*.js never names a specific weapon id" rule (same convention as
// enemyFireAngle.test.js / projectiles.test.js). beamLaser is the registry's canonical hitscan
// weapon; siegeShell is a real projectile weapon a live kind (the turret) actually mounts.
const HITSCAN_WEAPON_ID = WEAPONS.beamLaser.id;
const PROJECTILE_WEAPON_ID = WEAPONS.siegeShell.id;
// pulseLaser is the drone swarm's actual weapon (enemyKinds.js) and a genuine multi-pulse BURST
// (5 pulses over ~300ms, see weapons.js) — exactly the shape that exposed the #200 reopen bug.
const BURST_WEAPON_ID = WEAPONS.pulseLaser.id;

// A minimal ArenaScene-shaped `this`: the REAL EnemiesMixin `_fireVehicleWeapon` runs, with the
// three cross-mixin fire helpers (from firing.js/projectiles.js) spied so we can see WHICH one
// the dispatch chose.
function makeScene() {
  const calls = { melee: [], hitscan: [], projectile: [] };
  const scene = { time: { now: 0, delayedCall: () => {} } };
  Object.assign(scene, EnemiesMixin);
  scene._melee = vi.fn((w, mx, my, angle, owner) => calls.melee.push({ w, owner }));
  scene._fireHitscan = vi.fn((w, mx, my, angle, owner, key) => calls.hitscan.push({ w, owner, key }));
  scene._spawnProjectile = vi.fn((w, mx, my, angle, owner) => calls.projectile.push({ w, owner }));
  return { scene, calls };
}

// A non-mech KIND enemy record shaped like the ones the arena builds from ENEMY_KINDS — just
// enough for `_fireVehicleWeapon`: a fireCd gate at 0 (ready to fire), a kindDef with a parts
// layout + muzzlePart + weaponId, and a texture key.
function makeKindEnemy(weaponId) {
  return {
    key: 'testKind', kind: 'turret', fireCd: 0,
    x: 100, y: 0,
    kindDef: {
      name: 'Test Kind', kind: 'turret', scale: 0.5,
      parts: { base: { x: 0, y: 6, w: 26, h: 16 }, gun: { x: 0, y: -8, w: 12, h: 20 } },
      muzzlePart: 'gun',
      weaponId,
      fireEveryMs: 1000,
    },
  };
}

describe('_fireVehicleWeapon branches on delivery type, matching the #117 mech fix (#123)', () => {
  it('routes a HITSCAN kind weapon to _fireHitscan (a beam), NOT _spawnProjectile', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(HITSCAN_WEAPON_ID);

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.hitscan.length).toBe(1);
    expect(calls.projectile.length).toBe(0);
    expect(calls.melee.length).toBe(0);
    // owner: 'enemy' so damage lands on the player; shooterKey is the kind's texture key.
    expect(calls.hitscan[0].owner).toBe('enemy');
    expect(calls.hitscan[0].key).toBe('testKind');
    expect(calls.hitscan[0].w.weapon.id).toBe(HITSCAN_WEAPON_ID);
  });

  it('routes a CONTACT/melee kind weapon to _melee, NOT _spawnProjectile', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(SYNTH_CONTACT_ID);

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.melee.length).toBe(1);
    expect(calls.projectile.length).toBe(0);
    expect(calls.hitscan.length).toBe(0);
    expect(calls.melee[0].owner).toBe('enemy');
    expect(calls.melee[0].w.weapon.id).toBe(SYNTH_CONTACT_ID);
  });

  it('still routes a genuine PROJECTILE kind weapon to _spawnProjectile (no regression — every live kind is projectile today)', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.projectile.length).toBe(1);
    expect(calls.hitscan.length).toBe(0);
    expect(calls.melee.length).toBe(0);
    expect(calls.projectile[0].owner).toBe('enemy');
    expect(calls.projectile[0].w.weapon.id).toBe(PROJECTILE_WEAPON_ID);
  });

  it('respects the fireCd gate (does not fire while on cooldown) and sets cadence after firing', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);
    e.fireCd = 500;                 // still cooling down

    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(0);   // gated — nothing fired

    e.fireCd = 0;
    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(1);
    expect(e.fireCd).toBe(1000);               // cadence reset from def.fireEveryMs
  });
});

// #233 ("projectiles should originate from the tip of the weapon muzzle art"): non-mech KIND
// enemies (turret/tank/drone/…) spawn shots via this same `_fireVehicleWeapon` path, keyed off
// `def.muzzlePart`'s box — but that box's own front edge sits behind (or, for the quadruped,
// past) the kind's hand-drawn gun/barrel art. `def.muzzleForward` (enemyKinds.js) closes that
// gap; these tests prove `_fireVehicleWeapon` actually applies it.
describe('_fireVehicleWeapon applies muzzleForward to the spawn point (#233)', () => {
  function expectedMuzzle(e, muzzleForward) {
    const part = e.kindDef.parts[e.kindDef.muzzlePart];
    const disp = ARENA_MECH_SCALE * (e.kindDef.scale ?? 1) * ART_SCALE;
    return partMuzzle(part, e.x, e.y, 0, disp, muzzleForward ?? 0);
  }

  it('spawns at the bare front edge when muzzleForward is absent (unchanged legacy behaviour)', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);   // no muzzleForward field
    scene._fireVehicleWeapon(e, {}, 0);
    const want = expectedMuzzle(e, 0);
    expect(scene._spawnProjectile.mock.calls[0][1]).toBeCloseTo(want.x, 6);
    expect(scene._spawnProjectile.mock.calls[0][2]).toBeCloseTo(want.y, 6);
  });

  it('pushes the spawn point forward by muzzleForward when the kind def sets it (e.g. the turret\'s +4)', () => {
    const { scene } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);
    e.kindDef.muzzleForward = 4;
    scene._fireVehicleWeapon(e, {}, 0);
    const want = expectedMuzzle(e, 4);
    const withoutForward = expectedMuzzle(e, 0);
    expect(scene._spawnProjectile.mock.calls[0][1]).toBeCloseTo(want.x, 6);
    expect(scene._spawnProjectile.mock.calls[0][2]).toBeCloseTo(want.y, 6);
    // Sanity: the offset actually moved the point, proving muzzleForward isn't a no-op.
    expect(Math.abs(want.x - withoutForward.x) + Math.abs(want.y - withoutForward.y)).toBeGreaterThan(0.01);
  });

  it('pulls the spawn point BACK for a negative muzzleForward (the quadruped kind\'s -4 case)', () => {
    const { scene } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);
    e.kindDef.muzzleForward = -4;
    scene._fireVehicleWeapon(e, {}, 0);
    const want = expectedMuzzle(e, -4);
    const withoutForward = expectedMuzzle(e, 0);
    expect(scene._spawnProjectile.mock.calls[0][1]).toBeCloseTo(want.x, 6);
    expect(scene._spawnProjectile.mock.calls[0][2]).toBeCloseTo(want.y, 6);
    expect(Math.abs(want.x - withoutForward.x) + Math.abs(want.y - withoutForward.y)).toBeGreaterThan(0.01);
  });
});

describe('_fireVehicleWeapon now schedules a fire cue (#200 — enemies fired silently before this)', () => {
  it('calls scheduleFireCues once per shot, with the weapon and its emission plan', () => {
    scheduleFireCues.mockClear();
    const { scene } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);

    scene._fireVehicleWeapon(e, {}, 0);

    expect(scheduleFireCues).toHaveBeenCalledTimes(1);
    const [sceneArg, weaponArg, planArg, audibleArg] = scheduleFireCues.mock.calls[0];
    expect(sceneArg).toBe(scene);
    expect(weaponArg.id).toBe(PROJECTILE_WEAPON_ID);
    expect(planArg).toBeTruthy();
    expect(audibleArg).toBe(true);
  });

  it('throttles same-weapon-id fire cues (SOUND_THROTTLE_MS) so a turret cluster/drone swarm sharing a weapon does not stack cues', () => {
    scheduleFireCues.mockClear();
    const { scene } = makeScene();
    // Two distinct enemies (a turret cluster, #145) sharing the same weapon id, firing in the
    // same instant — only the first should schedule a cue.
    const e1 = makeKindEnemy(PROJECTILE_WEAPON_ID);
    const e2 = makeKindEnemy(PROJECTILE_WEAPON_ID);

    scene._fireVehicleWeapon(e1, {}, 0);
    scene._fireVehicleWeapon(e2, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(1);

    // Advance time past the throttle window — the next shot gets its own cue again.
    scene.time.now += 100;
    e1.fireCd = 0;
    scene._fireVehicleWeapon(e1, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(2);
  });

  // #200 reopened: Jackson's playtest report ("especially with drones... eventually sounds stop
  // and never resume") traced to this gap — the throttle above only gates how often a NEW cue
  // schedule can START, not how long a BURST weapon's own sub-shot retriggers keep emitting cues
  // afterward (fireCues.js's scheduleFireCues retriggers Audio.fire for each later sub-shot in
  // plan.shots). Pulse Laser (the drone swarm's weapon) bursts 5 pulses over ~300ms per trigger
  // pull; two drones firing on their own ~260ms cadence, offset by more than SOUND_THROTTLE_MS
  // (50ms) but less than the burst's own span, used to each pass the old gate and stack their
  // own overlapping ~300ms trails — multiplying the actual fire-cue rate several times past the
  // one-per-window the throttle promised. _allowEnemyFireCue now folds the weapon's own burst
  // span into the busy window so this can't happen.
  it('folds a BURST weapon\'s own sub-shot span into the throttle window (#200 reopen) — a second trigger inside that span is blocked even past SOUND_THROTTLE_MS', () => {
    scheduleFireCues.mockClear();
    const { scene } = makeScene();
    const e1 = makeKindEnemy(BURST_WEAPON_ID);
    const e2 = makeKindEnemy(BURST_WEAPON_ID);

    scene._fireVehicleWeapon(e1, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(1);
    const [, , planArg] = scheduleFireCues.mock.calls[0];
    const burstSpan = Math.max(0, ...planArg.shots.map((s) => s.delay));
    expect(burstSpan).toBeGreaterThan(0);   // sanity: this weapon really is a multi-pulse burst

    // Past SOUND_THROTTLE_MS (50ms) but well within the burst's own tail — the OLD throttle
    // would have let this through and stacked a second overlapping retrigger trail.
    scene.time.now += 60;
    scene._fireVehicleWeapon(e2, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(1);   // still just the one — blocked

    // Once the first trigger's entire burst tail would have finished (+ the usual gap), a fresh
    // trigger is accepted again. (Reset e2's own cooldown — _fireVehicleWeapon sets it on every
    // attempt regardless of whether the fire-cue throttle above let the cue through, so the
    // blocked attempt above still armed it.)
    scene.time.now += burstSpan + SOUND_THROTTLE_MS;
    e2.fireCd = 0;
    scene._fireVehicleWeapon(e2, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(2);
  });
});
