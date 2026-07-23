// #337 v2 — the compound-interior fog model. The v1 tests that lived here pinned the open-world
// block machinery (cell keys, cell centres, the 9-ring reveal disc, the all-angles breach union) and
// were deleted with it; nothing in the redesign has an open-world concept to test.
import { describe, it, expect } from 'vitest';
import {
  buildFogWorld, compoundAt, fogHexes, fogFrontier, fogAlphaFor, peekHexes, enemyPerceivableInFog, enemyLockableInFog,
  FOG_ALPHA, FOG_FEATHER_PX, PEEK_RANGE_PX, PEEK_MAX_DEPTH, peekDepthFor,
} from './fogRegions.js';
import { axialKey, hexToPixel, range, distance } from './hexgrid.js';

// A compound centred on `c` with radius `rad` rings — the same shape worldgen hands over.
function base(id, c, rad) {
  return { id, footprint: range(c, rad) };
}
const K = (q, r) => axialKey(q, r);

describe('buildFogWorld', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3)]);

  // v3 BUG FIX. v2 fogged `footprint minus outline` on the theory that the outline ring is "where
  // the walls sit". It isn't: walls are EDGE-owned (#288), `placeBaseWalls` puts a span on every
  // footprint/outside BOUNDARY, so the outline HEX is ground fully inside the wall. Excluding it is
  // what left "the first ring of hexes inside the wall" un-fogged. The fogged set is the whole
  // footprint now; the perimeter reads because it draws above the overlay (DEPTH.WALLS).
  it('fogs the WHOLE footprint, outline ring included — the first ring inside the wall is fog', () => {
    const fp = world.footprints.get('alpha');
    const out = world.outlines.get('alpha');
    const inner = world.interiors.get('alpha');
    expect(fp.size).toBe(37);                       // 3-ring hex
    expect(out.size).toBe(18);                      // the outermost ring — the hexes the walls line
    expect(inner.size).toBe(37);                    // …and it is fogged like everything else
    expect(inner.has(K(3, 0))).toBe(true);          // an outline hex: fogged, unlike v2
    expect(inner.has(K(2, 0))).toBe(true);          // the first ring INSIDE it: the reported bug
    expect(inner.has(K(0, 0))).toBe(true);
    for (const k of fp) expect(inner.has(k)).toBe(true);
  });

  it('maps every footprint hex back to its base and leaves the open world unowned', () => {
    expect(compoundAt(0, 0, world)).toBe('alpha');
    expect(compoundAt(3, 0, world)).toBe('alpha');  // outline hexes still belong to the compound
    expect(compoundAt(20, 20, world)).toBe(null);
  });

  it('ignores a base with no footprint', () => {
    const w = buildFogWorld([{ id: 'ghost', footprint: [] }, base('real', { q: 0, r: 0 }, 2)]);
    expect(w.footprints.has('ghost')).toBe(false);
    expect(w.footprints.has('real')).toBe(true);
  });
});

describe('fogHexes', () => {
  const world = buildFogWorld([
    base('alpha', { q: 0, r: 0 }, 3),
    base('beta', { q: 40, r: 0 }, 3),
  ]);

  it('fogs whole compound footprints — and never the open world', () => {
    const fogged = fogHexes(world, new Set());
    expect(fogged.has(K(0, 0))).toBe(true);         // deep interior
    expect(fogged.has(K(3, 0))).toBe(true);         // v3: the outline ring is fogged too
    expect(fogged.has(K(2, 0))).toBe(true);         // the first ring inside the wall
    expect(fogged.has(K(15, 7))).toBe(false);       // open ground is NEVER fogged
    expect(fogged.size).toBe(37 * 2);
  });

  it('drops a compound permanently once entered, leaving the others alone', () => {
    const fogged = fogHexes(world, new Set(['alpha']));
    expect(fogged.has(K(0, 0))).toBe(false);
    expect(fogged.has(K(40, 0))).toBe(true);
    expect(fogged.size).toBe(37);
  });

  it('is empty when every compound has been entered', () => {
    expect(fogHexes(world, new Set(['alpha', 'beta'])).size).toBe(0);
  });
});

describe('fogFrontier / fogAlphaFor — flat fill, feathered edge', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 6)]);
  const fogged = fogHexes(world, new Set());
  const frontier = fogFrontier(fogged);

  it('marks exactly the fogged hexes touching something un-fogged', () => {
    expect(frontier.has(K(6, 0))).toBe(true);       // v3: the outline ring is now the frontier
    expect(frontier.has(K(5, 0))).toBe(false);      // one deeper: interior
    expect(frontier.has(K(0, 0))).toBe(false);
    for (const k of frontier) expect(fogged.has(k)).toBe(true);
  });

  it('fills every fogged hex at the same alpha — no ring tiering, and no lighter first ring', () => {
    const a = (q, r) => fogAlphaFor(K(q, r), { fogged });
    expect(a(7, 0)).toBe(0);                        // open ground outside the compound
    expect(a(6, 0)).toBe(FOG_ALPHA);                // the frontier is fully dark too
    expect(a(5, 0)).toBe(FOG_ALPHA);
    expect(a(0, 0)).toBe(FOG_ALPHA);
    for (const k of fogged) expect(fogAlphaFor(k, { fogged })).toBe(FOG_ALPHA);
  });

  // Jackson asked for "more stark" twice. v1 0.62 -> v2 0.92 -> v3 fully opaque, deliberately not a
  // third split-the-difference. Nothing inside an unentered compound reads through.
  it('is FULLY OPAQUE, with softness measured in pixels not rings', () => {
    expect(FOG_ALPHA).toBe(1);
    expect(FOG_FEATHER_PX).toBe(3);
  });

  it('cuts a peeked hex out of the fill entirely — that is how the reveal is drawn', () => {
    const peeked = new Set([K(6, 0)]);
    expect(fogAlphaFor(K(6, 0), { fogged, peeked })).toBe(0);
    expect(fogAlphaFor(K(5, 0), { fogged, peeked })).toBe(FOG_ALPHA);   // its neighbour stays black
  });

  it('gives open ground alpha 0 — there is no open-world fog', () => {
    expect(fogAlphaFor(K(99, 99), { fogged })).toBe(0);
  });
});

describe('enemyPerceivableInFog', () => {
  const fogged = new Set([K(0, 0)]);
  const hexKeyOf = () => K(0, 0);                   // every enemy below sits in the fogged hex
  const opts = (extra) => ({ fogged, hexKeyOf, ...extra });

  it('hides a ground enemy inside an unentered compound', () => {
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, opts())).toBe(false);
  });

  it('always shows an airborne enemy', () => {
    expect(enemyPerceivableInFog({ x: 0, y: 0, flying: true }, opts())).toBe(true);
    // grounded flyer is still a ground unit
    expect(enemyPerceivableInFog({ x: 0, y: 0, flying: true, airborne: false }, opts())).toBe(false);
  });

  it('always shows a wall turret — it reads from both sides of the ring', () => {
    expect(enemyPerceivableInFog({ x: 0, y: 0, spanKey: 'e7' }, opts())).toBe(true);
  });

  it('shows anything outside the fogged set, i.e. the whole open world', () => {
    expect(enemyPerceivableInFog({ x: 9e3, y: 9e3 }, opts({ hexKeyOf: () => K(50, 50) }))).toBe(true);
  });

  it('shows an awake enemy with a firing lane — if it can shoot him, he can see it', () => {
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, opts({ losClear: true, awake: true }))).toBe(true);
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, opts({ losClear: true, awake: false }))).toBe(false);
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, opts({ losClear: false, awake: true }))).toBe(false);
  });

  it('shows an enemy the breach peek reaches, and only that one', () => {
    const peekVisible = (x) => x === 100;
    expect(enemyPerceivableInFog({ x: 100, y: 0 }, opts({ peekVisible }))).toBe(true);
    expect(enemyPerceivableInFog({ x: 200, y: 0 }, opts({ peekVisible }))).toBe(false);
  });

  it('gates nothing before any fog exists', () => {
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, { fogged: null, hexKeyOf })).toBe(true);
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, { fogged: new Set(), hexKeyOf })).toBe(true);
  });

  // #460 v1 shipped ONE predicate for both questions and failed its playtest — Jackson: "actual
  // visibility of ground units is now being affected, which is no good". Hard cover must not
  // reach the perceivable side at all, so it takes no `hardCoverLos` argument to reach it with.
  it('IGNORES hard cover entirely — a tank behind a boulder is still on screen', () => {
    const args = { fogged: new Set(), hexKeyOf: () => K(50, 50), hardCoverLos: () => false };
    expect(enemyPerceivableInFog({ x: 9e3, y: 9e3 }, args)).toBe(true);
  });
});

// ── #460 v2: the SPLIT ───────────────────────────────────────────────────────────────
// The invariant is one-directional — lockable ⊆ perceivable. You may be shown something you
// cannot lock (a ground unit sheltering behind hard cover); you may never lock something you are
// not shown (anything inside a compound you have never entered).
describe('enemyLockableInFog — the targeting half of the split', () => {
  const open = { fogged: new Set(), hexKeyOf: () => K(50, 50) };            // open ground, no fog
  const blocked = { ...open, hardCoverLos: () => false };
  const clear = { ...open, hardCoverLos: () => true };
  const tank = { x: 9e3, y: 9e3 };

  it('a ground unit behind hard cover is PERCEIVABLE but NOT TARGETABLE', () => {
    expect(enemyPerceivableInFog(tank, blocked)).toBe(true);
    expect(enemyLockableInFog(tank, blocked)).toBe(false);
  });

  it('the same unit with a clear lane is both', () => {
    expect(enemyPerceivableInFog(tank, clear)).toBe(true);
    expect(enemyLockableInFog(tank, clear)).toBe(true);
  });

  it('an enemy in an unentered compound is NEITHER — the fog outranks the raycast', () => {
    const inFog = { fogged: new Set([K(0, 0)]), hexKeyOf: () => K(0, 0), hardCoverLos: () => true };
    expect(enemyPerceivableInFog({ x: 0, y: 0 }, inFog)).toBe(false);
    expect(enemyLockableInFog({ x: 0, y: 0 }, inFog)).toBe(false);
  });

  it('keeps the three cover exemptions: airborne, wall turret, and already shooting at you', () => {
    expect(enemyLockableInFog({ x: 9e3, y: 9e3, flying: true }, blocked)).toBe(true);
    expect(enemyLockableInFog({ x: 9e3, y: 9e3, spanKey: 'e7' }, blocked)).toBe(true);
    expect(enemyLockableInFog(tank, { ...blocked, losClear: true, awake: true })).toBe(true);
    // …but a grounded flyer behind cover is a ground unit again.
    expect(enemyLockableInFog({ x: 9e3, y: 9e3, flying: true, airborne: false }, blocked)).toBe(false);
  });

  it('with no raycast wired (a scene double) it collapses to the perceivable answer', () => {
    expect(enemyLockableInFog(tank, open)).toBe(true);
    expect(enemyLockableInFog({ x: 0, y: 0 }, { fogged: new Set([K(0, 0)]), hexKeyOf: () => K(0, 0) }))
      .toBe(false);
  });
});

// v3: the reveal is ONE HEX per nearby opening. Jackson, on v2's 900px visibility polygon: "the
// auto-reveal on breach/gate is a bit too generous; maybe we just reveal the one hex inside the
// breach or opening or something small like that". It must read as a peek through a hole, and it is
// still position-dependent — walking away from a hole closes it again.
describe('peekHexes — the breach/gate reveal', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3)]);
  const fogged = fogHexes(world, new Set());
  // An opening on the compound's east flank: outline hex (3,0) ←→ open ground (4,0).
  const opening = { a: { q: 3, r: 0 }, b: { q: 4, r: 0 } };
  // …and a second one to the northeast, so "only the hole you're at" is testable.
  const far = { a: { q: 0, r: 3 }, b: { q: 0, r: 4 } };
  const outside = (q, r) => hexToPixel(q, r);

  // At the far edge of PEEK_RANGE_PX the #352 ramp is still at depth 1, so this is the v3 behaviour.
  const farEdge = () => {
    const p = hexToPixel(4, 0);
    return { x: p.x + PEEK_RANGE_PX * 0.9, y: p.y };
  };

  it('reveals exactly the ONE hex behind the opening from the far edge of range', () => {
    const seen = peekHexes(fogged, [opening], farEdge());
    expect([...seen]).toEqual([K(3, 0)]);           // one hex, not a slice of yard
  });

  // 2026-07-20: the floor. "make 1 hex always visible regardless of how far back the player is" —
  // so stepping away narrows the peek to its single throat hex, but never closes it.
  it('narrows to exactly one hex once he steps away — never to nothing', () => {
    expect([...peekHexes(fogged, [opening], outside(9, 0))]).toEqual([K(3, 0)]);
    expect([...peekHexes(fogged, [opening], outside(4, -6))]).toEqual([K(3, 0)]);
  });

  it('is directional in DEPTH: the far hole still gives its one hex, but only that', () => {
    const seen = peekHexes(fogged, [opening, far], outside(4, 0));
    expect(seen.has(K(3, 0))).toBe(true);
    expect(seen.has(K(0, 3))).toBe(true);       // the far hole's throat — the always-one floor
    expect(seen.has(K(0, 2))).toBe(false);      // …but nothing deeper through it
  });

  it('works from either orientation of the span — the caller never picks a side', () => {
    const flipped = { a: opening.b, b: opening.a };
    expect(peekHexes(fogged, [flipped], farEdge())).toEqual(peekHexes(fogged, [opening], farEdge()));
    expect(peekHexes(fogged, [flipped], outside(4, 0))).toEqual(peekHexes(fogged, [opening], outside(4, 0)));
  });

  it('gives up nothing when the span has fog on neither side, or none at all', () => {
    // Wholly interior span: both hexes fogged, so there is no "outside" to peek from.
    expect(peekHexes(fogged, [{ a: { q: 0, r: 0 }, b: { q: 1, r: 0 } }], outside(0, 0)).size).toBe(0);
    // Wholly exterior span.
    expect(peekHexes(fogged, [{ a: { q: 9, r: 0 }, b: { q: 10, r: 0 } }], outside(9, 0)).size).toBe(0);
    expect(peekHexes(new Set(), [opening], outside(4, 0)).size).toBe(0);
    expect(peekHexes(fogged, [opening], null).size).toBe(0);
    expect(peekHexes(fogged, [], outside(4, 0)).size).toBe(0);
  });

  it('keeps the ramp tight — PEEK_RANGE_PX is a scale now, not a cutoff', () => {
    expect(PEEK_RANGE_PX).toBeLessThan(300);
    const p = hexToPixel(4, 0);
    expect(peekHexes(fogged, [opening], { x: p.x + PEEK_RANGE_PX - 1, y: p.y }).size).toBe(1);
    expect(peekHexes(fogged, [opening], { x: p.x + PEEK_RANGE_PX + 1, y: p.y }).size).toBe(1);
    // …and it is still one hex from absurdly far away, rather than zero.
    expect(peekHexes(fogged, [opening], { x: p.x + 40 * PEEK_RANGE_PX, y: p.y }).size).toBe(1);
  });

  // ── #352: the peek deepens as he closes on the hole ───────────────────────────────
  // "when the player gets close, I want to expose slightly more base interior hexes through a
  // breach or open gate". The cone deepens; it never becomes a disc or a view of the yard.
  const at = (frac) => {
    const p = hexToPixel(4, 0);
    return { x: p.x + PEEK_RANGE_PX * frac, y: p.y };
  };

  it('deepens as the player closes: 1 hex far, more up close', () => {
    const far = peekHexes(fogged, [opening], at(0.9));
    const mid = peekHexes(fogged, [opening], at(0.5));
    const near = peekHexes(fogged, [opening], at(0.05));
    expect(far.size).toBe(1);
    expect(mid.size).toBe(4);
    expect(near.size).toBe(9);
    // Monotone: closing in only ever ADDS hexes, so the reveal never flickers off as he walks in.
    for (const k of far) expect(mid.has(k)).toBe(true);
    for (const k of mid) expect(near.has(k)).toBe(true);
  });

  it('ramps depth in thirds of PEEK_RANGE_PX, and gives up nothing out of range', () => {
    expect(PEEK_MAX_DEPTH).toBe(3);
    expect(peekDepthFor(0)).toBe(3);
    expect(peekDepthFor(PEEK_RANGE_PX * 0.32)).toBe(3);
    expect(peekDepthFor(PEEK_RANGE_PX * 0.5)).toBe(2);
    expect(peekDepthFor(PEEK_RANGE_PX * 0.9)).toBe(1);
    expect(peekDepthFor(PEEK_RANGE_PX)).toBe(1);
    // 2026-07-20: no cutoff to zero any more — the far third is the floor, at any distance.
    expect(peekDepthFor(PEEK_RANGE_PX + 1)).toBe(1);
    expect(peekDepthFor(PEEK_RANGE_PX * 100)).toBe(1);
  });

  // ── 2026-07-20: a DISC around the player, not a wedge through the hole ──────────────
  // "make it a 1-2-3 hex ring around the player, not just a cone through the opening". The old
  // wedge rule (every revealed hex strictly farther from the opening than from the throat) is gone;
  // the reveal now spreads sideways once it is through the hole.
  it('spreads sideways inside — it is a disc, not a wedge', () => {
    const seen = peekHexes(fogged, [opening], at(0));
    // (3,-2) and (1,2) are lateral to the throat, not "straight through" it, and they read.
    expect(seen.has(K(3, -2))).toBe(true);
    expect(seen.has(K(1, 2))).toBe(true);
    // Still a peek, not the yard: the compound's centre and far side stay dark from the gate.
    expect(seen.has(K(0, 0))).toBe(false);
    expect(seen.has(K(-3, 0))).toBe(false);
    expect(seen.size).toBeLessThan(fogged.size / 3);
  });

  // ── THE BLOCKING GUARANTEE ─────────────────────────────────────────────────────────
  // A ring centred on the player would light interior hexes through solid plate. It doesn't,
  // because the reveal is a flood fill that may only cross the fog boundary at a listed opening.
  it('never reveals through INTACT WALL — a second compound with no opening stays black', () => {
    const two = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3), base('beta', { q: 6, r: 0 }, 1)]);
    const foggedTwo = fogHexes(two, new Set());
    // He is jammed in alpha's gate at full depth 3; beta's nearest hexes are 1-2 steps from him.
    const seen = peekHexes(foggedTwo, [opening], at(0));
    for (const h of range({ q: 6, r: 0 }, 1)) {
      expect(seen.has(K(h.q, h.r))).toBe(false);      // no opening in beta's wall, no reveal
    }
    expect(distance({ q: 5, r: 0 }, { q: 4, r: 0 })).toBe(1);   // …and it really was in ring range
  });

  it('every revealed hex was reached THROUGH the opening — nothing leaks around the wall', () => {
    for (const frac of [0, 0.05, 0.4, 0.5, 0.8, 0.95, 3]) {
      const depth = peekDepthFor(PEEK_RANGE_PX * frac);
      const seen = peekHexes(fogged, [opening], at(frac));
      for (const k of seen) {
        const [q, r] = k.split(',').map(Number);
        expect(fogged.has(k)).toBe(true);
        // Any path in costs 1 at the throat, so nothing can sit farther than depth-1 beyond it.
        expect(distance({ q, r }, { q: 3, r: 0 })).toBeLessThanOrEqual(depth - 1);
      }
    }
  });

  it('never reveals a hex outside the fogged compound, however close he stands', () => {
    const seen = peekHexes(fogged, [opening], at(0));
    for (const k of seen) expect(fogged.has(k)).toBe(true);
  });
});
