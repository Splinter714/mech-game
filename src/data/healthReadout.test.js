import { describe, it, expect } from 'vitest';
import {
  READOUT_MODES, normalizeReadoutMode, nextReadoutMode, readoutLabel,
  orbLayout, orbFillPolygon, ORBS,
  paperDollLayout, perimeterRun, PAPER_DOLL,
  mechPools,
} from './healthReadout.js';
import { INTEGRITY_BARS, INTEGRITY_ORDER, integrityLayout } from './hudLayout.js';

const LOCS = INTEGRITY_ORDER;

describe('#448 readout modes', () => {
  it('starts on the SHIPPED bars readout', () => {
    expect(READOUT_MODES[0]).toBe('bars');
    expect(normalizeReadoutMode(undefined)).toBe('bars');
    expect(normalizeReadoutMode('nonsense')).toBe('bars');
  });

  it('cycles bars → orbs → paperdoll → bars', () => {
    expect(nextReadoutMode('bars')).toBe('orbs');
    expect(nextReadoutMode('orbs')).toBe('paperdoll');
    expect(nextReadoutMode('paperdoll')).toBe('bars');
  });

  it('cycles from an unknown mode without getting stuck', () => {
    expect(READOUT_MODES).toContain(nextReadoutMode('junk'));
  });

  it('labels every mode', () => {
    for (const m of READOUT_MODES) expect(readoutLabel(m)).toMatch(/\S/);
    expect(readoutLabel('junk')).toBe(readoutLabel('bars'));
  });
});

describe('#448 orb layout', () => {
  const base = { anchorX: 20, bottomY: 600, availW: 0, side: 'left' };

  it('lays three globes out left→right: hp, armor, then the whole-mech shield', () => {
    const L = orbLayout(base);
    expect(L.orbs.map((o) => o.key)).toEqual(['hp', 'armor', 'shield']);
    for (let i = 1; i < L.orbs.length; i++) expect(L.orbs[i].cx).toBeGreaterThan(L.orbs[i - 1].cx);
  });

  it('shares the bar block\'s baseline and label line exactly', () => {
    const bars = integrityLayout(LOCS, base);
    const L = orbLayout(base);
    expect(L.bottom).toBe(bars.bottom);
    expect(L.labelY).toBe(bars.labelY);
  });

  it('reserves the shield globe even on a build with no shield (nothing shifts)', () => {
    // The layout takes no shield flag at all — the slot is unconditional, which is the point.
    expect(orbLayout(base).orbs).toHaveLength(3);
  });

  it('hangs off the anchor on the correct side', () => {
    const left = orbLayout({ ...base, side: 'left', anchorX: 100 });
    const right = orbLayout({ ...base, side: 'right', anchorX: 100 });
    expect(left.x).toBe(100);
    expect(right.x + right.w).toBeCloseTo(100, 6);
    expect(left.w).toBeCloseTo(right.w, 6);
  });

  it('squeezes into a cramped half but never below the minimum radius', () => {
    const wide = orbLayout({ ...base, availW: 0 });
    const tight = orbLayout({ ...base, availW: 40 });
    expect(tight.r).toBeLessThan(wide.r);
    expect(tight.r).toBeGreaterThanOrEqual(ORBS.minR - 1e-9);
  });

  it('never grows past full size when there is room to spare', () => {
    const roomy = orbLayout({ ...base, availW: 5000 });
    expect(roomy.r).toBeCloseTo(Math.min(ORBS.maxR, INTEGRITY_BARS.barH / 2), 6);
  });

  it('leaves the header line clear above the globes', () => {
    const L = orbLayout(base);
    expect(L.headerY).toBeLessThan(L.top);
    expect(L.top).toBeLessThan(L.bottom);
  });
});

describe('#448 orb fill polygon', () => {
  it('is empty at zero', () => {
    expect(orbFillPolygon(0, 0, 20, 0)).toEqual([]);
    expect(orbFillPolygon(0, 0, 20, -1)).toEqual([]);
  });

  it('drains from the TOP down — every point stays inside the disc', () => {
    for (const frac of [0.1, 0.4, 0.75, 1]) {
      for (const p of orbFillPolygon(50, 50, 20, frac)) {
        expect(Math.hypot(p.x - 50, p.y - 50)).toBeLessThanOrEqual(20 + 1e-6);
      }
    }
  });

  it('half full reaches the centre line and no higher', () => {
    const pts = orbFillPolygon(50, 50, 20, 0.5);
    const top = Math.min(...pts.map((p) => p.y));
    expect(top).toBeCloseTo(50, 6);
  });

  it('full covers the whole disc top to bottom', () => {
    const pts = orbFillPolygon(50, 50, 20, 1);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(30, 6);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(70, 6);
  });

  it('a fuller globe is never shorter than an emptier one', () => {
    const heights = [0.2, 0.5, 0.9].map((f) => {
      const pts = orbFillPolygon(0, 0, 10, f);
      return Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    });
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeGreaterThan(heights[1]);
  });

  it('clamps above full rather than overflowing the disc', () => {
    const pts = orbFillPolygon(0, 0, 10, 4);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-10, 6);
  });
});

describe('#448 paper doll layout', () => {
  const base = { anchorX: 20, bottomY: 600, availW: 0, side: 'left' };

  it('draws one segment per damage-tracked location, in body order', () => {
    const L = paperDollLayout(LOCS, base);
    expect(L.segments.map((s) => s.loc)).toEqual(LOCS);
    for (let i = 1; i < L.segments.length; i++) {
      expect(L.segments[i].x).toBeGreaterThan(L.segments[i - 1].x);
    }
  });

  it('arms are narrower and shorter than torsos, hanging from the same shoulder line', () => {
    const L = paperDollLayout(LOCS, base);
    const arm = L.segments.find((s) => s.loc === 'leftArm');
    const torso = L.segments.find((s) => s.loc === 'leftTorso');
    expect(arm.w).toBeLessThan(torso.w);
    expect(arm.h).toBeLessThan(torso.h);
    expect(arm.y).toBe(torso.y);           // same shoulder
    expect(arm.y + arm.h).toBeLessThan(torso.y + torso.h);
  });

  it('the shield outline encloses EVERY segment with clearance', () => {
    const L = paperDollLayout(LOCS, base);
    for (const s of L.segments) {
      expect(s.x).toBeGreaterThan(L.outline.x);
      expect(s.x + s.w).toBeLessThan(L.outline.x + L.outline.w);
      expect(s.y).toBeGreaterThan(L.outline.y);
      expect(s.y + s.h).toBeLessThan(L.outline.y + L.outline.h);
    }
  });

  it('shares the bar block\'s baseline, height and label line', () => {
    const bars = integrityLayout(LOCS, base);
    const L = paperDollLayout(LOCS, base);
    expect(L.bottom).toBe(bars.bottom);
    expect(L.top).toBe(bars.top);
    expect(L.labelY).toBe(bars.labelY);
  });

  it('hangs off the anchor on the correct side', () => {
    const right = paperDollLayout(LOCS, { ...base, side: 'right', anchorX: 400 });
    expect(right.x + right.w).toBeCloseTo(400, 6);
  });

  it('squeezes into a cramped half but never below the minimum scale', () => {
    const tight = paperDollLayout(LOCS, { ...base, availW: 30 });
    const wide = paperDollLayout(LOCS, { ...base, availW: 0 });
    expect(tight.w).toBeLessThan(wide.w);
    expect(tight.w).toBeGreaterThanOrEqual(wide.w * PAPER_DOLL.minScale - 1e-6);
  });

  it('the shield needs no caption of its own — it IS the outline', () => {
    expect(paperDollLayout(LOCS, base).shieldLabel).toBeNull();
  });
});

describe('#448 perimeter run (an outline that can show a fraction)', () => {
  const rect = { x: 0, y: 0, w: 10, h: 20 };

  it('is empty at zero and a closed loop at full', () => {
    expect(perimeterRun(rect, 0)).toEqual([]);
    const full = perimeterRun(rect, 1);
    expect(full[0]).toEqual(full[full.length - 1]);
    expect(full).toHaveLength(5);
  });

  it('starts at the bottom-left corner and runs UP the left side first', () => {
    const pts = perimeterRun(rect, 0.1);
    expect(pts[0]).toEqual({ x: 0, y: 20 });
    expect(pts[1].x).toBe(0);
    expect(pts[1].y).toBeLessThan(20);
  });

  it('walks exactly frac × perimeter of length', () => {
    const total = 2 * (rect.w + rect.h);
    for (const f of [0.13, 0.37, 0.5, 0.82]) {
      const pts = perimeterRun(rect, f);
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      expect(len).toBeCloseTo(f * total, 6);
    }
  });

  it('grows monotonically with the fraction', () => {
    const runLen = (f) => {
      const pts = perimeterRun(rect, f);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      return len;
    };
    expect(runLen(0.6)).toBeGreaterThan(runLen(0.3));
    expect(runLen(0.9)).toBeGreaterThan(runLen(0.6));
  });

  it('clamps past full and refuses a degenerate rect', () => {
    expect(perimeterRun(rect, 5)).toHaveLength(5);
    expect(perimeterRun({ x: 0, y: 0, w: 0, h: 10 }, 0.5)).toEqual([]);
  });
});

describe('#448 aggregate pools for the orb readout', () => {
  const mech = (parts, shield = null) => ({
    parts,
    shield,
    hasShield: () => !!shield,
    shieldTotalHp: () => shield?.hp ?? 0,
  });

  it('sums only the locations the readout draws', () => {
    const p = mechPools(mech({
      leftArm: { hp: 5, maxHp: 10, armor: 0, maxArmor: 10 },
      leftTorso: { hp: 10, maxHp: 10, armor: 10, maxArmor: 10 },
      leftLeg: { hp: 0, maxHp: 100, armor: 0, maxArmor: 100 },   // not drawn ⇒ not counted
    }), ['leftArm', 'leftTorso']);
    expect(p.hp).toBeCloseTo(0.75, 6);
    expect(p.armor).toBeCloseTo(0.5, 6);
    expect(p.hasArmor).toBe(true);
  });

  it('reads zero (not NaN) for a mech with no parts at all', () => {
    const p = mechPools(mech({}), LOCS);
    expect(p.hp).toBe(0);
    expect(p.armor).toBe(0);
    expect(p.hasArmor).toBe(false);
    expect(p.hasShield).toBe(false);
  });

  it('never reports negative HP from an over-killed part', () => {
    const p = mechPools(mech({ leftArm: { hp: -50, maxHp: 10, armor: -5, maxArmor: 10 } }), ['leftArm']);
    expect(p.hp).toBe(0);
    expect(p.armor).toBe(0);
  });

  it('clamps a #381 temp shield pool to a full globe rather than overflowing', () => {
    const p = mechPools(mech({}, { hp: 250, max: 100 }), LOCS);
    expect(p.hasShield).toBe(true);
    expect(p.shield).toBe(1);
  });

  it('is null-safe', () => {
    expect(mechPools(null, LOCS).hp).toBe(0);
  });
});
