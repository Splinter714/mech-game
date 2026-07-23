// #422: the shield shell must sit a CONSISTENT distance outside the mech silhouette. Two earlier
// passes tried to get there by scaling the shell sprite (uniformly, then per-axis, then per-part)
// and both failed for the same structural reason: a scale displaces every edge in proportion to
// its own distance from the centre, so a mech that is wider than it is deep always ends up in a
// shell that is wider than it is deep.
//
// The fix is a real morphological DILATION baked into the shell raster: stamp the same drawing
// around a small circle of radius `pad` and take the union. These tests cover that primitive —
// that it translates positional args only (never sizes), that it restores the graphics to an
// untranslated state, and the property that actually matters: every stamped copy is displaced by
// the SAME distance, so the resulting margin is direction-independent.
import { describe, it, expect, vi } from 'vitest';
import { scaledGraphics, drawDilated, DILATE_STEPS, ART_SCALE } from './_frames.js';

// A Graphics double that just records what reached it.
function fakeGraphics() {
  return {
    rects: [],
    points: [],
    fillStyle: vi.fn(),
    lineStyle: vi.fn(),
    fillRect: vi.fn(function (x, y, w, h) { this.rects.push({ x, y, w, h }); }),
    fillCircle: vi.fn(),
    fillEllipse: vi.fn(function (x, y, w, h) { this.rects.push({ x, y, w, h }); }),
    fillTriangle: vi.fn(),
    fillPoints: vi.fn(function (pts) { this.points.push(pts); }),
  };
}

describe('scaledGraphics translate hook (#422)', () => {
  it('is a no-op by default — every existing bake is byte-identical', () => {
    const g = fakeGraphics();
    const sg = scaledGraphics(g);
    sg.fillRect(3, 5, 10, 20);
    expect(g.rects[0]).toEqual({ x: 3 * ART_SCALE, y: 5 * ART_SCALE, w: 10 * ART_SCALE, h: 20 * ART_SCALE });
  });

  it('translates POSITIONS but never sizes (a dilated part must not also get fatter)', () => {
    const g = fakeGraphics();
    const sg = scaledGraphics(g);
    sg.ox = 2; sg.oy = -1;
    sg.fillRect(3, 5, 10, 20);
    sg.fillEllipse(0, 0, 8, 4);
    expect(g.rects[0]).toEqual({ x: 5 * ART_SCALE, y: 4 * ART_SCALE, w: 10 * ART_SCALE, h: 20 * ART_SCALE });
    expect(g.rects[1]).toEqual({ x: 2 * ART_SCALE, y: -1 * ART_SCALE, w: 8 * ART_SCALE, h: 4 * ART_SCALE });
  });

  it('translates polygon points too (the player theme draws its plates as chamfered polys)', () => {
    const g = fakeGraphics();
    const sg = scaledGraphics(g);
    sg.ox = 1; sg.oy = 1;
    sg.fillPoints([{ x: 0, y: 0 }, { x: 4, y: 0 }], true);
    expect(g.points[0]).toEqual([
      { x: 1 * ART_SCALE, y: 1 * ART_SCALE },
      { x: 5 * ART_SCALE, y: 1 * ART_SCALE },
    ]);
  });
});

describe('drawDilated (#422)', () => {
  it('stamps the drawing once at rest plus once per ring step', () => {
    const sg = scaledGraphics(fakeGraphics());
    const draw = vi.fn();
    drawDilated(sg, 1.8, draw);
    expect(draw).toHaveBeenCalledTimes(DILATE_STEPS + 1);
  });

  it('displaces every stamp by exactly the same distance — that IS the consistent margin', () => {
    const sg = scaledGraphics(fakeGraphics());
    const pad = 1.8;
    const offsets = [];
    drawDilated(sg, pad, () => offsets.push([sg.ox, sg.oy]));

    const [rest, ...ring] = offsets;
    expect(rest).toEqual([0, 0]);
    expect(ring).toHaveLength(DILATE_STEPS);
    for (const [ox, oy] of ring) expect(Math.hypot(ox, oy)).toBeCloseTo(pad, 10);
    // ...and they fan out all the way around, so the growth is in EVERY direction, not one axis.
    expect(ring.some(([ox]) => ox > 0.5 * pad)).toBe(true);
    expect(ring.some(([ox]) => ox < -0.5 * pad)).toBe(true);
    expect(ring.some(([, oy]) => oy > 0.5 * pad)).toBe(true);
    expect(ring.some(([, oy]) => oy < -0.5 * pad)).toBe(true);
  });

  it('leaves the graphics untranslated afterwards, so later draws are unaffected', () => {
    const sg = scaledGraphics(fakeGraphics());
    drawDilated(sg, 1.8, () => {});
    expect(sg.ox).toBe(0);
    expect(sg.oy).toBe(0);
  });

  it('with no pad it is a single plain pass (the un-dilated bake)', () => {
    const sg = scaledGraphics(fakeGraphics());
    const draw = vi.fn();
    drawDilated(sg, 0, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(sg.ox).toBe(0);
  });

  it('the union covers a disc of radius pad around any drawn point (the octagon error is tiny)', () => {
    // Worst-case shortfall of an N-stamp ring vs a true disc, as a fraction of the pad.
    const shortfall = 1 - Math.cos(Math.PI / DILATE_STEPS);
    expect(shortfall).toBeLessThan(0.04);
  });
});
