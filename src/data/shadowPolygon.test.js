// #306 (rework): the visibility-polygon geometry. These tests are the safety net for the part the
// owner can't verify by eye — that the shadow boundaries are where the maths says they are, at
// arbitrary angles, and that the wedges tile the dark region without overlapping (which is what
// keeps a translucent fill uniform).
import { describe, expect, it } from 'vitest';
import {
  collectShadowSegments,
  computeShadowWedges,
  computeVisibilityPolygon,
  shadowWedges,
} from './shadowPolygon.js';
import { HEX_SIZE, hexToPixel, pixelToHex } from './hexgrid.js';
import { SPAN_ROLE_GATE, SPAN_ROLE_WALL } from './wallEdges.js';

const FAR = 1000;

// Is world point (px, py) inside any shadow wedge? Point-in-convex-quad via consistent cross-product
// sign — the wedges are convex by construction.
function inQuad(q, px, py) {
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[i * 2], ay = q[i * 2 + 1];
    const bx = q[((i + 1) % 4) * 2], by = q[((i + 1) % 4) * 2 + 1];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 1e-9) pos++;
    if (cross < -1e-9) neg++;
  }
  return pos === 0 || neg === 0;
}
const shadowedBy = (wedges, px, py) => wedges.filter((q) => inQuad(q, px, py)).length;
const isShadowed = (wedges, px, py) => shadowedBy(wedges, px, py) > 0;

describe('computeVisibilityPolygon', () => {
  it('returns nothing when there are no blockers — open ground is entirely lit', () => {
    expect(computeVisibilityPolygon(0, 0, [], FAR)).toEqual([]);
    expect(shadowWedges([], 0, 0, FAR)).toEqual([]);
  });

  it('caps unobstructed rays at the far radius', () => {
    // One tiny segment far off to the right; rays that miss it escape to FAR.
    const segs = [{ x0: 500, y0: -10, x1: 500, y1: 10 }];
    const poly = computeVisibilityPolygon(0, 0, segs, FAR);
    expect(poly.length).toBe(4);                      // two endpoints, two rays each
    expect(Math.max(...poly.map((p) => p.dist))).toBeCloseTo(FAR, 6);
  });

  it('stops rays at the blocker, at the blocker distance', () => {
    const segs = [{ x0: 200, y0: -100, x1: 200, y1: 100 }];
    const poly = computeVisibilityPolygon(0, 0, segs, FAR);
    // The two inner rays (just inside each corner) hit the wall plane at x = 200.
    const hits = poly.filter((p) => p.dist < FAR);
    expect(hits.length).toBe(2);
    for (const h of hits) expect(h.x).toBeCloseTo(200, 3);
  });

  it('vertices come out sorted by angle', () => {
    const segs = [
      { x0: 200, y0: -100, x1: 200, y1: 100 },
      { x0: -150, y0: 40, x1: -150, y1: 300 },
    ];
    const poly = computeVisibilityPolygon(0, 0, segs, FAR);
    for (let i = 1; i < poly.length; i++) expect(poly[i].ang).toBeGreaterThanOrEqual(poly[i - 1].ang);
  });
});

describe('shadowWedges — where the darkness actually falls', () => {
  // A wall to the RIGHT of the viewer, perpendicular to the sight line.
  const wall = [{ x0: 200, y0: -100, x1: 200, y1: 100 }];
  const wedges = () => computeShadow(0, 0, wall);
  const computeShadow = (x, y, segs) => shadowWedges(computeVisibilityPolygon(x, y, segs, FAR), x, y, FAR);

  it('darkens directly behind the blocker', () => {
    expect(isShadowed(wedges(), 400, 0)).toBe(true);
    expect(isShadowed(wedges(), 900, 0)).toBe(true);
  });

  it('leaves the space between viewer and blocker lit', () => {
    expect(isShadowed(wedges(), 100, 0)).toBe(false);
    expect(isShadowed(wedges(), 199, 0)).toBe(false);
  });

  it('leaves everything not behind the blocker lit', () => {
    expect(isShadowed(wedges(), -400, 0)).toBe(false);     // opposite side
    expect(isShadowed(wedges(), 0, 400)).toBe(false);      // 90° away
    expect(isShadowed(wedges(), 400, -400)).toBe(false);   // past the corner
  });

  it('casts a DIVERGING shadow — the umbra widens with distance, as a real raycast does', () => {
    // At x = 400 (twice the wall distance) the shadow should be about twice as wide as the wall.
    const w = wedges();
    expect(isShadowed(w, 400, 190)).toBe(true);
    expect(isShadowed(w, 400, 210)).toBe(false);
    // ...and at x = 800 (four times) about four times as wide.
    expect(isShadowed(w, 800, 390)).toBe(true);
    expect(isShadowed(w, 800, 410)).toBe(false);
  });

  it('puts the shadow EDGE at an arbitrary angle, not snapped to the hex grid', () => {
    // A wall corner at an angle that is nowhere near any hex direction (0°, 60°, 120°, ...).
    const segs = [{ x0: 300, y0: 0, x1: 300, y1: 300 }];
    const w = computeShadow(0, 0, segs);
    // The upper shadow boundary is the ray through (300, 0) — i.e. the +x axis. Just below it is
    // dark, just above it is lit, at a range far from any hex boundary.
    expect(isShadowed(w, 700, 4)).toBe(true);
    expect(isShadowed(w, 700, -4)).toBe(false);
  });

  it('produces wedges that do not overlap — so a translucent fill stays uniform', () => {
    // Overlapping wedges would composite to a darker patch. Sample a dense grid; every point must
    // be covered at most once.
    const segs = [
      { x0: 200, y0: -100, x1: 200, y1: 100 },
      { x0: -150, y0: 40, x1: -150, y1: 300 },
      { x0: 60, y0: -260, x1: 240, y1: -180 },
    ];
    const w = computeShadow(0, 0, segs);
    let sampled = 0;
    for (let px = -900; px <= 900; px += 37) {
      for (let py = -900; py <= 900; py += 37) {
        if (Math.hypot(px, py) > FAR * 0.95) continue;
        expect(shadowedBy(w, px, py)).toBeLessThanOrEqual(1);
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(1000);
  });

  it('a nearer blocker shadows more of the world than the same blocker further away', () => {
    const near = computeShadow(0, 0, [{ x0: 100, y0: -50, x1: 100, y1: 50 }]);
    const far = computeShadow(0, 0, [{ x0: 400, y0: -50, x1: 400, y1: 50 }]);
    const count = (w) => {
      let n = 0;
      for (let px = -900; px <= 900; px += 20) for (let py = -900; py <= 900; py += 20) if (isShadowed(w, px, py)) n++;
      return n;
    };
    expect(count(near)).toBeGreaterThan(count(far));
  });

  it('fails OPEN when the viewer is standing on a blocker, rather than blacking out the screen', () => {
    const onWall = computeShadow(0, 0, [{ x0: 0, y0: -100, x1: 0, y1: 100 }]);
    expect(onWall).toEqual([]);
  });
});

describe('collectShadowSegments', () => {
  const at = (map) => (q, r) => map.get(`${q},${r}`);

  it('finds nothing on open ground', () => {
    const t = new Map();
    expect(collectShadowSegments(0, 0, 400, at(t))).toEqual([]);
  });

  it('ignores SOFT cover — forest and scrub never dim, for a mech-sized viewer', () => {
    const t = new Map([['3,0', 'forest'], ['2,1', 'scrub']]);
    expect(collectShadowSegments(0, 0, 500, at(t))).toEqual([]);
  });

  it('reduces a hard-cover hex to its six-corner outline', () => {
    const t = new Map([['3,0', 'alertTower']]);
    const segs = collectShadowSegments(0, 0, 500, at(t));
    expect(segs.length).toBe(6);
    // Every segment is one hex edge long.
    for (const s of segs) expect(Math.hypot(s.x1 - s.x0, s.y1 - s.y0)).toBeCloseTo(HEX_SIZE, 3);
  });

  it('emits only the SILHOUETTE of a blocking cluster, not interior edges', () => {
    // Two adjacent blocking hexes: 12 edges total, but the shared one is interior.
    const t = new Map([['3,0', 'alertTower'], ['4,0', 'alertTower']]);
    const segs = collectShadowSegments(0, 0, 700, at(t));
    expect(segs.length).toBe(10);
  });

  it('never lets the viewer own hex cast a shadow', () => {
    const home = pixelToHex(0, 0);
    const t = new Map([[`${home.q},${home.r}`, 'alertTower']]);
    expect(collectShadowSegments(0, 0, 400, at(t))).toEqual([]);
  });

  it('includes standing wall spans and excludes destroyed ones', () => {
    const t = new Map();
    const wallEdges = [
      { x0: 100, y0: -50, x1: 100, y1: 50, destroyed: false },
      { x0: 140, y0: -50, x1: 140, y1: 50, destroyed: true },
    ];
    const segs = collectShadowSegments(0, 0, 400, at(t), { wallEdges });
    expect(segs.length).toBe(1);
    expect(segs[0].x0).toBe(100);
  });

  it('an OPEN gate casts no shadow — it is a hole you can see through (#309)', () => {
    const wallEdges = [
      { x0: 100, y0: -50, x1: 100, y1: 50, destroyed: false, role: SPAN_ROLE_GATE, open: true },
      { x0: 140, y0: -50, x1: 140, y1: 50, destroyed: false, role: SPAN_ROLE_GATE, open: false },
      { x0: 180, y0: -50, x1: 180, y1: 50, destroyed: false, role: SPAN_ROLE_WALL, open: false },
    ];
    const segs = collectShadowSegments(0, 0, 400, at(new Map()), { wallEdges });
    expect(segs.map((s) => s.x0)).toEqual([140, 180]);
  });

  it('a plain WALL span never counts as see-through, whatever its open flag says (#309)', () => {
    // Only a span whose role is `gate` can be open. Keying off `open` alone would silently punch a
    // hole in an ordinary wall if that field ever got set on one.
    const wallEdges = [{ x0: 100, y0: -50, x1: 100, y1: 50, destroyed: false, role: SPAN_ROLE_WALL, open: true }];
    expect(collectShadowSegments(0, 0, 400, at(new Map()), { wallEdges }).length).toBe(1);
  });

  it('culls blockers beyond the radius', () => {
    const t = new Map([['3,0', 'alertTower']]);
    const near = hexToPixel(3, 0);
    expect(collectShadowSegments(0, 0, 5000, at(t)).length).toBe(6);
    expect(collectShadowSegments(0, 0, Math.hypot(near.x, near.y) - HEX_SIZE * 2, at(t))).toEqual([]);
  });
});

describe('end to end', () => {
  it('a hard-cover hex dims the ground behind it and not beside it', () => {
    const t = new Map([['4,0', 'alertTower']]);
    const c = hexToPixel(4, 0);
    const w = computeShadowWedges(0, 0, 1200, (q, r) => t.get(`${q},${r}`));
    expect(w.length).toBeGreaterThan(0);
    // A point on the far side of that hex, along the same bearing, is dark.
    const k = 2.2;
    expect(isShadowed(w, c.x * k, c.y * k)).toBe(true);
    // A point the same distance out but 90° round is lit.
    expect(isShadowed(w, -c.y * k, c.x * k)).toBe(false);
  });
});
