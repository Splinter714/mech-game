// #348 (co-op phase 2) — the scene-side seams that only exist once there are two players.
// The RULES are pure and tested in data/leash.test.js, data/respawn.test.js and
// data/players.test.js; what's covered here is the wiring those rules plug into, plus friendly
// fire, which is a routing decision rather than a formula.
import { describe, it, expect, vi } from 'vitest';
import { FiringMixin } from './firing.js';
import { cameraFocusOf, isPlayerRef, otherLivePlayers, targetPlayerFor } from './players.js';
import { MAX_PLAYERS, makePlayer, playerAccent, playerColor } from '../../data/players.js';
import { CoopMixin } from './coop.js';
import { axialKey, hexToPixel, pixelToHex } from '../../data/hexgrid.js';
import { isPassable } from '../../data/terrain.js';
import { readFileSync } from 'node:fs';

const P = (id, x, y) => ({ ...makePlayer({ id, x, y }), mech: { isDestroyed: () => false } });

const twoPlayerScene = (extra = {}) => {
  const a = P(0, 0, 0);
  const b = P(1, 200, 0);
  return {
    players: [a, b], a, b,
    enemies: [],
    ...FiringMixin,
    ...extra,
  };
};

describe('the shared camera frames the centroid, not player 1', () => {
  it('is exactly the player, solo — single-player framing is untouched', () => {
    const solo = { players: [P(0, 120, -40)] };
    expect(cameraFocusOf(solo)).toMatchObject({ x: 120, y: -40 });
  });

  it('sits between two players', () => {
    const scene = twoPlayerScene();
    expect(cameraFocusOf(scene)).toMatchObject({ x: 100, y: 0 });
  });

  it('ignores a downed player, so the camera does not sit on a corpse', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(cameraFocusOf(scene)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('enemies target the NEAREST player (Jackson)', () => {
  it('picks whichever player is closer', () => {
    const scene = twoPlayerScene();
    expect(targetPlayerFor(scene, { x: 190, y: 0 })).toBe(scene.b);
    expect(targetPlayerFor(scene, { x: 10, y: 0 })).toBe(scene.a);
  });

  it('will not target a downed player while a live one exists', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(targetPlayerFor(scene, { x: 199, y: 0 })).toBe(scene.a);
  });
});

describe('friendly fire is ON', () => {
  it('a player is a candidate for another player\'s shot', () => {
    const scene = twoPlayerScene();
    expect(otherLivePlayers(scene, scene.a)).toEqual([scene.b]);
  });

  it('never puts the shooter in their own line of fire', () => {
    const scene = twoPlayerScene();
    expect(otherLivePlayers(scene, scene.a)).not.toContain(scene.a);
  });

  it('is a no-op in single player — there is nobody to hit', () => {
    const solo = { players: [P(0, 0, 0)] };
    expect(otherLivePlayers(solo, null)).toEqual([]);
  });

  it('a downed teammate cannot be shot', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(otherLivePlayers(scene, scene.a)).toEqual([]);
  });

  it('_liveTargetsForTrace offers allies alongside enemies for a player shot', () => {
    const enemy = { x: 500, y: 0, mech: { isDestroyed: () => false } };
    const scene = twoPlayerScene({ enemies: [enemy] });
    const refs = scene._liveTargetsForTrace('player', scene.a).map((c) => c.ref);
    expect(refs).toContain(enemy);
    expect(refs).toContain(scene.b);
    expect(refs).not.toContain(scene.a);
  });

  it('an ENEMY shot still only offers players — allies are a player-side concept', () => {
    const enemy = { x: 500, y: 0, mech: { isDestroyed: () => false } };
    const scene = twoPlayerScene({ enemies: [enemy] });
    const refs = scene._liveTargetsForTrace('enemy').map((c) => c.ref);
    expect(refs).toEqual([scene.a, scene.b]);
  });

  it('routes a player-fired hit on a teammate to the PLAYER damage sink, not the enemy one', () => {
    // The routing decision friendly fire actually turns on: the same shot path must reach a
    // different function depending on WHAT it hit.
    const scene = twoPlayerScene();
    expect(isPlayerRef(scene, scene.b)).toBe(true);
    expect(isPlayerRef(scene, { x: 0, y: 0, mech: {} })).toBe(false);
  });
});

describe('player identification', () => {
  it('gives each player a distinct colour', () => {
    expect(playerColor(0)).not.toBe(playerColor(1));
  });

  it('leaves player 1 art untouched — only later players are tinted', () => {
    expect(playerAccent(0)).toBeNull();
    expect(playerAccent(1)).toBeTruthy();
  });

  it('carries the colour on the player itself, so every draw site reads one source', () => {
    expect(makePlayer({ id: 1 }).color).toBe(playerColor(1));
  });

  // #348 playtest follow-up — no ring when there is nobody to be told apart from. The rule is
  // pure (data/players.js `showsPlayerColor`); what matters HERE is that the marker update
  // re-asks it every frame, so a mid-sortie START join turns the rings on without a redeploy.
  describe('the ground ring only exists once there are two players', () => {
    const marked = (p) => ({ ...p, marker: { visible: true, x: 0, y: 0,
      setPosition(x, y) { this.x = x; this.y = y; return this; },
      setVisible(v) { this.visible = v; return this; } } });

    it('is hidden for a solo player and shown for both after a join', () => {
      const solo = { players: [marked(P(0, 5, 6))], ...CoopMixin };
      solo._updatePlayerMarkers();
      expect(solo.players[0].marker.visible).toBe(false);
      // Still pinned under the mech while hidden, so it is correct the moment it appears.
      expect(solo.players[0].marker).toMatchObject({ x: 5, y: 6 });

      solo.players.push(marked(P(1, 70, 70)));   // START on gamepad 2, mid-sortie
      solo._updatePlayerMarkers();
      expect(solo.players.map((p) => p.marker.visible)).toEqual([true, true]);
    });

    it('still hides a downed player’s ring in co-op', () => {
      const scene = { players: [marked(P(0, 0, 0)), marked(P(1, 200, 0))], ...CoopMixin };
      scene.players[1].dead = true;
      scene._updatePlayerMarkers();
      expect(scene.players.map((p) => p.marker.visible)).toEqual([true, false]);
    });
  });
});

describe('per-player firing state (what phase 1 deliberately left shared)', () => {
  const weapon = (location) => ({
    location, index: 0, ready: true,
    weapon: { id: 'w', location, category: 'ballistic', damage: 1, cycleTime: 500, range: { max: 100 }, delivery: { hit: 'projectile', pattern: 'single' } },
  });

  it('two players hold independent fire cooldowns for the same slot', () => {
    const scene = twoPlayerScene({
      fireWeapon: vi.fn(),
      _fireInterval: () => 500,
      _isHeldBeam: () => false,
      _buffMods: () => ({}),
    });
    scene.a.mech.weapons = () => [weapon('rightArm')];
    scene.b.mech.weapons = () => [weapon('rightArm')];
    const fire = { fire: { rightArm: true } };

    scene._handleFiring(fire, 16, scene.a);
    // Player 1 is now on cooldown; player 2 has never pulled a trigger.
    expect(scene.a.fireCooldowns.rightArm).toBeGreaterThan(0);
    expect(scene.b.fireCooldowns.rightArm ?? 0).toBe(0);

    // ...and player 2 firing does not consume player 1's cooldown, or vice versa.
    scene._handleFiring(fire, 16, scene.b);
    expect(scene.fireWeapon).toHaveBeenCalledTimes(2);
  });

  it('each player converges on its OWN target', () => {
    const scene = twoPlayerScene();
    scene.a.convergeTarget = { x: 1, y: 0 };
    scene.b.convergeTarget = null;
    expect(scene._shotIgnoresCover('player', scene.b)).toBe(false);
    expect(scene.a.convergeTarget).not.toBe(scene.b.convergeTarget);
  });
});

// #348 playtest answer: players collide with each other. The push rule itself is pure and tested
// in data/playerCollision.test.js (including the leash interaction); what is covered here is the
// scene wiring — that the mixin method runs at all, only for live players, and that it clips a
// shove against the world instead of stuffing a mech into a wall.
describe('_separatePlayers — the scene seam for player-vs-player collision', () => {
  const collideScene = (players, blocked = () => false) => Object.assign(
    { players, _blockedAlongSegment: (x0, y0, x1, y1) => blocked(x1, y1) },
    CoopMixin,
  );

  it('is wired into the arena update, between driving and the leash clamp', () => {
    const src = readFileSync(new URL('../ArenaScene.js', import.meta.url), 'utf8');
    const sep = src.indexOf('this._separatePlayers()');
    const leash = src.indexOf('this._updateCoopCamera()');
    expect(sep).toBeGreaterThan(-1);
    expect(sep).toBeLessThan(leash);
  });

  it('pushes two overlapping players apart', () => {
    const scene = collideScene([P(0, 0, 0), P(1, 10, 0)]);
    expect(scene._separatePlayers()).toBe(1);
    expect(Math.hypot(scene.players[0].x - scene.players[1].x, 0)).toBeCloseTo(56, 6);
  });

  it('does nothing in single player', () => {
    expect(collideScene([P(0, 0, 0)])._separatePlayers()).toBe(0);
  });

  it('ignores a downed player — a corpse is not a body to shove', () => {
    const scene = collideScene([P(0, 0, 0), P(1, 10, 0)]);
    scene.players[1].dead = true;
    expect(scene._separatePlayers()).toBe(0);
    expect(scene.players[0].x).toBe(0);
  });

  it('clips the shove against walls, so nobody is pushed into geometry', () => {
    // A wall on the left: any destination with x < -5 is blocked.
    const scene = collideScene([P(0, 0, 0), P(1, 10, 0)], (x) => x < -5);
    scene._separatePlayers();
    expect(scene.players[0].x).toBeGreaterThanOrEqual(-5);
    expect(scene.players[1].x).toBeGreaterThan(10);   // the partner still separates
  });
});

// ── #348 playtest 2026-07-19: "the respawned mech was spawned outside of the corridor in the
// 'impassible terrain'" ── Both co-op placements (respawn, and the mid-sortie START joiner) put a
// mech at a geometric offset with no check that the point was playable ground. Since #340 the
// world is a lane much narrower laterally than the camera view, so those offsets land off-corridor
// routinely. Both must now resolve to somewhere a mech can actually stand.
describe('co-op placement always lands on passable ground (#348)', () => {
  // A #340-shaped corridor in HEX space: a horizontal lane of passable hexes, everything else
  // absent from the map (which `isPassable(undefined)` already treats as impassable, exactly like
  // off-map). Half-width deliberately far smaller than the view.
  const corridorTerrain = (halfWidthRows = 2, length = 60) => {
    const t = new Map();
    for (let q = -length; q <= length; q++) {
      for (let r = -halfWidthRows; r <= halfWidthRows; r++) t.set(axialKey(q, r), 'grass');
    }
    return t;
  };
  const isOn = (terrain, x, y) => {
    const h = pixelToHex(x, y);
    return isPassable(terrain.get(axialKey(h.q, h.r)));
  };

  const arenaScene = (terrain, { view, enemies = [] } = {}) => {
    const a = P(0, 0, 0);
    const b = P(1, 40, 0);
    const scene = {
      players: [a, b], a, b,
      enemies,
      terrain,
      worldRadius: 60,
      allMechs: {},
      time: { now: 0 },
      cameras: { main: { worldView: view ?? { x: -600, y: -400, width: 1200, height: 800 } } },
      ...CoopMixin,
      // Stub the art/audio-touching seams AFTER the mixin — what's under test is placement.
      _floatText: () => {},
      _reskinPlayer: () => {},
      _makePlayerAt: (index, x, y) => ({ ...makePlayer({ id: index, x, y }), mech: { isDestroyed: () => false } }),
      _mechForPlayer: () => ({ isDestroyed: () => false, configureShield: () => {} }),
    };
    return scene;
  };

  it('a respawn never places the mech in impassable terrain, even when the safest edge is', () => {
    const terrain = corridorTerrain();
    // Threat hard against the bottom of the view → the unconstrained rule wants the TOP edge,
    // which in a lane this narrow is well outside the corridor.
    const scene = arenaScene(terrain, { enemies: [{ x: 0, y: 400, mech: { isDestroyed: () => false } }] });
    const p = scene.b;
    p.dead = true;
    p.mech = { isDestroyed: () => false, repairAll: () => {}, tickShield: () => {} };
    scene._respawnPlayer(p);
    expect(isOn(terrain, p.x, p.y)).toBe(true);
    expect(p.dead).toBe(false);
  });

  it('a respawn resolves to passable ground even when the whole view is off-corridor', () => {
    const terrain = corridorTerrain(1);
    // Camera parked entirely above the lane: not one candidate, nor the view centre, is valid —
    // the progressive fallback plus the bounded snap still has to produce a standable point.
    const scene = arenaScene(terrain, { view: { x: -400, y: -900, width: 800, height: 500 } });
    const p = scene.b;
    p.dead = true;
    p.mech = { isDestroyed: () => false, repairAll: () => {}, tickShield: () => {} };
    scene._respawnPlayer(p);
    expect(isOn(terrain, p.x, p.y)).toBe(true);
  });

  it('still prefers the safest side of the view among the points that ARE valid', () => {
    const terrain = corridorTerrain(6);
    // Lane wide enough that both left and right edge midpoints are on ground; threat on the left.
    const scene = arenaScene(terrain, {
      view: { x: -400, y: -100, width: 800, height: 200 },
      enemies: [{ x: -400, y: 0, mech: { isDestroyed: () => false } }],
    });
    const p = scene.b;
    p.dead = true;
    p.mech = { isDestroyed: () => false, repairAll: () => {}, tickShield: () => {} };
    scene._respawnPlayer(p);
    expect(p.x).toBeGreaterThan(0);
    expect(isOn(terrain, p.x, p.y)).toBe(true);
  });

  it('the mid-sortie joiner (START on pad 2) is validated the same way', () => {
    const terrain = corridorTerrain(1);
    const scene = arenaScene(terrain);
    // Host hugging the lane edge, so the fixed +70/+70 drop-in offset lands off-corridor.
    const host = scene.a;
    const edge = hexToPixel(0, 1);
    host.x = edge.x; host.y = edge.y;
    scene.players = [host];
    scene._addPlayer();
    const joiner = scene.players[1];
    expect(joiner).toBeTruthy();
    expect(isOn(terrain, joiner.x, joiner.y)).toBe(true);
  });

  it('is a no-op without terrain, so pre-worldgen/unit-test scenes are unaffected', () => {
    const scene = arenaScene(null);
    expect(scene._validPlayerPos({ x: 12345, y: -999 })).toEqual({ x: 12345, y: -999 });
    expect(scene._isPassablePos(12345, -999)).toBe(true);
  });
});

// #387: the cap rose to four, and players 3 & 4 arrive as mid-sortie drop-ins. The join watcher
// must now watch EVERY unclaimed pad (index >= current player count), not just pad 1, and must
// stop at MAX_PLAYERS. `_addPlayer` is stubbed to just grow the collection — its real placement/
// mech wiring is covered by the "co-op placement" suite above; what's under test here is the scan.
describe('mid-sortie drop-in join watches every unclaimed pad up to the cap (#387)', () => {
  const joinScene = (playerCount, pressedPads) => {
    const set = new Set(pressedPads);
    const players = [];
    for (let i = 0; i < playerCount; i++) players.push(P(i, i * 50, 0));
    const joinEdges = {};
    for (let pad = 1; pad < MAX_PLAYERS; pad++) joinEdges[pad] = { pressed: () => set.has(pad) };
    return Object.assign({}, CoopMixin, {
      players,
      _joinEdges: joinEdges,
      _addPlayer() { this.players.push(P(this.players.length, 0, 0)); },
    });
  };

  it('the cap is four', () => {
    expect(MAX_PLAYERS).toBe(4);
  });

  it('adds a player when START is pressed on pad 2 (the third player)', () => {
    const scene = joinScene(2, [2]);
    scene._updateCoopJoin();
    expect(scene.players.length).toBe(3);
  });

  it('adds a player when START is pressed on pad 3 (the fourth player)', () => {
    const scene = joinScene(3, [3]);
    scene._updateCoopJoin();
    expect(scene.players.length).toBe(4);
  });

  it('ignores START on an already-claimed pad', () => {
    // Two players (pads 0 & 1 claimed); pressing pad 1 again must not add anyone.
    const scene = joinScene(2, [1]);
    scene._updateCoopJoin();
    expect(scene.players.length).toBe(2);
  });

  it('adds at most one player per frame even when several pads are pressed', () => {
    const scene = joinScene(1, [1, 2, 3]);
    scene._updateCoopJoin();
    expect(scene.players.length).toBe(2);
  });

  it('stops at MAX_PLAYERS — a fourth join is the last, a fifth never happens', () => {
    const scene = joinScene(1, [1, 2, 3]);
    // One frame each fills the roster to four, then further frames are inert.
    for (let i = 0; i < 6; i++) scene._updateCoopJoin();
    expect(scene.players.length).toBe(MAX_PLAYERS);
  });

  it('is a no-op with no join watcher (pre-init / non-coop scenes)', () => {
    const scene = Object.assign({ players: [P(0, 0, 0)], _joinEdges: null }, CoopMixin);
    expect(() => scene._updateCoopJoin()).not.toThrow();
    expect(scene.players.length).toBe(1);
  });
});

// #348 playtest 2026-07-19: the leash dragged players through corridor boundaries and base walls.
// The RULE is tested in data/leash.test.js; what matters here is that the arena actually HANDS the
// clamp its collision test — the bug was precisely that it did not.
describe('the leash clamp is wired to the wall sweep (#348)', () => {
  const leashScene = (blocked) => ({
    players: [
      { ...makePlayer({ id: 0, x: -400, y: 0 }), mech: { isDestroyed: () => false } },
      { ...makePlayer({ id: 1, x: 400, y: 0 }), mech: { isDestroyed: () => false } },
    ],
    _camAnchor: { x: 0, y: 0, setPosition(x, y) { this.x = x; this.y = y; } },
    _blockedAlongSegment: (x0, y0, x1, y1) => blocked(x1, y1),
    ...CoopMixin,
  });

  it('does not pull a player through a wall', () => {
    // A wall at x = 350 the trailing player is standing behind.
    const scene = leashScene((x) => x < 350);
    scene._updateCoopCamera();
    expect(scene.players[1].x).toBeGreaterThanOrEqual(350);
  });

  it('still clamps normally where nothing blocks', () => {
    const scene = leashScene(() => false);
    scene._updateCoopCamera();
    expect(Math.abs(scene.players[1].x)).toBeLessThanOrEqual(281);
  });

  it('the shared camera tolerates the transient overshoot a blocked clamp leaves', () => {
    const scene = leashScene((x) => x < 350);
    scene._updateCoopCamera();
    // Framing still lands on the (clamped-as-far-as-possible) centroid rather than throwing or
    // chasing a position nobody occupies.
    const cx = (scene.players[0].x + scene.players[1].x) / 2;
    expect(scene._camAnchor.x).toBeCloseTo(cx, 6);
  });
});
