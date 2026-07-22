// #426 — wall turrets are hittable from their EXPOSED side; their own wall may still block a
// player's shot fired from BEHIND them. This is the HITSCAN half (`_fireHitscan` +
// `_hitscanReach`'s `exposedTargetSpanKey` gate); the travelling-round half is covered in
// projectiles.test.js. Runs the REAL WorldMixin geometry against a real wallEdges set — same
// "real geometry, minimal scene" convention wallTurrets.test.js §1b uses for the gun's own LOS.
import { describe, it, expect, vi } from 'vitest';
import { FiringMixin } from './firing.js';
import { WorldMixin } from './world.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeWallEdgeSet, spanTurretMount, SPAN_ROLE_TURRET } from '../../data/wallEdges.js';
import { hexToPixel, neighbors } from '../../data/hexgrid.js';

const HITSCAN_W = { weapon: WEAPONS.pulseLaser, location: 'ra', index: 0 };

function makeScene() {
  const A = { q: 0, r: 0 };            // base-interior hex
  const B = neighbors(A.q, A.r)[0];    // outer hex — the exposed side
  const set = makeWallEdgeSet([{ a: A, b: B, baseId: 'base0', role: SPAN_ROLE_TURRET }]);
  const edge = [...set.edges.values()][0];
  const mount = spanTurretMount(edge);
  const gun = { x: mount.x, y: mount.y, spanKey: edge.key, mech: { isDestroyed: () => false } };
  const scene = {
    enemies: [gun],
    beams: [],
    dyingBeams: [],
    px: 9999, py: 9999,   // player far away and irrelevant to these player-fired shots
    mech: { isDestroyed: () => false },
    terrain: new Map(),
    wallEdges: set,
  };
  // Mixins FIRST — the real `_hitscanReach`/`_isWall`/`_spanExposedTo` chain runs against the
  // real `wallEdges` set built above; the FX/damage methods they call out to are stubbed AFTER,
  // same convention as wallTurrets.test.js / projectiles.test.js.
  Object.assign(scene, WorldMixin, FiringMixin);
  scene._damagePlayerAt = vi.fn();
  scene._damageEnemyAt = vi.fn();
  scene._damageBuildingAt = vi.fn();
  scene._impactFx = vi.fn();
  return { scene, gun, edge, inner: hexToPixel(A.q, A.r), outer: hexToPixel(B.q, B.r) };
}

describe('#426 hitscan: a wall turret is hittable from its exposed side, blocked from behind', () => {
  it('a beam fired from the EXPOSED (outward) side hits the gun through its own wall', () => {
    const { scene, gun, outer } = makeScene();
    const from = { x: gun.x + (outer.x - gun.x) * 4, y: gun.y + (outer.y - gun.y) * 4 };
    const angle = Math.atan2(gun.y - from.y, gun.x - from.x);
    scene._fireHitscan(HITSCAN_W, from.x, from.y, angle);
    expect(scene._damageEnemyAt).toHaveBeenCalled();
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
  });

  it('a beam fired from BEHIND (the inward/base-interior side) is stopped by the wall instead', () => {
    const { scene, gun, inner } = makeScene();
    const from = { x: gun.x + (inner.x - gun.x) * 4, y: gun.y + (inner.y - gun.y) * 4 };
    const angle = Math.atan2(gun.y - from.y, gun.x - from.x);
    scene._fireHitscan(HITSCAN_W, from.x, from.y, angle);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
    expect(scene._damageBuildingAt).toHaveBeenCalled();
  });

  it('an explicit `ignoreSpanKey` (the turret\'s OWN beam, firing off its own centreline) is untouched by the side gate', () => {
    // #310's existing mechanism — a wall turret firing its OWN weapon off its own span — is a
    // different rule from #426's target-side gate and must stay unconditional either way.
    const { scene, gun, inner } = makeScene();
    const from = { x: gun.x + (inner.x - gun.x) * 4, y: gun.y + (inner.y - gun.y) * 4 };
    const angle = Math.atan2(gun.y - from.y, gun.x - from.x);
    scene._fireHitscan(HITSCAN_W, from.x, from.y, angle, 'enemy', 'wallTurretTest', { ignoreSpanKey: gun.spanKey });
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
  });
});
