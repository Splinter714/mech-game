// #378 — the shared magnetic-pickup pull rule, extracted from salvage.js so scrap and powerups
// run the SAME mechanism with different tuning tables.
import { describe, it, expect } from 'vitest';
import { magnetPull, SCRAP_MAGNET, POWERUP_MAGNET } from './magnet.js';

describe('magnetPull — the shared pull rule (#378)', () => {
  it('does not move a drop outside the radius', () => {
    const d = { x: SCRAP_MAGNET.radius + 1, y: 0 };
    expect(magnetPull(d, { x: 0, y: 0 }, 16, SCRAP_MAGNET)).toBeNull();
  });

  it('moves a drop inside the radius toward the target', () => {
    const d = { x: 100, y: 0 };
    const out = magnetPull(d, { x: 0, y: 0 }, 16, SCRAP_MAGNET);
    expect(out.x).toBeLessThan(100);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBe(0);
  });

  it('accelerates as the drop closes in — a near step is bigger than a far one', () => {
    const far = magnetPull({ x: SCRAP_MAGNET.radius - 5, y: 0 }, { x: 0, y: 0 }, 16, SCRAP_MAGNET);
    const near = magnetPull({ x: 60, y: 0 }, { x: 0, y: 0 }, 16, SCRAP_MAGNET);
    const farStep = (SCRAP_MAGNET.radius - 5) - far.x;
    const nearStep = 60 - near.x;
    expect(nearStep).toBeGreaterThan(farStep);
  });

  it('never overshoots the target', () => {
    const out = magnetPull({ x: 2, y: 0 }, { x: 0, y: 0 }, 10000, SCRAP_MAGNET);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it('is a no-op when the drop is exactly on the target, or with no time elapsed', () => {
    expect(magnetPull({ x: 5, y: 5 }, { x: 5, y: 5 }, 16, SCRAP_MAGNET)).toBeNull();
    expect(magnetPull({ x: 50, y: 0 }, { x: 0, y: 0 }, 0, SCRAP_MAGNET)).toBeNull();
  });

  it('tolerates a missing drop / target / tuning', () => {
    expect(magnetPull(null, { x: 0, y: 0 }, 16, SCRAP_MAGNET)).toBeNull();
    expect(magnetPull({ x: 1, y: 1 }, null, 16, SCRAP_MAGNET)).toBeNull();
    expect(magnetPull({ x: 1, y: 1 }, { x: 0, y: 0 }, 16, null)).toBeNull();
  });

  // --- walls (Jackson's 2026-07-20 reversal: the pull goes THROUGH them, on purpose) ---

  it('pulls straight through walls — geometry is deliberately not consulted', () => {
    // The rule takes no reachability predicate at all: a drop inside a compound drifts out to a
    // player standing outside it. Jackson: "magnet should pull through walls."
    const out = magnetPull({ x: 100, y: 0 }, { x: 0, y: 0 }, 16, SCRAP_MAGNET);
    expect(out.x).toBeLessThan(100);
  });

  it('converges all the way onto the target rather than stalling short of it', () => {
    // The anti-requirement of pulling through walls: a drop must never lodge against the inside
    // face of a wall just out of reach. Since the drift is pure position assignment toward the
    // player's own position, iterating always lands ON the player.
    let d = { x: 200, y: 0 };
    const target = { x: 0, y: 0 };
    for (let i = 0; i < 2000; i++) {
      const out = magnetPull(d, target, 16, SCRAP_MAGNET);
      if (!out) break;
      d = out;
    }
    expect(Math.hypot(d.x - target.x, d.y - target.y)).toBeLessThan(1);
  });

  // --- the two tuning tables ---

  it('gives powerups a slightly lower radius and a slightly lower pull than scrap', () => {
    expect(POWERUP_MAGNET.radius).toBeLessThan(SCRAP_MAGNET.radius);
    expect(POWERUP_MAGNET.minSpeed).toBeLessThan(SCRAP_MAGNET.minSpeed);
    expect(POWERUP_MAGNET.maxSpeed).toBeLessThan(SCRAP_MAGNET.maxSpeed);
    // "slightly", not "barely" and not "an order of magnitude" — both stay in the same ballpark.
    expect(POWERUP_MAGNET.radius / SCRAP_MAGNET.radius).toBeGreaterThan(0.5);
    expect(POWERUP_MAGNET.maxSpeed / SCRAP_MAGNET.maxSpeed).toBeGreaterThan(0.5);
  });

  it('pulls a powerup less far than scrap over the same frame from the same distance', () => {
    const from = { x: 120, y: 0 }, to = { x: 0, y: 0 };
    const scrap = magnetPull(from, to, 16, SCRAP_MAGNET);
    const pw = magnetPull(from, to, 16, POWERUP_MAGNET);
    expect(120 - pw.x).toBeLessThan(120 - scrap.x);
  });

  it('leaves a powerup outside its (smaller) radius alone where scrap would still be pulled', () => {
    const between = { x: (POWERUP_MAGNET.radius + SCRAP_MAGNET.radius) / 2, y: 0 };
    expect(magnetPull(between, { x: 0, y: 0 }, 16, POWERUP_MAGNET)).toBeNull();
    expect(magnetPull(between, { x: 0, y: 0 }, 16, SCRAP_MAGNET)).not.toBeNull();
  });
});
