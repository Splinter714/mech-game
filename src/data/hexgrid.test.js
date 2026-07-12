import { describe, it, expect } from 'vitest';
import {
  hexToPixel, pixelToHex, neighbors, distance, range, ring, axialKey, HEX_SIZE,
  nearestHex, hexesWithinPixelRadius, scatterOffset, hexesAlongSegment,
} from './hexgrid.js';

describe('hexgrid neighbors', () => {
  it('returns exactly 6 distinct adjacent hexes', () => {
    const ns = neighbors(0, 0);
    expect(ns).toHaveLength(6);
    const keys = new Set(ns.map((h) => axialKey(h.q, h.r)));
    expect(keys.size).toBe(6);
  });

  it('every neighbor is distance 1 away', () => {
    for (const n of neighbors(3, -2)) {
      expect(distance({ q: 3, r: -2 }, n)).toBe(1);
    }
  });
});

describe('hexgrid distance', () => {
  it('is zero to itself and symmetric', () => {
    const a = { q: 2, r: -1 }, b = { q: -3, r: 4 };
    expect(distance(a, a)).toBe(0);
    expect(distance(a, b)).toBe(distance(b, a));
  });

  it('matches a known straight-line distance', () => {
    expect(distance({ q: 0, r: 0 }, { q: 3, r: 0 })).toBe(3);
    expect(distance({ q: 0, r: 0 }, { q: 0, r: -4 })).toBe(4);
  });
});

describe('hexgrid pixel round-trip', () => {
  it('pixelToHex(hexToPixel(h)) recovers h for a spread of coords', () => {
    for (let q = -5; q <= 5; q++) {
      for (let r = -5; r <= 5; r++) {
        const p = hexToPixel(q, r);
        const back = pixelToHex(p.x, p.y);
        expect(back).toEqual({ q, r });
      }
    }
  });

  it('honours a custom size', () => {
    const p = hexToPixel(2, -1, 20);
    expect(pixelToHex(p.x, p.y, 20)).toEqual({ q: 2, r: -1 });
    expect(HEX_SIZE).toBeGreaterThan(0);
  });
});

describe('hexgrid range + ring', () => {
  it('range(c, n) has the centered-hexagonal-number count 3n(n+1)+1', () => {
    const center = { q: 0, r: 0 };
    expect(range(center, 0)).toHaveLength(1);
    expect(range(center, 1)).toHaveLength(7);
    expect(range(center, 2)).toHaveLength(19);
    expect(range(center, 3)).toHaveLength(37);
  });

  it('ring(c, n) has 6n hexes, all exactly n away', () => {
    const center = { q: 1, r: 1 };
    const r2 = ring(center, 2);
    expect(r2).toHaveLength(12);
    for (const h of r2) expect(distance(center, h)).toBe(2);
    expect(ring(center, 0)).toEqual([center]);
  });
});

describe('hexgrid nearestHex (reachable-drop search, #73)', () => {
  // Model a small world: passable iff inside radius R AND not in a blocked set. This is the
  // exact shape the arena uses (in-disc + passable-terrain predicate), kept pure here.
  const R = 5;
  const makeOk = (blocked = new Set()) => (q, r) =>
    distance({ q: 0, r: 0 }, { q, r }) <= R && !blocked.has(axialKey(q, r));

  it('returns an already-valid spot unchanged (distance 0)', () => {
    const ok = makeOk();
    expect(nearestHex({ q: 2, r: -1 }, ok)).toEqual({ q: 2, r: -1 });
  });

  it('resolves an off-map death spot to an in-world passable hex', () => {
    const ok = makeOk();
    const found = nearestHex({ q: 40, r: -40 }, ok);
    expect(found).not.toBeNull();
    expect(distance({ q: 0, r: 0 }, found)).toBeLessThanOrEqual(R);
    expect(ok(found.q, found.r)).toBe(true);
  });

  it('resolves a spot inside a wall/water blob to the nearest passable hex outside it', () => {
    // Block the 7-hex disc around the origin; the nearest passable ring is distance 2.
    const blocked = new Set(range({ q: 0, r: 0 }, 1).map((h) => axialKey(h.q, h.r)));
    const ok = makeOk(blocked);
    const found = nearestHex({ q: 0, r: 0 }, ok);
    expect(found).not.toBeNull();
    expect(ok(found.q, found.r)).toBe(true);
    expect(distance({ q: 0, r: 0 }, found)).toBe(2);
  });

  it('returns null when nothing within range passes (caller supplies a fallback)', () => {
    expect(nearestHex({ q: 0, r: 0 }, () => false, 3)).toBeNull();
  });
});

describe('scatterOffset (spread simultaneous drops, #88)', () => {
  it('two independent calls from the same origin land at different positions', () => {
    const a = scatterOffset(100, 100, 30);
    const b = scatterOffset(100, 100, 30);
    // Astronomically unlikely to collide with the real Math.random, but guard against a
    // degenerate implementation that always returns the same point regardless.
    expect(a).not.toEqual(b);
  });

  it('is deterministic given an injected rand, and varies when the rand sequence varies', () => {
    const seqA = [0.25, 0.5];   // angle=0.5π, r=sqrt(0.5)*30
    const seqB = [0.75, 0.5];   // different angle, same radius fraction
    const randFrom = (seq) => { let i = 0; return () => seq[i++ % seq.length]; };
    const a1 = scatterOffset(0, 0, 30, randFrom(seqA));
    const a2 = scatterOffset(0, 0, 30, randFrom(seqA));
    expect(a1).toEqual(a2);   // same rand sequence → same offset (pure fn)
    const b = scatterOffset(0, 0, 30, randFrom(seqB));
    expect(b).not.toEqual(a1);
  });

  it('the offset is bounded by maxR (never wanders farther than the given radius)', () => {
    for (let i = 0; i < 200; i++) {
      const p = scatterOffset(500, -200, 30);
      expect(Math.hypot(p.x - 500, p.y - (-200))).toBeLessThanOrEqual(30 + 1e-9);
    }
  });

  it('a scattered point still resolves to reachable ground via nearestHex (#73 composition)', () => {
    // Same passability model as the nearestHex describe block above: an in-disc, non-blocked
    // predicate. Confirms scatterOffset composes cleanly with the existing #73 relocation path
    // — scatter first, then snap — rather than fighting it.
    const R = 5;
    const ok = (q, r) => distance({ q: 0, r: 0 }, { q, r }) <= R;
    for (let i = 0; i < 50; i++) {
      const scattered = scatterOffset(0, 0, 30);
      const hex = nearestHex(pixelToHex(scattered.x, scattered.y), ok, 40);
      expect(hex).not.toBeNull();
      expect(ok(hex.q, hex.r)).toBe(true);
    }
  });
});

describe('hexesWithinPixelRadius (#72 burning ground → terrain)', () => {
  it('a small circle returns just its containing hex', () => {
    const c = hexToPixel(3, -1);
    const hexes = hexesWithinPixelRadius(c.x, c.y, 10);
    expect(hexes).toEqual([{ q: 3, r: -1 }]);
  });

  it('a napalm-patch-sized circle centred on a hex burns that hex (not its neighbours)', () => {
    // Napalm's ground fire is radius 46 — neighbouring hex centres are ~83px away, so the
    // patch cooks the hex it lands on without bleeding a whole ring outward.
    const c = hexToPixel(0, 2);
    const hexes = hexesWithinPixelRadius(c.x, c.y, 46);
    expect(hexes).toEqual([{ q: 0, r: 2 }]);
  });

  it('a big circle sweeps in every hex whose centre it covers', () => {
    const c = hexToPixel(0, 0);
    const hexes = hexesWithinPixelRadius(c.x, c.y, HEX_SIZE * Math.sqrt(3) + 1);
    expect(hexes).toHaveLength(7);   // centre + all 6 neighbours
    for (const h of hexes) {
      const p = hexToPixel(h.q, h.r);
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(HEX_SIZE * Math.sqrt(3) + 1);
    }
  });

  it('an off-centre circle still includes the hex containing its centre point', () => {
    // Near a hex corner, the containing hex's CENTRE can be farther than r — it must still burn.
    const c = hexToPixel(2, 2);
    const hexes = hexesWithinPixelRadius(c.x + HEX_SIZE * 0.8, c.y, 5);
    expect(hexes.length).toBeGreaterThanOrEqual(1);
    const centre = pixelToHex(c.x + HEX_SIZE * 0.8, c.y);
    expect(hexes).toContainEqual(centre);
  });
});

// #159: swept-path hex enumeration, used by collision to stop a fast mech from tunneling
// through a wall it only grazes at a shallow angle (an endpoint-only point check can miss it).
// Comparisons below go through `axialKey` rather than raw object equality: `cubeRound` can
// legitimately produce a signed `-0` for a coordinate that rounds to zero (e.g. {q:-0,r:0} vs
// {q:0,r:0}) depending on which side of zero the fractional input approached from — numerically
// identical hexes (`-0 === 0`, and axialKey stringifies both the same way), but `toEqual`'s deep
// equality treats them as different objects. Not a real bug, just an assertion-robustness detail.
describe('hexgrid hexesAlongSegment', () => {
  const key = (h) => axialKey(h.q, h.r);

  it('a zero-length segment returns just its own hex', () => {
    expect(hexesAlongSegment(10, 10, 10, 10).map(key)).toEqual([key(pixelToHex(10, 10))]);
  });

  it('a short segment that stays within one hex returns only that hex', () => {
    const c = hexToPixel(0, 0);
    expect(hexesAlongSegment(c.x - 2, c.y - 2, c.x + 2, c.y + 2).map(key)).toEqual(['0,0']);
  });

  // #159 regression: an earlier version nudged BOTH endpoints of the interpolation by a fixed
  // epsilon (the textbook line-drawing tie-break) — which could flip an ENDPOINT's own hex to a
  // different one than a plain, un-nudged `pixelToHex` of that exact same point. Reproduced with
  // real gameplay coordinates (a light-chassis substep driving due "north" — x staying exactly
  // 0 — approaching a hex-vertex boundary near y=-48): the segment reported its far endpoint as
  // hex (1,-1) while `pixelToHex(0, -48.24)` (what `_blocked` actually checks) said (0,-1) — the
  // wall hex the mech was about to enter — so the swept check missed it and the mech tunneled in.
  it('always agrees with plain pixelToHex at both endpoints — never a different hex', () => {
    expect(key(pixelToHex(0, -48.24))).toBe('0,-1');
    const hexes = hexesAlongSegment(0, -42.21, 0, -48.24);
    expect(key(hexes[0])).toBe(key(pixelToHex(0, -42.21)));
    expect(key(hexes[hexes.length - 1])).toBe(key(pixelToHex(0, -48.24)));
    expect(hexes.map(key)).toEqual(['0,0', '0,-1']);
  });

  it('endpoints match plain pixelToHex across a broad sweep of angles/distances (no drift)', () => {
    for (let deg = 0; deg < 360; deg += 5) {
      const ang = (deg * Math.PI) / 180;
      for (const dist of [10, 30, 48.24, 60, 100, 150]) {
        const x0 = 0, y0 = 0;
        const x1 = Math.cos(ang) * dist, y1 = Math.sin(ang) * dist;
        const hexes = hexesAlongSegment(x0, y0, x1, y1);
        expect(key(hexes[0])).toBe(key(pixelToHex(x0, y0)));
        expect(key(hexes[hexes.length - 1])).toBe(key(pixelToHex(x1, y1)));
      }
    }
  });

  it('returns a connected path — every consecutive pair is hex-adjacent (or identical only at the ends)', () => {
    const hexes = hexesAlongSegment(0, 0, 300, 260);
    expect(hexes.length).toBeGreaterThan(1);
    for (let i = 1; i < hexes.length; i++) {
      expect(distance(hexes[i - 1], hexes[i])).toBe(1);
    }
  });

  it('the path length (hex count) matches the axial distance between the endpoint hexes', () => {
    const start = pixelToHex(0, 0);
    const end = pixelToHex(300, 260);
    const hexes = hexesAlongSegment(0, 0, 300, 260);
    expect(hexes.length).toBe(distance(start, end) + 1);
  });

  it('never skips the wall hex a straight path grazes at a shallow/corner-on angle', () => {
    // The scenario that motivated this function: force one hex a bit past the mech's own hex to
    // an arbitrary id and confirm sweeping the segment toward it always finds it, at an angle
    // deliberately chosen to clip the hex near its corner (the case a fixed-size position
    // substep can skip clean over, since the corner cross-section is much narrower than the
    // substep length — see locomotion.js's `_drive` comment).
    const wallHex = { q: 1, r: -1 };
    const wallCentre = hexToPixel(wallHex.q, wallHex.r);
    // Aim just past the wall hex's centre so the segment terminates beyond it, grazing through.
    const beyond = { x: wallCentre.x * 1.1, y: wallCentre.y * 1.1 };
    const hexes = hexesAlongSegment(0, 0, beyond.x, beyond.y);
    expect(hexes).toContainEqual(wallHex);
  });
});
