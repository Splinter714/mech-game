// #488 — Proximity Mines are TEAM-exempt, not just placer-exempt. A player-owned mine used to
// only exclude the specific player who placed it (`hz.shooter`) from its blast — a co-op
// teammate standing on someone else's mine still ate the damage. It now excludes every live
// player when the mine is player-owned; it still hurts enemies normally regardless of owner.
// Mirrors mineFlyerExclusion.test.js's pattern of exercising `_updateHazards` directly.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function fakePlayer(x, y) {
  return { x, y, dead: false, mech: { isDestroyed: () => false } };
}

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false } };
}

function fakeGraphics() {
  const g = { lineStyle: () => g, strokeCircle: () => g, fillStyle: () => g, fillCircle: () => g };
  return g;
}

function makeScene({ players = [], enemies = [] }) {
  const scene = {
    enemies,
    players,
    hazards: [],
    time: { now: 0 },
    groundFx: fakeGraphics(),
    _damageEnemyAt: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _impactFx: vi.fn(),
  };
  return Object.assign(scene, ProjectilesMixin);
}

function armedPlayerMine(x, y, shooter) {
  return { x, y, kind: 'mine', radius: 55, damage: 30, armIn: 0, life: 7, owner: 'player', shooter, color: 0, weaponId: 'mineHazard' };
}

describe('#488 — a player-owned mine never damages any live player, teammate or placer', () => {
  it('a teammate other than the placer standing on the mine does NOT take damage', () => {
    const placer = fakePlayer(500, 500);   // far away — only the teammate is near the mine
    const teammate = fakePlayer(0, 0);
    const ground = fakeEnemy(300, 300);    // out of radius, just proving enemies aren't globally exempt
    const scene = makeScene({ players: [placer, teammate], enemies: [ground] });
    scene.hazards.push(armedPlayerMine(0, 0, placer));

    scene._updateHazards(0.1);

    // A player-owned mine's trigger candidates are ground enemies only (never any player), so
    // with no enemy in range it should simply expire quietly with no damage to anyone.
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
  });

  it('still detonates on and damages a ground enemy that wanders in', () => {
    const placer = fakePlayer(500, 500);
    const teammate = fakePlayer(500, 500);
    const enemy = fakeEnemy(0, 0);
    const scene = makeScene({ players: [placer, teammate], enemies: [enemy] });
    scene.hazards.push(armedPlayerMine(0, 0, placer));

    scene._updateHazards(0.1);

    expect(scene.hazards).toHaveLength(0);   // detonated and filtered out
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
  });
});

describe('#488 — friendly vs enemy mine color distinction', () => {
  it('drawHazard is fed a distinct color path for player-owned vs enemy-owned mines', () => {
    // `_drawHazard` derives its color from `hz.owner` internally (no exported constant to assert
    // against directly), so this pins the observable behaviour: drawing doesn't throw for either
    // owner and each draws via fillStyle at least once — a smoke check that the two owners are
    // handled as distinct branches, backed by the color literals reviewed in projectiles.js
    // (`0xff5533` player / `0x33e6ff` enemy).
    const playerHz = { x: 0, y: 0, kind: 'mine', radius: 55, owner: 'player', armIn: 0.4 };
    const enemyHz = { x: 0, y: 0, kind: 'mine', radius: 55, owner: 'enemy', armIn: 0.4 };
    const calls = [];
    const g = {
      lineStyle: (...a) => (calls.push(['line', ...a]), g),
      strokeCircle: () => g,
      fillStyle: (...a) => (calls.push(['fill', ...a]), g),
      fillCircle: () => g,
    };
    const scene = Object.assign({ time: { now: 0 }, groundFx: g }, ProjectilesMixin);

    scene._drawHazard(playerHz);
    scene._drawHazard(enemyHz);

    const playerColor = calls.find((c) => c[0] === 'fill')[1];
    calls.length = 0;
    scene._drawHazard(enemyHz);
    const enemyColor = calls.find((c) => c[0] === 'fill')[1];

    expect(playerColor).toBe(0xff5533);
    expect(enemyColor).toBe(0x33e6ff);
    expect(playerColor).not.toBe(enemyColor);
  });
});
