// #378 — the magnetic pickup pull, as WIRED into the two collectible kinds:
//   1. powerups now have one at all (the ask), on a gentler table than scrap's;
//   2. neither kind may drag a drop through a wall (#336 put drops on the correct side of a base
//      wall; an ungated magnet would pull them straight back through);
//   3. both magnetise to the NEAREST LIVE player and are collectable by either (the co-op gap —
//      salvage.js's "one player today" comment was stale after #347/#348/#349).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));
// powerups.js imports Phaser only for `Phaser.BlendModes.ADD` in `_initShieldVisual`, which
// isn't exercised here; Phaser's top-level device detection touches `navigator` and throws under
// vitest's node environment. Same stub pattern as powerups.test.js.
vi.mock('phaser', () => ({ default: {} }));

import { SalvageMixin } from './salvage.js';
import { PowerupsMixin } from './powerups.js';
import { SCRAP_MAGNET, POWERUP_MAGNET } from '../../data/magnet.js';

function fakeSalvageView() {
  return { x: 0, y: 0, _gem: { rotation: 0 }, _ring: { rotation: 0 }, destroy: vi.fn() };
}

function fakePowerupView() {
  const node = { x: 0, y: 0, rotation: 0, setScale() { return this; }, setAlpha() { return this; } };
  return {
    x: 0, y: 0,
    _halo: { ...node }, _core: { ...node }, _ring: { ...node },
    _spark: { ...node }, _beam: { ...node }, _glow: [{ ...node }],
    destroy: vi.fn(),
  };
}

// A minimal ArenaScene double carrying an explicit `players` collection, so the co-op cases are
// exercised with real two-player collections rather than the legacy single-player adapter.
function makeScene({ players, blocked = null } = {}) {
  const scene = {
    players,
    salvage: [],
    powerups: [],
    activePowerups: {},
    run: { currency: 0 },
    registry: { set: vi.fn() },
    _floatText: vi.fn(),
  };
  if (blocked) scene._blockedAlongSegment = blocked;
  Object.assign(scene, SalvageMixin, PowerupsMixin);
  // Stubbed AFTER the mixins so these override the real methods: the visual upkeep needs Phaser
  // sprites, and activation needs a real Mech — neither is what these tests are about.
  scene._updateShieldVisual = vi.fn();
  scene._activatePowerup = vi.fn();
  return scene;
}

function player(id, x, y, extra = {}) {
  return { id, x, y, ...extra };
}

function scrap(x, y) { return { x, y, amount: 5, age: 0, view: fakeSalvageView() }; }
function powerup(x, y) { return { x, y, type: 'shield', age: 0, view: fakePowerupView() }; }

describe('#378 — powerups get a magnet (the ask)', () => {
  it('pulls a powerup inside POWERUP_MAGNET.radius toward the player', () => {
    const scene = makeScene({ players: [player(0, 0, 0)] });
    const pk = powerup(POWERUP_MAGNET.radius - 20, 0);
    scene.powerups.push(pk);
    scene._updatePowerups(16);
    expect(pk.x).toBeLessThan(POWERUP_MAGNET.radius - 20);
    expect(pk.x).toBeGreaterThan(0);
  });

  it('leaves a powerup outside its radius exactly where it landed', () => {
    const scene = makeScene({ players: [player(0, 0, 0)] });
    const pk = powerup(POWERUP_MAGNET.radius + 30, 0);
    scene.powerups.push(pk);
    scene._updatePowerups(16);
    expect(pk.x).toBe(POWERUP_MAGNET.radius + 30);
    expect(pk.y).toBe(0);
  });

  it('drags the beacon view along with the drop, so the art does not stay behind', () => {
    const scene = makeScene({ players: [player(0, 0, 0)] });
    const pk = powerup(100, 0);
    scene.powerups.push(pk);
    scene._updatePowerups(16);
    expect(pk.view.x).toBe(pk.x);
  });

  it('pulls a powerup more weakly than scrap from the same distance', () => {
    const dist = Math.min(POWERUP_MAGNET.radius, SCRAP_MAGNET.radius) - 20;
    const a = makeScene({ players: [player(0, 0, 0)] });
    const pk = powerup(dist, 0);
    a.powerups.push(pk);
    a._updatePowerups(16);

    const b = makeScene({ players: [player(0, 0, 0)] });
    const s = scrap(dist, 0);
    b.salvage.push(s);
    b._updateSalvage(16);

    expect(dist - pk.x).toBeLessThan(dist - s.x);
  });
});

describe('#378 — the pull respects walls (#336 must not be undone)', () => {
  // A vertical wall at x = 50: any segment crossing it is blocked.
  const wallAtX50 = (x0, _y0, x1) => (x0 - 50) * (x1 - 50) < 0;

  it('does not drift SCRAP that is walled off from the player', () => {
    const scene = makeScene({ players: [player(0, 0, 0)], blocked: wallAtX50 });
    const s = scrap(100, 0);   // player at x=0, wall at x=50, drop at x=100
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(s.x).toBe(100);
    expect(s.y).toBe(0);
  });

  it('does not drift a POWERUP that is walled off from the player', () => {
    const scene = makeScene({ players: [player(0, 0, 0)], blocked: wallAtX50 });
    const pk = powerup(100, 0);
    scene.powerups.push(pk);
    scene._updatePowerups(16);
    expect(pk.x).toBe(100);
  });

  it('still drifts both kinds when the wall is not between them and the player', () => {
    // Both player and drop on the far side of the wall — nothing crossed.
    const scene = makeScene({ players: [player(0, 200, 0)], blocked: wallAtX50 });
    const s = scrap(300, 0);
    const pk = powerup(300, 0);
    scene.salvage.push(s);
    scene.powerups.push(pk);
    scene._updateSalvage(16);
    scene._updatePowerups(16);
    expect(s.x).toBeLessThan(300);
    expect(pk.x).toBeLessThan(300);
  });

  it('drifts normally on a scene double that models no walls at all', () => {
    const scene = makeScene({ players: [player(0, 0, 0)] });   // no _blockedAlongSegment
    const s = scrap(100, 0);
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(s.x).toBeLessThan(100);
  });
});

describe('#378 — co-op: nearest live player, collectable by either', () => {
  it('pulls SCRAP toward player 2 when player 2 is the closer one', () => {
    const scene = makeScene({ players: [player(0, -400, 0), player(1, 400, 0)] });
    const s = scrap(300, 0);
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(s.x).toBeGreaterThan(300);   // drifting toward +x, i.e. player 2
  });

  it('pulls a POWERUP toward player 2 when player 2 is the closer one', () => {
    const scene = makeScene({ players: [player(0, -400, 0), player(1, 400, 0)] });
    const pk = powerup(300, 0);
    scene.powerups.push(pk);
    scene._updatePowerups(16);
    expect(pk.x).toBeGreaterThan(300);
  });

  it('ignores a DEAD nearer player and magnetises to the live far one', () => {
    const scene = makeScene({
      // The DEAD player is much closer (x=310 vs the drop's 300); the live one is still well
      // inside the magnet radius, so "nearest LIVE" is what decides the direction of the pull.
      players: [player(0, 150, 0), player(1, 310, 0, { dead: true })],
    });
    const s = scrap(300, 0);
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(s.x).toBeLessThan(300);   // toward the live player at x=150, not the corpse at 310
  });

  it('lets player 2 collect SCRAP by walking onto it', () => {
    const scene = makeScene({ players: [player(0, -900, 0), player(1, 5, 0)] });
    scene.salvage.push(scrap(0, 0));
    scene._updateSalvage(16);
    expect(scene.salvage.length).toBe(0);
    expect(scene.run.currency).toBe(5);
  });

  it('lets player 2 collect a POWERUP by walking onto it, and the buff lands on THEM', () => {
    const p2 = player(1, 5, 0);
    const scene = makeScene({ players: [player(0, -900, 0), p2] });
    scene.powerups.push(powerup(0, 0));
    scene._updatePowerups(16);
    expect(scene.powerups.length).toBe(0);
    expect(scene._activatePowerup).toHaveBeenCalledWith('shield', p2);
  });
});
