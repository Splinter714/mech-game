// #167 — the per-enemy LOS/firing-lane raycast was the top game-logic CPU cost (#148/#164). The
// fix has two behaviour-preserving halves, both pinned here so a regression is caught by `npm test`:
//
//   1. `_wallDistanceLos` is an ALLOCATION-FREE rewrite of the old
//      `_wallDistance(x0,y0,angle,maxT, _losTransparency(x0,y0,x1,y1))` — it must return the
//      IDENTICAL value (same 8px geometry, same #72 endpoint transparency), only without the
//      per-call Set and the per-8px-step hex-key string. Proved equal below against the ORIGINAL
//      `_wallDistance` (still in world.js, used by `_hitscanReach`) over many terrains/rays.
//
//   2. `_cachedLosToPlayer` staggers + caches that raycast on a ~LOS_REFRESH_MS cadence: it must
//      return a STALE cached value between refreshes and pick up the fresh value once the window
//      elapses — proved by moving the scene clock across the window with the lane changing under it.
//
// WorldMixin has no Phaser dependency (its methods only read `this.terrain` / `this.time` and pure
// hexgrid/terrain helpers), so it's exercised against a minimal fake ArenaScene `this`.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin, LOS_REFRESH_MS } from './world.js';
import { hexToPixel, pixelToHex, axialKey } from '../../data/hexgrid.js';

// A tiny deterministic PRNG so the random sweep is reproducible (no flaky test).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// Build a terrain Map over the hex disc |q|,|r| <= radius, each hex assigned an id by `pick(q,r)`.
// Ids used: 'grass' (clear), 'alertTower' (impassable hard cover — no living occupant, so its own-
// hex exemption never fires in practice), 'forest' (passable SOFT cover — passable+blocksLOS, so
// it's see-through at a ray's own endpoint hex, #72).
function gridTerrain(pick, radius = 7) {
  const t = new Map();
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      t.set(axialKey(q, r), pick(q, r));
    }
  }
  return t;
}

function makeScene(terrain) {
  return Object.assign({ terrain, time: { now: 0 } }, WorldMixin);
}

// The exact call the old per-enemy LOS sites made, kept as the reference oracle.
function refWallDistance(scene, x0, y0, x1, y1) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const maxT = Math.hypot(x1 - x0, y1 - y0);
  return scene._wallDistance(x0, y0, angle, maxT, scene._losTransparency(x0, y0, x1, y1));
}
function newWallDistance(scene, x0, y0, x1, y1) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const maxT = Math.hypot(x1 - x0, y1 - y0);
  return scene._wallDistanceLos(x0, y0, angle, maxT, x1, y1);
}

describe('_wallDistanceLos — allocation-free raycast is bit-identical to the old _wallDistance (#167)', () => {
  it('matches on a hand-built lane with a solid wall, a soft-cover screen, and an endpoint in cover', () => {
    // A clear row with one alertTower (solid) at q=2 and one forest (soft cover) at q=4, on r=0.
    const terrain = gridTerrain((q, r) => {
      if (r !== 0) return 'grass';
      if (q === 2) return 'alertTower';
      if (q === 4) return 'forest';
      return 'grass';
    });
    const scene = makeScene(terrain);
    const origin = hexToPixel(0, 0);
    // Ray straight along r=0 toward q=6: should stop at the alertTower (q=2), well before the forest.
    const far = hexToPixel(6, 0);
    expect(newWallDistance(scene, origin.x, origin.y, far.x, far.y))
      .toBe(refWallDistance(scene, origin.x, origin.y, far.x, far.y));
    // Ray to a target STANDING in the forest hex (q=4): with no alertTower between, the forest is
    // the target's own endpoint hex → transparent (#72), so the lane is clear. Remove the alertTower.
    const t2 = gridTerrain((q, r) => (r === 0 && q === 4 ? 'forest' : 'grass'));
    const s2 = makeScene(t2);
    const tgt = hexToPixel(4, 0);
    expect(newWallDistance(s2, origin.x, origin.y, tgt.x, tgt.y)).toBe(Infinity);
    expect(newWallDistance(s2, origin.x, origin.y, tgt.x, tgt.y))
      .toBe(refWallDistance(s2, origin.x, origin.y, tgt.x, tgt.y));
  });

  it('matches the oracle across a large random sweep of terrains, origins, and ray endpoints', () => {
    const rng = lcg(0xC0FFEE);
    const kinds = ['grass', 'grass', 'grass', 'forest', 'alertTower'];   // weighted toward clear
    let checked = 0;
    for (let trial = 0; trial < 60; trial++) {
      const terrain = gridTerrain(() => kinds[Math.floor(rng() * kinds.length)]);
      const scene = makeScene(terrain);
      for (let ray = 0; ray < 40; ray++) {
        // Endpoints anywhere within the built disc's pixel span (~±7 hexes ≈ ±580px).
        const x0 = (rng() - 0.5) * 900, y0 = (rng() - 0.5) * 900;
        const x1 = (rng() - 0.5) * 900, y1 = (rng() - 0.5) * 900;
        expect(newWallDistance(scene, x0, y0, x1, y1))
          .toBe(refWallDistance(scene, x0, y0, x1, y1));
        checked++;
      }
    }
    expect(checked).toBe(2400);
  });
});

describe('_cachedLosToPlayer — delta-driven staggered cache returns stale-then-refreshed values (#167)', () => {
  // Signature: _cachedLosToPlayer(e, delta, x0, y0, angle, maxT, x1, y1). A clear straight ray of
  // length 300 along +x from the origin over all-grass returns Infinity ⇒ LOS clear (true).
  const ray = (scene, e, delta) => scene._cachedLosToPlayer(e, delta, 0, 0, 0, 300, 300, 0);

  it('seeds a random per-enemy countdown phase so a same-frame batch does not refresh in lockstep', () => {
    const scene = makeScene(gridTerrain(() => 'grass'));
    const spy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
    const a = {}, b = {};
    ray(scene, a, 0);   // delta 0 ⇒ seed only, no countdown yet
    ray(scene, b, 0);
    // Two enemies spawned "the same frame" get DIFFERENT countdown phases (0.2·window vs 0.8·window)
    // ⇒ their refreshes land on different frames, spreading the recompute cost.
    expect(a._losCd).toBeCloseTo(0.2 * LOS_REFRESH_MS, 6);
    expect(b._losCd).toBeCloseTo(0.8 * LOS_REFRESH_MS, 6);
    expect(a._losCd).not.toBe(b._losCd);
    spy.mockRestore();
  });

  it('holds the stale cached value within the window, then recomputes the fresh value after it', () => {
    const scene = makeScene(gridTerrain(() => 'grass'));   // real lane is CLEAR (true)
    const e = {};
    // First call seeds the cache to `false` (no lane verified yet). Pin the countdown to a full
    // window so the frame maths below is exact (drop the random seed offset).
    expect(ray(scene, e, 0)).toBe(false);
    e._losCd = LOS_REFRESH_MS; e._losClear = false;
    // Sub-window frames (6·16 = 96ms < 120ms): keeps returning the stale `false` despite a clear lane.
    for (let i = 0; i < 6; i++) expect(ray(scene, e, 16)).toBe(false);
    // Two more 16ms frames cross the 120ms window → it recomputes and picks up the clear lane.
    ray(scene, e, 16);                       // 112ms — still short
    expect(ray(scene, e, 16)).toBe(true);    // 128ms — refreshed
  });

  it('does not notice a lane that closes until the next refresh, then reflects it (bounded staleness)', () => {
    const terrain = gridTerrain(() => 'grass');
    const scene = makeScene(terrain);
    const e = {};
    ray(scene, e, 0);                         // seed
    e._losCd = LOS_REFRESH_MS; e._losClear = true;   // pin: cache currently says "clear"
    // An alertTower slams down squarely in the lane (hex (2,0) ≈166px out, inside the 300px ray).
    terrain.set(axialKey(2, 0), 'alertTower');
    // Same window: still reports the STALE "clear", hasn't re-raycast.
    expect(ray(scene, e, 16)).toBe(true);     // 16ms in
    expect(ray(scene, e, 16)).toBe(true);     // 32ms in
    // Drive past the window: it recomputes and now sees the wall ⇒ lane blocked (false).
    for (let i = 0; i < 7; i++) ray(scene, e, 16);   // +112ms ⇒ well past 120ms total
    expect(e._losClear).toBe(false);
  });

  it('a huge delta spike (lag/tab-switch) still recomputes exactly once, not repeatedly', () => {
    const scene = makeScene(gridTerrain(() => 'grass'));
    const e = {};
    ray(scene, e, 0);
    e._losCd = LOS_REFRESH_MS; e._losClear = false;
    // One 5000ms frame: countdown goes deeply negative; the guard resets it to a full window so
    // the NEXT frame doesn't immediately recompute again.
    expect(ray(scene, e, 5000)).toBe(true);   // recomputed once → clear lane
    expect(e._losCd).toBe(LOS_REFRESH_MS);     // reset to a fresh full window, not left negative
  });
});

// #269 overhaul Part 1: `_damageBuildingAt` fires the `_onAlertTowerDamaged` activation hook when
// the damaged hex is a STANDING alert tower (survives the hit) — the "shooting a tower commits it
// to calling reinforcements" trigger. A killing blow instead collapses the hex (destroyed branch),
// which never calls the hook — the tower is gone and its countdown is dropped scene-side instead.
describe('_damageBuildingAt — alert-tower damage activation hook (#269)', () => {
  // Minimal scene: an alertTower hex at the origin with plenty of building HP, empty cover map,
  // and stubs for the collapse-path side effects (only reached on a destroying hit).
  function makeDamageScene(hp = 100) {
    const k = axialKey(0, 0);
    const terrain = new Map([[k, 'alertTower']]);
    // Stubs assigned AFTER WorldMixin so they override the mixin's real (Phaser-dependent) versions
    // — `_outpostCollapseFx` in particular calls `this.add.circle`/`this.tweens` on the collapse path.
    const scene = Object.assign({}, WorldMixin);
    return Object.assign(scene, {
      terrain,
      buildingHp: new Map([[k, hp]]),
      coverHp: new Map(),
      tileImages: new Map(),
      canopyImages: new Map(),
      time: { now: 0 },
      _outpostCollapseFx: () => {},
      _onTerrainCollapsed: () => {},
      _onAlertTowerDamaged: vi.fn(),
    });
  }

  it('a non-destroying hit on a standing alert tower calls _onAlertTowerDamaged with its hex key', () => {
    const scene = makeDamageScene(100);
    const { x, y } = hexToPixel(0, 0);
    const collapsed = scene._damageBuildingAt(x, y, 10);   // 10 dmg vs 100 hp — survives
    expect(collapsed).toBe(false);
    expect(scene._onAlertTowerDamaged).toHaveBeenCalledTimes(1);
    expect(scene._onAlertTowerDamaged).toHaveBeenCalledWith(axialKey(0, 0));
  });

  it('a killing hit collapses the tower and does NOT call the activation hook (it is being destroyed)', () => {
    const scene = makeDamageScene(20);
    const { x, y } = hexToPixel(0, 0);
    const collapsed = scene._damageBuildingAt(x, y, 100000);   // overkill — destroys it
    expect(collapsed).toBe(true);
    expect(scene._onAlertTowerDamaged).not.toHaveBeenCalled();
    // Hex is now rubble, no longer an alertTower — the scene-side state drop path takes over.
    expect(scene.terrain.get(axialKey(0, 0))).not.toBe('alertTower');
  });

  it('damaging a NON-tower building never calls the alert hook', () => {
    const scene = makeDamageScene(100);
    scene.terrain.set(axialKey(0, 0), 'wall');   // not an alert tower
    const { x, y } = hexToPixel(0, 0);
    scene._damageBuildingAt(x, y, 10);
    expect(scene._onAlertTowerDamaged).not.toHaveBeenCalled();
  });
});
