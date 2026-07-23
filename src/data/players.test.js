// #347 — the pure players collection. These tests exist because phase 1's whole claim is
// "nothing changes with one player, and the questions become answerable for more than one."
// Both halves are asserted here: an N=1 identity case next to every N>1 case.
import { describe, it, expect } from 'vitest';
import {
  makePlayer, playerAlive, livePlayers, anyPlayerAlive, allPlayersDead,
  nearestPlayer, primaryPlayer, playersCentroid, showsPlayerColor,
  PLAYER_COLORS, playerAccent, playerColor,
} from './players.js';

const liveMech = () => ({ isDestroyed: () => false });
const deadMech = () => ({ isDestroyed: () => true });

describe('makePlayer', () => {
  it('carries every field the arena singleton used to hold on the scene', () => {
    const p = makePlayer({ id: 3, mech: liveMech(), x: 10, y: 20 });
    expect(p).toMatchObject({
      id: 3, x: 10, y: 20, vx: 0, vy: 0, speed: 0,
      stepMs: 0, hullFrame: 0, view: null, dead: false, textureKey: 'playerMech',
    });
    // The deploy defaults the arena relies on (legs facing up, aim point ahead).
    expect(p.angle).toBeCloseTo(-Math.PI / 2);
    expect(p.turretAngle).toBeCloseTo(-Math.PI / 2);
  });

  it('makes independent players — no shared state between two of them', () => {
    const a = makePlayer({ id: 0 });
    const b = makePlayer({ id: 1 });
    a.x = 500;
    expect(b.x).toBe(0);
  });
});

describe('playerAlive', () => {
  it('is alive until either the latch flips or the mech is destroyed', () => {
    expect(playerAlive(makePlayer({ mech: liveMech() }))).toBe(true);
    expect(playerAlive({ ...makePlayer({ mech: liveMech() }), dead: true })).toBe(false);
    expect(playerAlive(makePlayer({ mech: deadMech() }))).toBe(false);
  });

  it('treats a mech-less player as live, so a half-built test double is not a corpse', () => {
    expect(playerAlive(makePlayer({}))).toBe(true);
  });

  it('is false for null/undefined rather than throwing', () => {
    expect(playerAlive(null)).toBe(false);
    expect(playerAlive(undefined)).toBe(false);
  });
});

describe('livePlayers / anyPlayerAlive', () => {
  it('filters out the downed', () => {
    const a = makePlayer({ id: 0, mech: liveMech() });
    const b = makePlayer({ id: 1, mech: deadMech() });
    expect(livePlayers([a, b])).toEqual([a]);
    expect(anyPlayerAlive([a, b])).toBe(true);
    expect(anyPlayerAlive([b])).toBe(false);
  });

  it('handles a missing collection without throwing', () => {
    expect(livePlayers(undefined)).toEqual([]);
    expect(anyPlayerAlive(undefined)).toBe(false);
  });
});

describe('allPlayersDead — what ends a run (#347, replacing `this.mech.isDestroyed()`)', () => {
  it('one player: exactly the old single-mech check', () => {
    expect(allPlayersDead([makePlayer({ mech: liveMech() })])).toBe(false);
    expect(allPlayersDead([makePlayer({ mech: deadMech() })])).toBe(true);
  });

  it('two players: NOT over while either is still standing', () => {
    const a = makePlayer({ id: 0, mech: deadMech() });
    const b = makePlayer({ id: 1, mech: liveMech() });
    expect(allPlayersDead([a, b])).toBe(false);
    expect(allPlayersDead([a, makePlayer({ id: 1, mech: deadMech() })])).toBe(true);
  });

  it('an EMPTY collection is not "all dead" — nobody must never end a run', () => {
    expect(allPlayersDead([])).toBe(false);
    expect(allPlayersDead(undefined)).toBe(false);
  });
});

describe('nearestPlayer — the phase-2 enemy-targeting rule, live today', () => {
  it('with ONE player it is unconditionally that player, whatever the query point', () => {
    const only = makePlayer({ id: 0, mech: liveMech(), x: 900, y: -400 });
    for (const [x, y] of [[0, 0], [1e6, 1e6], [-50, 7], [900, -400]]) {
      expect(nearestPlayer([only], x, y)).toBe(only);
    }
  });

  it('picks the closer of two', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 100, y: 0 });
    expect(nearestPlayer([a, b], 10, 0)).toBe(a);
    expect(nearestPlayer([a, b], 90, 0)).toBe(b);
    expect(nearestPlayer([a, b], 50.1, 0)).toBe(b);
  });

  it('prefers a LIVE player over a nearer corpse — enemies fight the living', () => {
    const corpse = makePlayer({ id: 0, mech: deadMech(), x: 0, y: 0 });
    const alive = makePlayer({ id: 1, mech: liveMech(), x: 500, y: 0 });
    expect(nearestPlayer([corpse, alive], 1, 0)).toBe(alive);
  });

  it('falls back to the nearest corpse when everyone is down, so position queries still work', () => {
    const a = makePlayer({ id: 0, mech: deadMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: deadMech(), x: 100, y: 0 });
    expect(nearestPlayer([a, b], 95, 0)).toBe(b);
  });

  it('is null only for an empty collection', () => {
    expect(nearestPlayer([], 0, 0)).toBe(null);
    expect(nearestPlayer(undefined, 0, 0)).toBe(null);
  });
});

describe('primaryPlayer / playersCentroid', () => {
  it('primary is the local player', () => {
    const a = makePlayer({ id: 0 }); const b = makePlayer({ id: 1 });
    expect(primaryPlayer([a, b])).toBe(a);
    expect(primaryPlayer([])).toBe(null);
  });

  it('centroid of one player IS that player — so the camera cannot move this phase', () => {
    const only = makePlayer({ id: 0, mech: liveMech(), x: 123, y: -45 });
    expect(playersCentroid([only])).toEqual({ x: 123, y: -45 });
  });

  it('centroid of two is the midpoint, and ignores the downed', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 100, y: 40 });
    expect(playersCentroid([a, b])).toEqual({ x: 50, y: 20 });
    const dead = makePlayer({ id: 2, mech: deadMech(), x: 1000, y: 1000 });
    expect(playersCentroid([a, b, dead])).toEqual({ x: 50, y: 20 });
  });
});

// #348 playtest follow-up: "we don't need the color ring around player 1 when there isn't any
// second player". The identifying colour only means something once there is somebody to be told
// apart from — this one rule now backs BOTH the ground ring and the reticle tint.
describe('showsPlayerColor', () => {
  it('is off for a solo player and on once a second joins', () => {
    expect(showsPlayerColor(0)).toBe(false);
    expect(showsPlayerColor(1)).toBe(false);
    expect(showsPlayerColor(2)).toBe(true);
    expect(showsPlayerColor(3)).toBe(true);
  });

  it('is a function of the CURRENT count, so a mid-sortie join flips it both ways', () => {
    const players = [makePlayer({ id: 0, mech: liveMech() })];
    expect(showsPlayerColor(players.length)).toBe(false);
    players.push(makePlayer({ id: 1, mech: liveMech() }));   // START on gamepad 2
    expect(showsPlayerColor(players.length)).toBe(true);
    players.pop();
    expect(showsPlayerColor(players.length)).toBe(false);
  });
});

// #404: the player palette must not read as any of the game's other coloured signals. The old set
// literally WAS three weapon-category muzzle cores (gold = ballistic, which is what Jackson
// noticed), so this pins the new one against every colour vocabulary already on screen: muzzle
// glows, powerup pickups, and enemy kind accents. The bar is a hue+tone distance, not just
// "different number" — two colours 3° apart are the same colour in a firefight.
describe('PLAYER_COLORS are clash-proof against every other colour in play (#404)', () => {
  // 0xRRGGBB → { h: 0..360, s: 0..1, l: 0..1 }
  const hsl = (c) => {
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
  };
  const hueGap = (a, b) => { const d = Math.abs(hsl(a).h - hsl(b).h) % 360; return Math.min(d, 360 - d); };
  // "Confusable" = close in hue AND close in tone (lightness × saturation). A drab olive body
  // accent and a vivid lime rim share a hue family but never read as the same marking.
  const confusable = (a, b) => {
    if (hueGap(a, b) > 20) return false;
    const A = hsl(a), B = hsl(b);
    return Math.abs(A.l - B.l) < 0.18 && Math.abs(A.s - B.s) < 0.3;
  };

  const OTHERS = {
    // Weapon-category muzzle/projectile cores (art/mechPrims.js NEON) — the ones Jackson named.
    ballisticMuzzle: 0xffb24a, energyMuzzle: 0x38d9ff, missileMuzzle: 0xff4fa3,
    supportMuzzle: 0x6dff9e, meleeMuzzle: 0xcfd6e0,
    // Mech reactor glow + the enemy legibility halo / pale ceramic body.
    reactor: 0xb15cff, halo: 0xfbfdff, enemyBody: 0xd3dae2,
    // Powerup pickups (data/powerups.js) — these now own the centre-torso spot, so a player
    // colour must never be mistaken for one.
    overdrive: 0xe2533a, overclock: 0x7bd17b, armorPatch: 0x9fa8b2,
    shield: 0x5ec8e0, infiniteFire: 0x28e0d8, barrage: 0xc06be0,
    // Enemy kind theme accents (data/enemyKinds.js) + the alert/UI reds.
    wallTurretCyan: 0x5ac8e0, tankRust: 0xc65a34, helicopterGold: 0xe0b13a,
    carrierRed: 0xcf4d4d, carrierViolet: 0x8a4fc9, infantryOlive: 0x8fae4a,
    uiWarn: 0xefc14a, uiBad: 0xe2533a,
  };

  it('are four distinct colours, none of them an exact reuse of another signal', () => {
    expect(new Set(PLAYER_COLORS).size).toBe(PLAYER_COLORS.length);
    for (const c of PLAYER_COLORS) expect(Object.values(OTHERS)).not.toContain(c);
  });

  it('are not confusable with any muzzle, powerup or enemy accent', () => {
    const clashes = [];
    for (const [i, c] of PLAYER_COLORS.entries()) {
      for (const [name, other] of Object.entries(OTHERS)) {
        if (confusable(c, other)) clashes.push(`P${i + 1} vs ${name}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('are well separated from EACH OTHER — that is the whole point of them', () => {
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      for (let j = i + 1; j < PLAYER_COLORS.length; j++) {
        expect(hueGap(PLAYER_COLORS[i], PLAYER_COLORS[j])).toBeGreaterThan(40);
      }
    }
  });

  // #404: every player is tinted now (#348 left player 1 null so its art was unchanged).
  it('gives every player, player 1 included, its own rim accent', () => {
    for (let i = 0; i < PLAYER_COLORS.length; i++) expect(playerAccent(i)).toBe(playerColor(i));
  });
});
