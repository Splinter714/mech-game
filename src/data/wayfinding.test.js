import { describe, it, expect } from 'vitest';
import { isPointInView, edgeArrowPosition } from './wayfinding.js';

const VIEW = { x: -100, y: -80, width: 200, height: 160 };   // centered on world origin

describe('isPointInView', () => {
  it('is true for a point inside the rect', () => {
    expect(isPointInView(VIEW, { x: 0, y: 0 })).toBe(true);
    expect(isPointInView(VIEW, { x: -100, y: -80 })).toBe(true);   // inclusive of edges
    expect(isPointInView(VIEW, { x: 100, y: 80 })).toBe(true);
  });

  it('is false for a point outside the rect', () => {
    expect(isPointInView(VIEW, { x: 500, y: 0 })).toBe(false);
    expect(isPointInView(VIEW, { x: 0, y: -500 })).toBe(false);
  });
});

describe('edgeArrowPosition', () => {
  const W = 400, H = 300;   // screen size mapping 2:1 onto VIEW's 200x160 world units

  it('points right and sits on the right inset edge when the target is due east', () => {
    const { x, y, angle } = edgeArrowPosition(VIEW, W, H, { x: 10000, y: 0 }, 20);
    expect(angle).toBeCloseTo(0, 5);
    expect(x).toBeCloseTo(W - 20, 5);   // clamped to the right inset edge (screen-center + halfW)
    expect(y).toBeCloseTo(H / 2, 5);    // no vertical component
  });

  it('points left and sits on the left inset edge when the target is due west', () => {
    const { x, y, angle } = edgeArrowPosition(VIEW, W, H, { x: -10000, y: 0 }, 20);
    expect(Math.abs(angle)).toBeCloseTo(Math.PI, 5);
    expect(x).toBeCloseTo(20, 5);
    expect(y).toBeCloseTo(H / 2, 5);
  });

  it('points down and sits on the bottom inset edge when the target is due south', () => {
    const { x, y, angle } = edgeArrowPosition(VIEW, W, H, { x: 0, y: 10000 }, 20);
    expect(angle).toBeCloseTo(Math.PI / 2, 5);
    expect(y).toBeCloseTo(H - 20, 5);
    expect(x).toBeCloseTo(W / 2, 5);
  });

  it('clamps to a corner when the target is at a matching diagonal (square view+screen)', () => {
    // Use a view whose aspect matches the screen so a 45-degree world direction stays 45 degrees
    // on screen and lands exactly at the inset corner.
    const squareView = { x: -100, y: -100, width: 200, height: 200 };
    const S = 300;
    const { x, y } = edgeArrowPosition(squareView, S, S, { x: 10000, y: 10000 }, 20);
    expect(x).toBeCloseTo(S - 20, 5);
    expect(y).toBeCloseTo(S - 20, 5);
  });

  it('stays on the rectangle boundary (never overshoots) for an arbitrary direction', () => {
    const { x, y } = edgeArrowPosition(VIEW, W, H, { x: 3000, y: -7000 }, 20);
    const onRight = Math.abs(x - (W - 20)) < 1e-6;
    const onLeftEdge = Math.abs(x - 20) < 1e-6;
    const onTop = Math.abs(y - 20) < 1e-6;
    const onBottom = Math.abs(y - (H - 20)) < 1e-6;
    expect(onRight || onLeftEdge || onTop || onBottom).toBe(true);
    expect(x).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(x).toBeLessThanOrEqual(W - 20 + 1e-6);
    expect(y).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(y).toBeLessThanOrEqual(H - 20 + 1e-6);
  });

  it('respects a larger margin by pulling the point further inward', () => {
    const tight = edgeArrowPosition(VIEW, W, H, { x: 10000, y: 0 }, 10);
    const loose = edgeArrowPosition(VIEW, W, H, { x: 10000, y: 0 }, 60);
    expect(loose.x).toBeLessThan(tight.x);
  });

  it('accepts a per-edge margin object and clamps a due-south target above the reserved bottom bar', () => {
    // Simulates the arena HUD: a tall bottom margin (the skill-tile toolbar) and a smaller top
    // margin, so a target straight below the player clamps well clear of the literal bottom
    // pixel row, above where the toolbar sits — not at H - <uniform margin>.
    const margins = { top: 20, right: 20, bottom: 110, left: 20 };
    const { x, y } = edgeArrowPosition(VIEW, W, H, { x: 0, y: 10000 }, margins);
    expect(y).toBeCloseTo(H - 110, 5);
    expect(x).toBeCloseTo(W / 2, 5);
  });

  it('per-edge margin: a due-north target clamps against the (independent) top margin', () => {
    const margins = { top: 60, right: 20, bottom: 110, left: 20 };
    const { x, y } = edgeArrowPosition(VIEW, W, H, { x: 0, y: -10000 }, margins);
    expect(y).toBeCloseTo(60, 5);
    expect(x).toBeCloseTo(W / 2, 5);
  });

  it('per-edge margin: a diagonal target clamps against whichever inset edge the ray hits first', () => {
    // Bottom margin (reserved toolbar) is larger than the others, so a south-east target clamps
    // on the bottom edge (reached first, given this view/screen's aspect) rather than the right.
    const margins = { top: 20, right: 20, bottom: 80, left: 20 };
    const { x, y } = edgeArrowPosition(VIEW, W, H, { x: 10000, y: 10000 }, margins);
    expect(y).toBeCloseTo(H - 80, 5);
    expect(x).toBeLessThan(W - 20);
  });

  it('handles a target exactly at screen-center without dividing by zero', () => {
    // Degenerate case: the target coincides with the camera center (no real direction to point
    // in). The function picks an arbitrary direction rather than NaN/crashing.
    const { x, y, angle } = edgeArrowPosition(VIEW, W, H, { x: 0, y: 0 }, 20);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(Number.isFinite(angle)).toBe(true);
  });
});
