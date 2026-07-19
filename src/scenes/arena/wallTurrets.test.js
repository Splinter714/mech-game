// #310 — the SCENE half of wall-mounted turrets: seating a gun on every armed span, keeping it
// dormant until the base wakes, and the rule that breaching a span destroys the gun riding on it.
// The pure placement/geometry half is in data/wallTurretPlacement.test.js.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection throws
// under vitest's node env, so it's stubbed out (same convention as dormantWake.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { BasesMixin } from './bases.js';
import { WorldMixin } from './world.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { AWARE, DORMANT, detectionRangeFor } from '../../data/awareness.js';
import { hexToPixel } from '../../data/hexgrid.js';
import {
  makeWallEdgeSet, spanTurretMount, SPAN_ROLE_TURRET, SPAN_ROLE_GATE, SPAN_ROLE_WALL,
} from '../../data/wallEdges.js';

const ARMED = { a: { q: 0, r: 0 }, b: { q: 1, r: 0 }, baseId: 'base0', role: SPAN_ROLE_TURRET };
const PLAIN = { a: { q: 0, r: 0 }, b: { q: 0, r: 1 }, baseId: 'base0', role: SPAN_ROLE_WALL };
const GATE = { a: { q: 0, r: 0 }, b: { q: -1, r: 1 }, baseId: 'base0', role: SPAN_ROLE_GATE };

function makeScene(defs = [ARMED, PLAIN, GATE]) {
  const scene = {
    time: { now: 0 }, enemies: [], px: 0, py: 0,
    bases: [{ id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [] }],
    alertTowerHexes: [], terrain: new Map(), worldRadius: 20,
    buildingHp: new Map(), coverHp: new Map(), tileImages: new Map(),
    wallEdges: makeWallEdgeSet(defs),
    enemyMove: true, enemyFire: true,
    _blocked: () => false,
    _blockedByOtherGroundUnit: () => false,
    _speedFactorAt: () => 1,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: vi.fn(),
    // World-side FX/redraw stubs — `_damageWallEdge` is the REAL implementation under test.
    _redrawWallEdges: () => {},
    _outpostCollapseFx: () => {},
    _invalidateVisibility: () => {},
    // The real `_damageEnemyAt` is in combat.js and drags in FX/audio; this stand-in applies the
    // damage through the SAME `applyDamage` path (which spends armor first) so the toughness-vs-hp
    // distinction the #287 bug turned on is faithfully reproduced.
    _damageEnemyAt: vi.fn((e, x, y, dmg) => { e.mech.applyDamage(e.mech.locations()[0], dmg); }),
  };
  Object.assign(scene, EnemiesMixin, BasesMixin, WorldMixin);
  // AFTER the mixins: `_damageWallEdge` is the real implementation under test, but the FX and
  // redraw it calls out to need Phaser (`this.add.circle`), so they stay stubbed.
  scene._redrawWallEdges = () => {};
  scene._outpostCollapseFx = () => {};
  scene._invalidateVisibility = () => {};
  // Likewise a mixin method, so the spy has to be (re)installed after the assign or the real
  // implementation wins and the firing assertions below silently test nothing.
  scene._fireVehicleWeapon = vi.fn();
  // Same reason: the real `_cachedLosToPlayer` wants a fully-built world (LOS cache, tile map,
  // visibility mixin) that this harness deliberately doesn't have. The gun's actual firing LANE
  // — specifically the question of whether its own wall blinds it — is pinned precisely, against
  // real geometry, in data/wallTurretPlacement.test.js §2b; here LOS is held true so these tests
  // isolate the wake -> engage wiring.
  scene._cachedLosToPlayer = () => true;
  scene._initAlertTowers();
  scene._spawnKind = (x, y, kindId) => {
    const def = ENEMY_KINDS[kindId];
    const e = {
      key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
      x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId, handed: 1,
      behavior: def.behavior,
      view: { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { rotation: 0 }, shadow: null },
      detectRange: detectionRangeFor(def.fireRange),
    };
    scene.enemies.push(e);
    return e;
  };
  return scene;
}

const wallGuns = (scene) => scene.enemies.filter((e) => e.typeId === 'wallTurret');

describe('#310 §1: seating a gun on every armed span', () => {
  it('spawns exactly one Wall Lance per turret span — and none on plain or gate spans', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const guns = wallGuns(scene);
    expect(guns.length).toBe(1);
    const armedKey = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET).key;
    expect(guns[0].spanKey).toBe(armedKey);
  });

  it('scales to however many spans are armed', () => {
    const scene = makeScene([
      ARMED,
      { a: { q: 0, r: 0 }, b: { q: 0, r: -1 }, baseId: 'base0', role: SPAN_ROLE_TURRET },
      { a: { q: 0, r: 0 }, b: { q: -1, r: 0 }, baseId: 'base0', role: SPAN_ROLE_TURRET },
      PLAIN, GATE,
    ]);
    scene._spawnDormantUnits();
    expect(wallGuns(scene).length).toBe(3);
    // Each gun on its OWN span — no two share a key.
    expect(new Set(wallGuns(scene).map((e) => e.spanKey)).size).toBe(3);
  });

  it('seats the gun at its span\'s CENTRED mount point, and marks it `emplaced`', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    const m = spanTurretMount(edge);
    expect(gun.x).toBeCloseTo(m.x, 5);
    expect(gun.y).toBeCloseTo(m.y, 5);
    // #310 (owner, 2026-07-19): centred ON the wall line, not outboard of it — the gun covers
    // ground on BOTH sides of the wall. Pinned here as well as in the pure geometry suite because
    // it is the scene that decides where the unit actually stands.
    expect(gun.x).toBeCloseTo((edge.x0 + edge.x1) / 2, 5);
    expect(gun.y).toBeCloseTo((edge.y0 + edge.y1) / 2, 5);
    // Without `emplaced` the #115 "recover a unit stranded on impassable terrain" snap-back would
    // shove the gun off its own parapet on the first frame — and now that it is seated ON the band
    // rather than 13px clear of it, that snap-back would trigger every single frame.
    expect(gun.emplaced).toBe(true);
  });

});

// #310 (owner, playtest 2026-07-19: "centered on the wall so they can shoot inside OR outside").
// The rest of this file holds LOS true to isolate the wake wiring; this block deliberately runs the
// REAL `_cachedLosToPlayer`/`_wallDistanceLos`/`_wallEdgeDistance` chain against real ring geometry,
// because the whole point of the change is which side of the wall a gun can see — and the answer
// depends on the shooter's `spanKey` being threaded all the way down into `wallEdgeCrossing`.
describe('#310 §1b: a centred gun engages BOTH sides of its wall', () => {
  const losFrom = (scene, gun, tx, ty) => {
    const dist = Math.hypot(tx - gun.x, ty - gun.y);
    const bearing = Math.atan2(ty - gun.y, tx - gun.x);
    delete gun._losCd;                       // force a fresh, un-staggered recompute
    scene._cachedLosToPlayer(gun, 10_000, gun.x, gun.y, bearing, dist, tx, ty, false);
    return gun._losClear;
  };

  function realLosScene() {
    const scene = makeScene();
    delete scene._cachedLosToPlayer;         // fall through to the real WorldMixin implementation
    Object.assign(scene, WorldMixin);
    scene._redrawWallEdges = () => {};
    scene._outpostCollapseFx = () => {};
    scene._invalidateVisibility = () => {};
    scene._spawnDormantUnits();
    return scene;
  }

  it('sees a target OUTSIDE the ring, past the span it is bolted to', () => {
    const scene = realLosScene();
    const gun = wallGuns(scene)[0];
    const c = hexToPixel(0, 0);
    const ux = gun.x - c.x, uy = gun.y - c.y;
    const len = Math.hypot(ux, uy) || 1;
    expect(losFrom(scene, gun, gun.x + (ux / len) * 400, gun.y + (uy / len) * 400)).toBe(true);
  });

  it('sees a target INSIDE the compound — the breaching player gets no reprieve', () => {
    // The practical fix the owner asked for. Before centring, the gun sat outboard and its own
    // wall blocked every inward lane, so a player who was through the ring was safe from it.
    const scene = realLosScene();
    const gun = wallGuns(scene)[0];
    const c = hexToPixel(0, 0);
    expect(losFrom(scene, gun, c.x, c.y)).toBe(true);
  });

  it('is still blocked by a DIFFERENT span — the exemption is its own wall only', () => {
    // A second ring span placed squarely across an inward lane must still stop the gun, or the
    // exemption has degenerated into "wall turrets shoot through walls".
    const scene = realLosScene();
    const gun = wallGuns(scene)[0];
    const other = [...scene.wallEdges.edges.values()].find((e) => e.key !== gun.spanKey);
    const target = { x: (other.x0 + other.x1) / 2, y: (other.y0 + other.y1) / 2 };
    // Aim a little PAST that other span's midpoint so the lane genuinely crosses it.
    const tx = gun.x + (target.x - gun.x) * 1.6, ty = gun.y + (target.y - gun.y) * 1.6;
    expect(losFrom(scene, gun, tx, ty)).toBe(false);
  });

  it('an ordinary ground unit gets no exemption at all (no spanKey ⇒ its own walls still blind it)', () => {
    const scene = realLosScene();
    const gun = wallGuns(scene)[0];
    const bystander = { ...gun, spanKey: undefined };
    delete bystander._losCd;
    const c = hexToPixel(0, 0);
    const dist = Math.hypot(c.x - bystander.x, c.y - bystander.y);
    scene._cachedLosToPlayer(bystander, 10_000, bystander.x, bystander.y,
      Math.atan2(c.y - bystander.y, c.x - bystander.x), dist, c.x, c.y, false);
    expect(bystander._losClear).toBe(false);
  });
});

describe('#310 §2: DORMANT until the base wakes', () => {
  it('spawns dormant, belonging to its span\'s base', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    expect(gun.awareness).toBe(DORMANT);
    expect(gun.baseId).toBe('base0');
  });

  it('holds fire while dormant — no sniping from a base you have not woken', () => {
    // THE case the dormancy choice exists for, and the exact reason an always-on wall gun was
    // rejected. The player sits 600px out: comfortably inside the Wall Lance's 900px envelope, but
    // OUTSIDE the 320px proximity-wake cap (#283 PROXIMITY_WAKE_RANGE_CAP), so the base is still
    // genuinely asleep. An always-on turret would open fire here — from a fortress that the HUD,
    // the win condition and every other unit inside it still consider dormant.
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    scene.px = gun.x + 600; scene.py = gun.y;
    for (let i = 0; i < 60; i++) { scene.time.now += 16; scene._updateEnemy(gun, 16); }
    expect(gun.awareness).toBe(DORMANT);
    expect(scene._fireVehicleWeapon).not.toHaveBeenCalled();
  });

  it('still wakes on close proximity like any other dormant unit', () => {
    // The complement of the above: dormancy is the standard model, not a special mute button —
    // walking up to the wall wakes the gun through the same #283 path everything else uses.
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    scene.px = gun.x + 60; scene.py = gun.y;
    for (let i = 0; i < 10; i++) { scene.time.now += 16; scene._updateEnemy(gun, 16); }
    expect(gun.awareness).toBe(AWARE);
  });

  it('wakes with the rest of the base through `_wakeBase`, then engages', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    scene._wakeBase('base0');
    expect(gun.awareness).toBe(AWARE);
    // Once awake and with the player in range/LOS, it fires. `reactDelayMs` staggers the first
    // reaction, so tick past it rather than expecting fire on frame one.
    scene.px = gun.x + 600; scene.py = gun.y;
    gun.reactDelayMs = 0;
    for (let i = 0; i < 240 && !scene._fireVehicleWeapon.mock.calls.length; i++) {
      scene.time.now += 16;
      scene._updateEnemy(gun, 16);
    }
    expect(scene._fireVehicleWeapon).toHaveBeenCalled();
  });
});

describe('#310 §3: destroying the span destroys its turret (#287\'s precedent)', () => {
  it('breaching an armed span kills the gun riding on it', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    expect(gun.mech.isDestroyed()).toBe(false);
    const destroyed = scene._damageWallEdge(edge, edge.maxHp);
    expect(destroyed).toBe(true);
    expect(gun.mech.isDestroyed()).toBe(true);
  });

  it('the kill bites for FULL TOUGHNESS, not hp — armor must not save it', () => {
    // #287's hard-won bug, restated for this kind because it carries the same #299 armor pool.
    // `_damageEnemyAt` routes through `applyDamage`, which spends ARMOR FIRST, so an `hp + 1`
    // bite (35 + 1) would be entirely absorbed by the 15 armor and leave the gun alive and firing
    // on top of a span that no longer exists. This asserts the ACTUAL amount requested, so the
    // regression is caught even if a future stub changes how damage is applied.
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const def = ENEMY_KINDS.wallTurret;
    expect(def.armor).toBeGreaterThan(0);                        // the precondition for the bug
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    scene._damageWallEdge(edge, edge.maxHp);
    const [, , , dmg] = scene._damageEnemyAt.mock.calls[0];
    expect(dmg).toBeGreaterThan(def.hp + def.armor);             // > toughness, not > hp
    expect(dmg).toBeGreaterThan(gun.mech.maxHp + def.armor);
  });

  it('breaching a DIFFERENT span leaves the gun untouched', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const plain = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_WALL);
    scene._damageWallEdge(plain, plain.maxHp);
    expect(plain.destroyed).toBe(true);
    expect(gun.mech.isDestroyed()).toBe(false);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
  });

  it('merely damaging an armed span does not hurt the gun', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    expect(scene._damageWallEdge(edge, edge.maxHp - 1)).toBe(false);
    expect(gun.mech.isDestroyed()).toBe(false);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
  });

  it('is idempotent — a second collapse of the same span does not re-kill', () => {
    const scene = makeScene();
    scene._spawnDormantUnits();
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    scene._damageWallEdge(edge, edge.maxHp);
    const callsAfterFirst = scene._damageEnemyAt.mock.calls.length;
    scene._damageWallEdge(edge, edge.maxHp);
    expect(scene._damageEnemyAt.mock.calls.length).toBe(callsAfterFirst);
  });

  it('shooting the GUN down leaves the span standing — two separate health pools', () => {
    // The converse of the rule above, and the reason both are worth having: the span's 200 and the
    // unit's 35+15 are independent, and killing either removes the emplacement from the fight
    // without the other vanishing.
    const scene = makeScene();
    scene._spawnDormantUnits();
    const gun = wallGuns(scene)[0];
    const edge = [...scene.wallEdges.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    gun.mech.applyDamage(gun.mech.locations()[0], gun.mech.toughness + 1);
    expect(gun.mech.isDestroyed()).toBe(true);
    expect(edge.destroyed).toBe(false);
    expect(edge.hp).toBe(edge.maxHp);
  });
});
