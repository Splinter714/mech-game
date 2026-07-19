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
// (Note: as of #117's follow-up temporary test change, a live KIND genuinely mounted a real
// hitscan weapon — so this proactive hardening was also exercised live in the actual game, not
// just by this synthetic fixture. As of #243's further follow-up the drone itself moved off
// that hitscan mount onto plasmaLance, a projectile stream — see the drone-specific tests below.)
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

const SYNTH_CONTACT_ID = '__testContactVehicleWeapon';
const SYNTH_CONTACT_WEAPON = {
  id: SYNTH_CONTACT_ID, name: 'Test Ram', category: 'ballistic',
  damage: 12, range: { min: 0, opt: 32, max: 32 },
  delivery: { hit: 'contact', pattern: 'single' },
};

// Partial mock: keep every real export (WEAPONS, SHELVED_WEAPON_IDS, …) and the real
// getWeapon/resolveWeapon for real ids, but resolve the one synthetic contact id to the fixture
// above. `resolveWeapon` (#243) is what `_fireVehicleWeapon` actually calls now, so it needs the
// same synthetic-id routing the old getWeapon mock had.
vi.mock('../../data/weapons.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getWeapon: (id) => (id === SYNTH_CONTACT_ID ? SYNTH_CONTACT_WEAPON : actual.getWeapon(id)),
    resolveWeapon: (id, override) =>
      (id === SYNTH_CONTACT_ID ? SYNTH_CONTACT_WEAPON : actual.resolveWeapon(id, override)),
  };
});

// #200: spy on the shared fire-cue scheduler so we can prove _fireVehicleWeapon now calls it
// (it never did before — enemies landed hits with an impact sound but fired silently).
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn() }));

import { EnemiesMixin } from './enemies.js';
import { FiringMixin } from './firing.js';
import { WEAPONS } from '../../data/weapons.js';
import { scheduleFireCues } from '../../audio/fireCues.js';
import { SOUND_THROTTLE_MS } from '../../data/hitFx.js';
import { ARENA_MECH_SCALE, partMuzzle } from './shared.js';
import { ART_SCALE } from '../../art/index.js';

// Referenced via WEAPONS.<id>.id (not string literals) so this file respects the architecture
// guard's "arena/*.js never names a specific weapon id" rule (same convention as
// enemyFireAngle.test.js / projectiles.test.js). beamLaser is the registry's canonical hitscan
// weapon; napalm is a real projectile weapon a live kind (the turret, via its #244 artillery
// weaponOverride) actually mounts.
const HITSCAN_WEAPON_ID = WEAPONS.beamLaser.id;
const PROJECTILE_WEAPON_ID = WEAPONS.napalm.id;
// pulseLaser is a genuine multi-pulse BURST (5 pulses over ~300ms, see weapons.js) — exactly
// the shape that exposed the #200 reopen bug. (No longer the drone's live weapon as of #243's
// further follow-up — the drone now mounts plasmaLance, see below — but still the registry's
// canonical burst fixture for this file's synthetic exercises.)
const BURST_WEAPON_ID = WEAPONS.pulseLaser.id;
// machineGun (the Repeater — helicopter/infantry's mount) is the registry's canonical STREAM
// weapon (`delivery: { pattern: 'stream', fireRate: 18, ... }`) — #241's cadence-fallback fix
// is specifically about this shape of weapon.
const STREAM_WEAPON = WEAPONS.machineGun;
const STREAM_WEAPON_ID = STREAM_WEAPON.id;
const PROJECTILE_WEAPON = WEAPONS.napalm;

// A minimal ArenaScene-shaped `this`: the REAL EnemiesMixin `_fireVehicleWeapon` runs, with the
// three cross-mixin fire helpers (from firing.js/projectiles.js) spied so we can see WHICH one
// the dispatch chose. FiringMixin is mixed in for real (not stubbed) so `_fireInterval` — the
// #241 cadence fallback — is the actual production logic, not a hand-rolled re-implementation
// that could silently drift from it.
function makeScene() {
  const calls = { melee: [], hitscan: [], projectile: [] };
  const scene = { time: { now: 0, delayedCall: () => {} } };
  Object.assign(scene, EnemiesMixin, FiringMixin);
  scene._melee = vi.fn((w, mx, my, angle, owner) => calls.melee.push({ w, owner }));
  scene._fireHitscan = vi.fn((w, mx, my, angle, owner, key) => calls.hitscan.push({ w, owner, key }));
  scene._spawnProjectile = vi.fn((w, mx, my, angle, owner) => calls.projectile.push({ w, owner }));
  return { scene, calls };
}

// A non-mech KIND enemy record shaped like the ones the arena builds from ENEMY_KINDS — just
// enough for `_fireVehicleWeapon`: a fireCd gate at 0 (ready to fire), a kindDef with a parts
// layout + muzzlePart + weaponId, and a texture key. #243: cadence always derives from the
// RESOLVED weapon (`_fireInterval`) — the old per-kind `fireEveryMs` timer no longer exists —
// so pass `weaponOverride` to retune cadence in the weapon's own terms (cycleTime / fireRate).
function makeKindEnemy(weaponId, weaponOverride = null) {
  const kindDef = {
    name: 'Test Kind', kind: 'turret', scale: 0.5,
    parts: { base: { x: 0, y: 6, w: 26, h: 16 }, gun: { x: 0, y: -8, w: 12, h: 20 } },
    muzzlePart: 'gun',
    weaponId,
  };
  if (weaponOverride) kindDef.weaponOverride = weaponOverride;
  // #305: cooldown + burst state are per WEAPON SLOT now; a single-weapon kindDef
  // normalises to one slot named DEFAULT_SLOT ('main'), so these tests read/write that key.
  return { key: 'testKind', kind: 'turret', slotCd: {}, slotBurst: {}, x: 100, y: 0, kindDef };
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
    e.slotCd.main = 500;                 // still cooling down

    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(0);   // gated — nothing fired

    e.slotCd.main = 0;
    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(1);
    expect(e.slotCd.main).toBe(PROJECTILE_WEAPON.cycleTime);   // cadence from the resolved weapon (#241/#243)
  });
});

// #241/#243 — vehicle-kind cadence used to be a flat `def.fireEveryMs ?? 1000` literal,
// completely ignoring the mounted weapon's OWN `delivery` timing (the concrete bug:
// helicopter's machineGun is a stream weapon meant to fire at 18 rounds/sec, but the old flat
// 1900ms timer fired it as a single burst instead). #241 made the weapon's own cadence
// (`_fireInterval`) the fallback; #243 then removed `fireEveryMs` entirely — cadence is ALWAYS
// derived from the RESOLVED weapon, and a kind that wants a different cadence tunes it in the
// weapon's own terms through `weaponOverride` (cycleTime / delivery.fireRate).
describe('_fireVehicleWeapon derives cadence from the resolved weapon\'s own delivery (#241/#243)', () => {
  it('a STREAM weapon (fireRate-driven) fires at the weapon\'s own resolved rate, matching _fireInterval', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(STREAM_WEAPON_ID);   // no override — the helicopter's shape

    scene._fireVehicleWeapon(e, {}, 0);

    // #269 playtest follow-up (streams bug fix): machineGun's own base delivery is a twin-lane
    // stream (count: 2) — one trigger pull now spawns BOTH lanes (_fireEnemyShots dispatches
    // every entry in plan.shots), not just one, per the actual dispatch fix.
    expect(calls.projectile.length).toBe(2);
    const expected = scene._fireInterval(STREAM_WEAPON, {});
    expect(e.slotCd.main).toBeCloseTo(expected, 6);
    // Sanity: this is the actual bug fix — the resolved cadence is nowhere near the old flat
    // 1900ms/1000ms timers; machineGun's fireRate: 18 resolves to ~55.6ms/shot.
    expect(e.slotCd.main).toBeCloseTo(1000 / 18, 6);
    expect(e.slotCd.main).toBeLessThan(100);
  });

  it('a non-stream (cycleTime-driven) weapon resolves via _fireInterval\'s cycleTime branch', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);   // napalm: single-shot, cycleTime 1500

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.projectile.length).toBe(1);
    expect(e.slotCd.main).toBeCloseTo(scene._fireInterval(PROJECTILE_WEAPON, {}), 6);
    expect(e.slotCd.main).toBeCloseTo(PROJECTILE_WEAPON.cycleTime, 6);   // 1500ms — the weapon's own cadence
  });

  it('a weaponOverride cycleTime slows a single-shot weapon\'s cadence in the weapon\'s own terms (tank/quadruped shape)', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID, { cycleTime: 3100 });

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.projectile.length).toBe(1);
    expect(e.slotCd.main).toBe(3100);   // the override's cadence, not the base 2600
  });

  it('a weaponOverride delivery.fireRate retunes a stream weapon\'s cadence (drone/infantry shape)', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(STREAM_WEAPON_ID, { delivery: { fireRate: 2 } });

    scene._fireVehicleWeapon(e, {}, 0);

    // #269 playtest follow-up (streams bug fix): the override only retunes fireRate, so the
    // base weapon's twin-lane count: 2 still applies — both lanes fire per trigger pull.
    expect(calls.projectile.length).toBe(2);
    expect(e.slotCd.main).toBeCloseTo(500, 6);   // 1000/2 — the override's rate, not the base 18/sec
  });

  it('the live helicopter kind (enemyKinds.js) resolves machineGun\'s true stream cadence, twin-lane', async () => {
    const { ENEMY_KINDS } = await import('../../data/enemyKinds.js');
    const { resolveWeapon } = await import('../../data/weapons.js');
    expect(ENEMY_KINDS.helicopter.weapons.flank.weaponId).toBe(STREAM_WEAPON_ID);
    // #269 playtest follow-up: back to twin tracer lanes, matching the player's Repeater —
    // no delta from the player's weapon anymore; damage and fireRate stay the player's too.
    expect(ENEMY_KINDS.helicopter.weapons.flank.weaponOverride).toEqual({ delivery: { count: 2 } });

    const resolved = resolveWeapon(ENEMY_KINDS.helicopter.weapons.flank.weaponId, ENEMY_KINDS.helicopter.weapons.flank.weaponOverride);
    expect(resolved.delivery.count).toBe(2);
    expect(resolved.damage).toBe(STREAM_WEAPON.damage);
    expect(resolved.delivery.fireRate).toBe(18);   // cadence untouched — full 18/sec during a burst

    const { scene } = makeScene();
    const interval = scene._fireInterval(resolved, {});
    expect(interval).toBeCloseTo(1000 / 18, 6);
    expect(interval).toBeLessThan(100);   // nowhere near the old flat 1900ms
  });

  it('no ENEMY_KINDS entry carries the retired fireEveryMs field (#243 removed it entirely)', async () => {
    const { ENEMY_KINDS } = await import('../../data/enemyKinds.js');
    for (const [id, k] of Object.entries(ENEMY_KINDS)) {
      expect(k.fireEveryMs, id).toBeUndefined();
    }
    // The kinds that used it now express the SAME cadence through weaponOverride:
    expect(ENEMY_KINDS.tank.weaponOverride).toEqual({ cycleTime: 1500 });
    expect(ENEMY_KINDS.quadruped.weaponOverride).toEqual({ cycleTime: 1700 });
    // Infantry's old 700ms timer, byte-identical, in stream terms: 1000 / (10/7) = 700.
    expect(1000 / ENEMY_KINDS.infantry.weaponOverride.delivery.fireRate).toBeCloseTo(700, 6);
    // Turret (#244): the old dedicated siegeShell entry is gone — its full artillery tuning,
    // including the deliberate 2600ms bombardment cadence, lives in the napalm weaponOverride.
    expect(ENEMY_KINDS.turret.weaponOverride.cycleTime).toBe(2600);
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
    e1.slotCd.main = 0;
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
    e2.slotCd.main = 0;
    scene._fireVehicleWeapon(e2, {}, 0);
    expect(scheduleFireCues).toHaveBeenCalledTimes(2);
  });
});

// #243: `_fireVehicleWeapon` resolves the kind's weapon through resolveWeapon(weaponId,
// weaponOverride) — the fired weapon (damage on the spawned round, emission plan, and the
// #241/#243 cadence derivation) is the base entry with the kind's partial delta merged on, and
// the base WEAPONS entry stays untouched for the player. The drone's rapid-cadence Pulse Laser
// and the helicopter's single-lane Repeater are the live examples.
describe('_fireVehicleWeapon resolves the kind\'s weaponOverride (#243)', () => {
  it('fires the OVERRIDDEN weapon (merged damage/fireRate) and derives cadence from it', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(STREAM_WEAPON_ID, { damage: 1, delivery: { fireRate: 9 } });

    scene._fireVehicleWeapon(e, {}, 0);

    // #269 playtest follow-up (streams bug fix): the override's damage/fireRate delta doesn't
    // touch count — the base weapon's twin-lane count: 2 still applies to both shots fired.
    expect(calls.projectile.length).toBe(2);
    const fired = calls.projectile[0].w.weapon;
    expect(fired.damage).toBe(1);
    expect(fired.delivery.fireRate).toBe(9);
    // Identity/lanes untouched by the partial delta — still the same twin-lane stream weapon.
    expect(fired.id).toBe(STREAM_WEAPON_ID);
    expect(fired.delivery.count).toBe(STREAM_WEAPON.delivery.count);
    // #241/#243 composition: cadence derives from the RESOLVED weapon — 1000/9, not 1000/18.
    expect(e.slotCd.main).toBeCloseTo(1000 / 9, 6);
    // The shared base entry the player mounts is unchanged.
    expect(STREAM_WEAPON.damage).toBe(0.889);   // #259 DPS-squish retune (was 1.667)
    expect(STREAM_WEAPON.delivery.fireRate).toBe(18);
  });

  it('fires the plain base weapon when the kind has no weaponOverride (unchanged behavior)', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(STREAM_WEAPON_ID);

    scene._fireVehicleWeapon(e, {}, 0);

    expect(calls.projectile[0].w.weapon).toBe(STREAM_WEAPON);   // the very same registry object
    expect(e.slotCd.main).toBeCloseTo(1000 / 18, 6);
  });

  it('the live drone kind resolves the bare Plasma Lance stream (no override, full damage)', async () => {
    const { ENEMY_KINDS } = await import('../../data/enemyKinds.js');
    const { resolveWeapon, WEAPONS } = await import('../../data/weapons.js');
    const { scene } = makeScene();
    const d = ENEMY_KINDS.drone;
    expect(d.weaponId).toBe(WEAPONS.plasmaLance.id);
    expect(d.weaponOverride).toBeUndefined();
    const base = WEAPONS.plasmaLance;
    const resolved = resolveWeapon(d.weaponId, d.weaponOverride);
    // #243 further playtest follow-up: same per-bolt damage as the player's mount; Plasma
    // Lance's own native fireRate (20/sec) is already rapid-fire-appropriate, so nothing needs
    // overriding — the drone shape comes entirely from burstShots/burstRestMs (see below).
    expect(resolved.damage).toBe(base.damage);
    expect(resolved.delivery.fireRate).toBe(20);
    // pattern 'stream' ⇒ _fireInterval is 1000/fireRate.
    expect(scene._fireInterval(resolved, {})).toBeCloseTo(1000 / 20, 6);
    expect(base.delivery.fireRate).toBe(20);   // player's entry untouched
  });
});

// #243 trigger discipline: optional per-kind `burstShots`/`burstRestMs` — fire N shots at the
// normal cadence, then rest. Both absent ⇒ continuous fire, byte-identical to before.
describe('_fireVehicleWeapon trigger discipline (#243 burstShots/burstRestMs)', () => {
  it('a kind with NO burst fields fires continuously at its cadence, exactly as before', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID);   // no burst fields
    for (let i = 0; i < 20; i++) {
      e.slotCd.main = 0;
      scene.time.now += 1000;
      scene._fireVehicleWeapon(e, {}, 0);
      expect(e.slotCd.main).toBe(PROJECTILE_WEAPON.cycleTime);   // always the plain cadence, never a rest
    }
    expect(calls.projectile.length).toBe(20);
    expect(e.slotBurst.main ?? 0).toBe(0);          // counter never engaged
  });

  it('a kind with burstShots stops after N shots — the Nth shot\'s cooldown becomes burstRestMs', () => {
    const { scene, calls } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID, { cycleTime: 200 });   // cadence via the weapon's own terms
    e.kindDef.burstShots = 3;
    e.kindDef.burstRestMs = 900;

    for (let i = 0; i < 2; i++) {
      e.slotCd.main = 0;
      scene.time.now += 1000;
      scene._fireVehicleWeapon(e, {}, 0);
      expect(e.slotCd.main).toBe(200);                    // within-burst spacing = normal cadence
    }
    e.slotCd.main = 0;
    scene.time.now += 1000;
    scene._fireVehicleWeapon(e, {}, 0);              // 3rd shot completes the burst
    expect(calls.projectile.length).toBe(3);
    expect(e.slotCd.main).toBe(900);                      // rest replaces the per-shot cadence
    expect(e.slotBurst.main).toBe(0);               // re-armed for the next burst

    // Still on rest cooldown — no shot; once it elapses, the next burst starts normally.
    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(3);
    e.slotCd.main = 0;                                    // rest elapsed
    scene.time.now += 1000;
    scene._fireVehicleWeapon(e, {}, 0);
    expect(calls.projectile.length).toBe(4);
    expect(e.slotCd.main).toBe(200);                      // back to within-burst cadence
  });

  it('burstRestMs defaults to 1000 when only burstShots is set', () => {
    const { scene } = makeScene();
    const e = makeKindEnemy(PROJECTILE_WEAPON_ID, { cycleTime: 200 });
    e.kindDef.burstShots = 1;
    scene._fireVehicleWeapon(e, {}, 0);
    expect(e.slotCd.main).toBe(1000);
  });

  it('the live helicopter and drone kinds opt in: bounded bursts with a real rest', async () => {
    const { ENEMY_KINDS } = await import('../../data/enemyKinds.js');
    // #243 playtest follow-up: 15-shot single-lane squeeze (~0.83s at 18/sec), 1.2s rest.
    expect(ENEMY_KINDS.helicopter.weapons.flank.burstShots).toBe(15);
    expect(ENEMY_KINDS.helicopter.weapons.flank.burstRestMs).toBe(1200);
    // Drone (#243 latest follow-up): fires one Plasma Lance bolt at a time, then a snappy
    // 400ms rest before the next single bolt (was a 7-bolt stutter with a 700ms rest).
    expect(ENEMY_KINDS.drone.burstShots).toBe(1);
    expect(ENEMY_KINDS.drone.burstRestMs).toBe(400);
    // No other kind opts in yet — everything else keeps continuous fire.
    for (const [id, k] of Object.entries(ENEMY_KINDS)) {
      if (id === 'helicopter' || id === 'drone') continue;
      expect(k.burstShots, id).toBeUndefined();
      expect(k.burstRestMs, id).toBeUndefined();
    }
  });
});
