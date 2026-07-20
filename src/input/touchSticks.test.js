import { describe, it, expect } from 'vitest';
import {
  TouchSticks, TOUCH_STICK, stickVector, stickSideFor, fixedOrigins, normalizeAngle,
} from './touchSticks.js';

const W = 800, H = 400;
const R = TOUCH_STICK.radius;

function sticks(cfg) {
  return new TouchSticks({ width: W, height: H, config: { ...TOUCH_STICK, ...cfg } });
}

describe('stickSideFor — screen halves (#346)', () => {
  it('left half drives, right half aims, midpoint belongs to aim', () => {
    expect(stickSideFor(10, W)).toBe('move');
    expect(stickSideFor(W / 2 - 1, W)).toBe('move');
    expect(stickSideFor(W / 2, W)).toBe('aim');
    expect(stickSideFor(W - 10, W)).toBe('aim');
  });
});

describe('stickVector — deadzone, clamping, curve (#346)', () => {
  const o = { x: 0, y: 0 };

  it('reads zero at the origin', () => {
    expect(stickVector(o, { x: 0, y: 0 })).toMatchObject({ x: 0, y: 0, mag: 0 });
  });

  it('reads zero inside the deadzone', () => {
    const inside = R * TOUCH_STICK.deadzone * 0.5;
    expect(stickVector(o, { x: inside, y: 0 }).mag).toBe(0);
  });

  it('starts from 0 (not a step) just past the deadzone', () => {
    const justOut = R * (TOUCH_STICK.deadzone + 0.001);
    const mag = stickVector(o, { x: justOut, y: 0 }).mag;
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(0.02);
  });

  it('reads full deflection at exactly the stick radius', () => {
    const v = stickVector(o, { x: R, y: 0 });
    expect(v.mag).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(1, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it('clamps beyond the radius instead of exceeding magnitude 1', () => {
    const v = stickVector(o, { x: R * 10, y: R * 10 });
    expect(v.mag).toBeCloseTo(1, 6);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('keeps direction while scaling magnitude', () => {
    const v = stickVector(o, { x: 0, y: R });
    expect(v.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(1, 6);
  });

  it('the response curve expands the low end (curve > 1 reads softer than linear)', () => {
    const p = { x: R * 0.5, y: 0 };
    const linear = stickVector(o, p, { curve: 1 }).mag;
    const curved = stickVector(o, p, { curve: TOUCH_STICK.moveCurve }).mag;
    expect(TOUCH_STICK.moveCurve).toBeGreaterThan(1);
    expect(curved).toBeLessThan(linear);
    expect(curved).toBeGreaterThan(0);
  });

  it('the response curve still reaches exactly 1 at full deflection', () => {
    expect(stickVector(o, { x: R, y: 0 }, { curve: TOUCH_STICK.moveCurve }).mag).toBeCloseTo(1, 6);
  });

  it('is monotonic in distance', () => {
    let prev = -1;
    for (let d = 0; d <= R; d += R / 20) {
      const m = stickVector(o, { x: d, y: 0 }, { curve: TOUCH_STICK.moveCurve }).mag;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
});

describe('normalizeAngle', () => {
  it('wraps into (-PI, PI]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 9);
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(Math.PI * 2.5)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('TouchSticks — floating origins (#346)', () => {
  it('places the stick where the thumb lands, not at a fixed spot', () => {
    const s = sticks();
    s.pointerDown(1, 120, 300);
    expect(s.stickState('move').origin).toEqual({ x: 120, y: 300 });

    s.pointerUp(1);
    s.pointerDown(2, 40, 90);
    expect(s.stickState('move').origin).toEqual({ x: 40, y: 90 });
  });

  it('reads zero move on touch-down (finger is at the origin)', () => {
    const s = sticks();
    s.pointerDown(1, 120, 300);
    expect(s.read().move).toEqual({ x: 0, y: 0 });
  });

  it('fixed mode anchors both sticks regardless of where the thumb lands', () => {
    const s = sticks({ floating: false });
    const anchors = fixedOrigins(W, H, TOUCH_STICK);
    s.pointerDown(1, 5, 5);
    s.pointerDown(2, W - 5, 5);
    expect(s.stickState('move').origin).toEqual(anchors.move);
    expect(s.stickState('aim').origin).toEqual(anchors.aim);
  });
});

describe('TouchSticks — movement stick → intent.move (#346)', () => {
  it('a downward drag on the left half gives a downward move vector', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, 100, 200 + R);
    const { move } = s.read();
    expect(move.x).toBeCloseTo(0, 6);
    expect(move.y).toBeCloseTo(1, 6);
  });

  it('never exceeds magnitude 1 however far the finger drags', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, 100 + R * 8, 200 + R * 8);
    const { move } = s.read();
    expect(Math.hypot(move.x, move.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('returns to zero move when the finger lifts', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, 100 + R, 200);
    expect(s.read().move.x).toBeCloseTo(1, 6);
    s.pointerUp(1);
    expect(s.read().move).toEqual({ x: 0, y: 0 });
  });
});

describe('TouchSticks — aim stick holds the last angle (#346)', () => {
  it('starts at the default aim angle before any touch', () => {
    const s = sticks();
    expect(s.read().aimAngle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('tracks the aim direction while the thumb is deflected', () => {
    const s = sticks();
    s.pointerDown(1, 600, 200);
    s.pointerMove(1, 600 + R, 200);
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
    s.pointerMove(1, 600, 200 + R);
    expect(s.read().aimAngle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('HOLDS the last angle after the thumb lifts (does not snap back)', () => {
    const s = sticks();
    s.pointerDown(1, 600, 200);
    s.pointerMove(1, 600, 200 + R);
    expect(s.read().aimAngle).toBeCloseTo(Math.PI / 2, 6);

    s.pointerUp(1);
    expect(s.read().aimAngle).toBeCloseTo(Math.PI / 2, 6);
    expect(s.read().aimAngle).toBeCloseTo(Math.PI / 2, 6); // still held, frame after frame
  });

  it('holds the last angle while the thumb rests inside the deadzone', () => {
    const s = sticks();
    s.pointerDown(1, 600, 200);
    s.pointerMove(1, 600 + R, 200);
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
    s.pointerMove(1, 600, 200 + R * TOUCH_STICK.deadzone * 0.5); // back near centre
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
  });

  it('a fresh touch does not re-aim until the thumb actually deflects', () => {
    const s = sticks();
    s.pointerDown(1, 600, 200);
    s.pointerMove(1, 600 + R, 200);
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
    s.pointerUp(1);
    s.pointerDown(2, 700, 100);           // new touch, no deflection yet
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
  });
});

describe('TouchSticks — two fingers, independent sticks (#346)', () => {
  it('drives and aims at the same time from two fingers', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerDown(2, 600, 200);
    s.pointerMove(1, 100 - R, 200);   // drive left
    s.pointerMove(2, 600, 200 - R);   // aim up
    const out = s.read();
    expect(out.move.x).toBeCloseTo(-1, 6);
    expect(out.aimAngle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('a stick stays owned by the finger that claimed it, even dragged across the midline', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, W - 50, 200);    // dragged deep into the aim half
    expect(s.stickState('aim')).toBeNull();
    expect(s.stickState('move')).not.toBeNull();
    expect(s.read().move.x).toBeCloseTo(1, 6);  // still driving, clamped
  });

  it('ignores a second finger landing on an already-owned half', () => {
    const s = sticks();
    expect(s.pointerDown(1, 100, 200)).toBe('move');
    expect(s.pointerDown(2, 200, 300)).toBeNull();
    expect(s.stickState('move').origin).toEqual({ x: 100, y: 200 });
    s.pointerMove(2, 200 + R, 300);            // the ignored finger controls nothing
    expect(s.read().move).toEqual({ x: 0, y: 0 });
  });

  it('lifting one finger leaves the other stick alone', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerDown(2, 600, 200);
    s.pointerMove(2, 600 + R, 200);
    s.pointerUp(1);
    expect(s.stickState('move')).toBeNull();
    expect(s.stickState('aim')).not.toBeNull();
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
  });

  it('ignores move/up for a pointer id that owns nothing', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    expect(s.pointerMove(99, 500, 500)).toBeNull();
    expect(s.pointerUp(99)).toBeNull();
    expect(s.stickState('move')).not.toBeNull();
  });
});

describe('TouchSticks — lifecycle (#346)', () => {
  it('is inactive and unused until a real touch arrives (desktop stays untouched)', () => {
    const s = sticks();
    expect(s.used).toBe(false);
    expect(s.isActive()).toBe(false);
    s.pointerDown(1, 100, 200);
    expect(s.used).toBe(true);
    expect(s.isActive()).toBe(true);
  });

  it('releaseAll drops every finger without forgetting the held aim angle', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerDown(2, 600, 200);
    s.pointerMove(2, 600 + R, 200);
    s.read();
    s.releaseAll();
    expect(s.isActive()).toBe(false);
    expect(s.read().move).toEqual({ x: 0, y: 0 });
    expect(s.read().aimAngle).toBeCloseTo(0, 6);
  });

  it('setViewport re-splits the halves after a rotate/resize', () => {
    const s = sticks();
    s.setViewport(200, 400);
    expect(s.pointerDown(1, 150, 100)).toBe('aim');  // 150 is the right half of 200
  });
});

describe('TouchSticks — HUD geometry (#346)', () => {
  it('reports no stick state for an untouched side', () => {
    const s = sticks();
    expect(s.stickState('move')).toBeNull();
    expect(s.stickState('aim')).toBeNull();
  });

  it('clamps the drawn knob to the stick radius', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, 100 + R * 5, 200);
    expect(s.stickState('move').knob.x).toBeCloseTo(R, 6);
  });

  it('tracks the knob 1:1 inside the radius', () => {
    const s = sticks();
    s.pointerDown(1, 100, 200);
    s.pointerMove(1, 100 + 20, 200 - 10);
    expect(s.stickState('move').knob).toEqual({ x: 20, y: -10 });
  });
});
