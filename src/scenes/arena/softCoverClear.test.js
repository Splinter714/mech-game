// #405 — soft cover is DESTRUCTIBLE AGAIN, but ONLY by the shots the foliage CATCHES (the #374
// block roll). The pure rule (the cleared-ground mapping + the tunable clear-HP) lives in
// data/terrain.js; the scene wiring — a separate `softCoverHp` map, the `_damageSoftCoverHex`
// transition, and the caught-shot sites in projectiles.js/firing.js — lives here.
//
// Four things have to hold, and this file pins each:
//   1. a cleared thicket becomes plain OPEN GROUND, not a distinct rubble tile, and stops being
//      cover (`clearedSoftCoverFor` + `isSoftCover`);
//   2. the clear-HP is LOW so a couple of caught shots flatten a hex (the owner's tuning call);
//   3. `_damageSoftCoverHex` chips a hex's clear-HP and, at 0, clears it — and is a no-op on any
//      hex that isn't standing soft cover (so it can never touch a targetable outpost);
//   4. it fires at the real caught-shot sites, for ENEMY fire exactly as for the player's, and
//      NEVER makes soft cover a targeting candidate (it's not in buildingHp/coverHp).
import { describe, it, expect } from 'vitest';
import { CombatMixin } from './combat.js';
import { ProjectilesMixin } from './projectiles.js';
import { WorldMixin } from './world.js';
import {
  isSoftCover, clearedSoftCoverFor, SOFT_COVER_CLEAR_HP, SOFT_COVER_CATCH_DAMAGE,
} from '../../data/terrain.js';
import { makeProjectile } from '../../data/delivery.js';
import { makeWallEdgeSet } from '../../data/wallEdges.js';
import { WEAPONS } from '../../data/weapons.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';

const FOREST = { q: 3, r: 0 };
const KEY = axialKey(FOREST.q, FOREST.r);
const FCENTRE = hexToPixel(FOREST.q, FOREST.r);

// ── 1. the cleared-ground mapping ──────────────────────────────────────────────────────────
describe('#405 clearedSoftCoverFor — a cleared thicket becomes plain open ground', () => {
  const cases = { forest: 'grass', scrub: 'sand', drift: 'snow', wreck: 'pavement', fumarole: 'ash' };
  for (const [soft, ground] of Object.entries(cases)) {
    it(`${soft} clears to ${ground}, which is no longer soft cover`, () => {
      expect(clearedSoftCoverFor(soft)).toBe(ground);
      expect(isSoftCover(clearedSoftCoverFor(soft))).toBe(false);
    });
  }
  it('returns null for anything that is not soft cover', () => {
    expect(clearedSoftCoverFor('grass')).toBeNull();     // already open ground
    expect(clearedSoftCoverFor('objective')).toBeNull(); // a targetable hard structure
    expect(clearedSoftCoverFor(undefined)).toBeNull();
  });
});

// ── 2. the tuning ──────────────────────────────────────────────────────────────────────────
describe('#405 clear-HP constants — low, so a couple of caught shots flatten a hex', () => {
  it('clears in a small number of caught shots (owner: keep it fast to blast down)', () => {
    const catches = Math.ceil(SOFT_COVER_CLEAR_HP / SOFT_COVER_CATCH_DAMAGE);
    expect(catches).toBeGreaterThanOrEqual(1);
    expect(catches).toBeLessThanOrEqual(3);
  });
});

// ── 3. the transition ──────────────────────────────────────────────────────────────────────
function makeWorld() {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  terrain.set(KEY, 'forest');
  return Object.assign({}, WorldMixin, {
    terrain,
    softCoverHp: new Map([[KEY, SOFT_COVER_CLEAR_HP]]),
  });
}

describe('#405 _damageSoftCoverHex — caught shots wear a hex down, then clear it', () => {
  it('a partial hit reduces HP but leaves the hex standing soft cover', () => {
    const s = makeWorld();
    expect(s._damageSoftCoverHex(KEY, 10)).toBe(false);
    expect(s.softCoverHp.get(KEY)).toBe(SOFT_COVER_CLEAR_HP - 10);
    expect(isSoftCover(s.terrain.get(KEY))).toBe(true);
  });

  it('enough damage clears it to open ground and it stops being cover', () => {
    const s = makeWorld();
    expect(s._damageSoftCoverHex(KEY, SOFT_COVER_CLEAR_HP)).toBe(true);
    expect(s.terrain.get(KEY)).toBe('grass');
    expect(isSoftCover(s.terrain.get(KEY))).toBe(false);
    expect(s.softCoverHp.has(KEY)).toBe(false);     // no longer a standing soft-cover hex
  });

  it('two caught shots at the tuned per-catch damage flatten a hex', () => {
    const s = makeWorld();
    const catches = Math.ceil(SOFT_COVER_CLEAR_HP / SOFT_COVER_CATCH_DAMAGE);
    let cleared = false;
    for (let i = 0; i < catches; i++) cleared = s._damageSoftCoverHex(KEY);   // default = per-catch dmg
    expect(cleared).toBe(true);
    expect(isSoftCover(s.terrain.get(KEY))).toBe(false);
  });

  it('is a no-op on a hex with no clear-HP (never soft cover, or already cleared)', () => {
    const s = makeWorld();
    expect(s._damageSoftCoverHex(axialKey(0, 0))).toBe(false);       // plain grass, never seeded
    s._damageSoftCoverHex(KEY, SOFT_COVER_CLEAR_HP);                 // clear the forest hex
    expect(s._damageSoftCoverHex(KEY)).toBe(false);                 // already gone → nothing to chip
  });
});

// ── 4. the wiring: caught shots at the real sites, symmetric, and never a target ────────────
function makeArena({ roll = 0.05 } = {}) {   // 0.05 < 0.10 flat per-hex chance ⇒ the foliage eats it
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  terrain.set(KEY, 'forest');
  return Object.assign({}, WorldMixin, CombatMixin, ProjectilesMixin, {
    terrain,
    buildingHp: new Map(), coverHp: new Map(),
    softCoverHp: new Map([[KEY, SOFT_COVER_CLEAR_HP]]),
    wallEdges: makeWallEdgeSet([]),
    enemies: [], projectiles: [], firePatches: [],
    players: [{ id: 'p1', x: 0, y: 0, mech: { isDestroyed: () => false } }],
    projFx: { clear: () => {} },
    _drawProjectile: () => {},
    _impactFx: () => {},
    _damageEnemyAt: () => {},
    _damagePlayerAt: () => {},
    _rangeFactor: () => 1,
    _buildEnemyIndex: () => ({ nearest: () => null }),   // no target: firing into empty woods
    _coverRng: () => roll,
  });
}

function fireRound(s, to, owner = 'player', { maxDist = 900 } = {}) {
  const round = makeProjectile(WEAPONS.autocannon, 0, 0, Math.atan2(to.y, to.x), { maxDist });
  Object.assign(round, {
    owner, trail: [], seekTarget: null,
    originHexes: [s._hexKeyAt(0, 0)], targetHexKey: null,
    originX: 0, originY: 0, _lastHexKey: s._hexKeyAt(0, 0), airTarget: false,
  });
  s.projectiles = [round];
  for (let i = 0; i < 400 && !round.dead; i++) s._updateProjectiles(0.016);
  return round;
}

describe('#405 wiring: a caught round chips the hex it was caught in', () => {
  it('a PLAYER round caught in flight chips the forest hex clear-HP', () => {
    const s = makeArena({ roll: 0.05 });
    const round = fireRound(s, FCENTRE);
    expect(round.dead).toBe(true);                                  // eaten in the trees
    expect(s.softCoverHp.get(KEY)).toBe(SOFT_COVER_CLEAR_HP - SOFT_COVER_CATCH_DAMAGE);
  });

  it('an ENEMY round caught in flight chips it identically (symmetric — never reads who fired)', () => {
    const s = makeArena({ roll: 0.05 });
    // An enemy fires from the origin at the player, who stands BEYOND the forest — so the round
    // crosses the forest hex (and is caught there) on its way, rather than resolving on a player
    // sitting at the muzzle. The nearest-player target is read off `scene.players`.
    const beyond = hexToPixel(7, 0);
    s.players = [{ id: 'p1', x: beyond.x, y: beyond.y, mech: { isDestroyed: () => false } }];
    fireRound(s, beyond, 'enemy', { maxDist: 4000 });
    expect(s.softCoverHp.get(KEY)).toBe(SOFT_COVER_CLEAR_HP - SOFT_COVER_CATCH_DAMAGE);
  });

  it('successive caught rounds flatten the hex to open ground', () => {
    const s = makeArena({ roll: 0.05 });
    const catches = Math.ceil(SOFT_COVER_CLEAR_HP / SOFT_COVER_CATCH_DAMAGE);
    for (let i = 0; i < catches; i++) fireRound(s, FCENTRE);
    expect(s.terrain.get(KEY)).toBe('grass');
    expect(isSoftCover(s.terrain.get(KEY))).toBe(false);
    expect(s.softCoverHp.has(KEY)).toBe(false);
  });

  it('a round that passes through on the OPEN dice never chips the hex', () => {
    const s = makeArena({ roll: 0.9 });                            // 0.9 >= 0.10 ⇒ never caught
    fireRound(s, FCENTRE, 'player', { maxDist: 4000 });
    expect(s.softCoverHp.get(KEY)).toBe(SOFT_COVER_CLEAR_HP);      // untouched
  });

  it('soft cover never becomes a targeting candidate — it is absent from both HP maps', () => {
    const s = makeArena();
    expect(s.buildingHp.has(KEY)).toBe(false);
    expect(s.coverHp.has(KEY)).toBe(false);
    expect(s._destructibleStandingAt(KEY)).toBe(false);   // targeted-hex/lock rule can never pick it
  });
});
