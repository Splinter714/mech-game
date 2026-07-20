import { describe, it, expect } from 'vitest';
import { miniProjector, clampToBox } from './minimap.js';

// A square box makes both axes scale identically, so the "2× view distance → box edge" contract
// is exact on BOTH axes — the cleanest fixture for the core projection guarantees.
const squareBox = { x: 0, y: 0, w: 40, h: 40 };
const squareView = { x: 0, y: 0, width: 100, height: 100 };   // focus at (50, 50)

describe('miniProjector — the follow-window projection (#383)', () => {
  it('maps the camera-centre point to the minimap centre', () => {
    const p = miniProjector(squareView, squareBox);
    const m = p.toMini(50, 50);   // the camera focus (view-rect centre)
    expect(m.x).toBeCloseTo(20);  // box centre x
    expect(m.y).toBeCloseTo(20);  // box centre y
    expect(m.x).toBeCloseTo(p.cx);
    expect(m.y).toBeCloseTo(p.cy);
  });

  it('maps a point at 2× the view distance to the minimap edge', () => {
    const p = miniProjector(squareView, squareBox);
    // The camera view's half-extent is 50; 2× that is 100 from the focus. A point that far out on
    // each axis must land exactly on the box border (the window shows 2× the view per axis).
    const right = p.toMini(50 + 100, 50);
    expect(right.x).toBeCloseTo(40);   // box right edge (x + w)
    expect(right.y).toBeCloseTo(20);
    const bottom = p.toMini(50, 50 + 100);
    expect(bottom.y).toBeCloseTo(40);  // box bottom edge (y + h)
    // Exactly on the edge still counts as inside the window.
    expect(p.inBox(right)).toBe(true);
    expect(p.inBox(bottom)).toBe(true);
  });

  it('clips points beyond the window (inBox is false off-window)', () => {
    const p = miniProjector(squareView, squareBox);
    const farRight = p.toMini(50 + 200, 50);   // 4× the view half-extent — well past the window
    expect(farRight.x).toBeGreaterThan(40);
    expect(p.inBox(farRight)).toBe(false);
    expect(p.inBox(p.toMini(50, 50 - 300))).toBe(false);
  });

  it('derives the window from the live view rect (a smaller view ⇒ a tighter, more zoomed-in window)', () => {
    const wide = miniProjector({ x: 0, y: 0, width: 200, height: 200 }, squareBox);
    const tight = miniProjector({ x: 0, y: 0, width: 100, height: 100 }, squareBox);
    // Halving the view halves the world span the box covers, i.e. doubles the pixels-per-world.
    expect(tight.scale).toBeCloseTo(wide.scale * 2);
  });

  it('uses a uniform min-fit scale on a non-square box (the tighter axis constrains, undistorted)', () => {
    const box = { x: 0, y: 0, w: 152, h: 128 };
    const view = { x: 0, y: 0, width: 1280, height: 720 };   // 16:9, wider than the box
    const p = miniProjector(view, box);
    // x is the tighter axis here: min(152/2560, 128/1440) = 152/2560.
    expect(p.scale).toBeCloseTo(152 / (2 * 1280));
    // On the constraining (x) axis the window covers EXACTLY 2× the view: focus.x + view.width
    // (= 2× the view half-extent) lands on the right border.
    const edge = p.toMini(p.focusX + view.width, p.focusY);
    expect(edge.x).toBeCloseTo(box.x + box.w);
    // The looser (y) axis covers MORE than 2×, so a point at 2× the view half-extent falls short
    // of the border (letterboxed) but stays inside the box.
    const shortY = p.toMini(p.focusX, p.focusY + view.height);
    expect(shortY.y).toBeLessThan(box.y + box.h);
    expect(p.inBox(shortY)).toBe(true);
  });

  it('translates the window as the focus moves (a fixed world point slides opposite the camera)', () => {
    const a = miniProjector({ x: 0, y: 0, width: 100, height: 100 }, squareBox);
    const b = miniProjector({ x: 40, y: 0, width: 100, height: 100 }, squareBox);   // camera moved +40 in x
    const worldPoint = { x: 50, y: 50 };
    // Same world point, but the camera slid right by 40 world units ⇒ it should read further LEFT
    // on the map by 40 × scale.
    expect(b.toMini(worldPoint.x, worldPoint.y).x)
      .toBeCloseTo(a.toMini(worldPoint.x, worldPoint.y).x - 40 * a.scale);
  });
});

describe('clampToBox — the off-window objective edge marker (#383)', () => {
  const box = { x: 0, y: 0, w: 40, h: 40 };   // centre (20, 20)

  it('pins a marker to the box border on the ray toward the target', () => {
    // Target straight to the right of centre — lands on the right border, pointing right (angle 0).
    const m = clampToBox(box, 20, 20, { x: 100, y: 20 });
    expect(m.x).toBeCloseTo(40);
    expect(m.y).toBeCloseTo(20);
    expect(m.angle).toBeCloseTo(0);
  });

  it('honours the inset so the marker sits just inside the border', () => {
    const m = clampToBox(box, 20, 20, { x: 100, y: 20 }, 4);
    expect(m.x).toBeCloseTo(36);   // 40 - inset
  });

  it('clamps a diagonal target to the nearer border and keeps the true heading', () => {
    // Up-and-to-the-right: dy has the larger magnitude relative to the box half, so the TOP border
    // (y = 0) is the nearer crossing.
    const m = clampToBox(box, 20, 20, { x: 20 + 30, y: 20 - 90 });
    expect(m.y).toBeCloseTo(0);                 // clamped to the top border
    expect(m.x).toBeGreaterThan(20);            // still biased right of centre
    expect(m.x).toBeLessThan(40);
    expect(m.angle).toBeCloseTo(Math.atan2(-90, 30));
  });
});
