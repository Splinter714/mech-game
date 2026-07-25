import { describe, it, expect } from 'vitest';
import {
  READOUT_MODES, normalizeReadoutMode, nextReadoutMode, readoutLabel,
  paperDollLayout, perimeterRun, PAPER_DOLL,
  mechPools, noneLayout,
  structureColor, hslToInt, STRUCTURE_RAMP,
  fusedLayout, FUSED_DOME_RISE, shieldArcLayout, SHIELD_ARC, armorDrainRect,
} from './healthReadout.js';
import { consoleBand, CONSOLE } from './hudLayout.js';
import { INTEGRITY_ORDER, integrityLayout } from './hudLayout.js';

const LOCS = INTEGRITY_ORDER;

describe('#448 readout modes', () => {
  // #448 playtest: NONE is the DEFAULT — a fresh run starts with no integrity display at all.
  it('starts on NONE', () => {
    expect(READOUT_MODES[0]).toBe('none');
    expect(normalizeReadoutMode(undefined)).toBe('none');
    expect(normalizeReadoutMode('nonsense')).toBe('none');
  });

  it('cycles none → bars → paperdoll → fused → none', () => {
    expect(nextReadoutMode('none')).toBe('bars');
    expect(nextReadoutMode('bars')).toBe('paperdoll');
    expect(nextReadoutMode('paperdoll')).toBe('fused');
    expect(nextReadoutMode('fused')).toBe('none');
  });

  // The ORB readout was deleted. A registry left on it from an earlier session must not strand the
  // HUD on a mode with no layout and no paint path — it reads, and cycles, as the default.
  it('treats a stale stored ORBS setting as the default', () => {
    expect(READOUT_MODES).not.toContain('orbs');
    expect(normalizeReadoutMode('orbs')).toBe('none');
    expect(nextReadoutMode('orbs')).toBe('none');
    expect(readoutLabel('orbs')).toBe('NONE');
  });

  it('is exactly the surviving four modes, NONE first', () => {
    expect(READOUT_MODES).toEqual(['none', 'bars', 'paperdoll', 'fused']);
    expect(readoutLabel('none')).toBe('NONE');
  });

  it('cycles from an unknown mode without getting stuck', () => {
    expect(READOUT_MODES).toContain(nextReadoutMode('junk'));
  });

  it('labels every mode', () => {
    for (const m of READOUT_MODES) expect(readoutLabel(m)).toMatch(/\S/);
    expect(readoutLabel('junk')).toBe(readoutLabel('none'));
  });
});

// #448 follow-up: NONE hides the integrity readout so the mech's own display can be judged alone.
// The requirement that has teeth is that the CONSOLE still lays out sensibly with nothing there.
describe('#448 the NONE readout', () => {
  const box = { anchorX: 300, bottomY: 790, availW: 0, side: 'left' };

  it('returns the same SHAPE every other mode does, so the shell stays mode-agnostic', () => {
    const L = noneLayout(box);
    for (const key of ['mode', 'x', 'w', 'top', 'bottom', 'labelY', 'headerY', 'segments', 'shieldLabel']) {
      expect(L).toHaveProperty(key);
    }
    expect(L.mode).toBe('none');
  });

  it('occupies NO width and draws NO segments, captions or shield', () => {
    const L = noneLayout(box);
    expect(L.w).toBe(0);
    expect(L.segments).toEqual([]);
    expect(L.shieldLabel).toBeNull();
  });

  it('reserves no header line above the tile row — the hole this mode exists to remove', () => {
    const L = noneLayout(box);
    expect(L.headerY).toBe(box.bottomY);
    expect(L.top).toBe(L.bottom);
  });

  it('lets the console band collapse to exactly its tile row', () => {
    const L = noneLayout(box);
    const b = consoleBand(1280, [{ blockW: L.w, tilesW: 404 }]);
    expect(b.w).toBe(404 + CONSOLE.padX * 2);
    expect(b.groups[0].tilesX).toBe(b.x + CONSOLE.padX);
  });
});

// #495: FUSED fuses the readout onto the skill tiles themselves, so — like NONE — it has no
// separate block to lay out beside the tile row.
describe('#495 fused layout', () => {
  const box = { anchorX: 300, bottomY: 790, availW: 0, side: 'left' };

  it('returns the same SHAPE every other mode does', () => {
    const L = fusedLayout(box);
    for (const key of ['mode', 'x', 'w', 'top', 'bottom', 'labelY', 'headerY', 'segments', 'shieldLabel']) {
      expect(L).toHaveProperty(key);
    }
    expect(L.mode).toBe('fused');
  });

  it('occupies NO width and draws no segments or shield caption — the readout lives ON the tiles', () => {
    const L = fusedLayout(box);
    expect(L.w).toBe(0);
    expect(L.segments).toEqual([]);
    expect(L.shieldLabel).toBeNull();
  });

  it('lets the console band collapse to exactly its tile row, same as NONE', () => {
    const L = fusedLayout(box);
    const b = consoleBand(1280, [{ blockW: L.w, tilesW: 404 }]);
    expect(b.w).toBe(404 + CONSOLE.padX * 2);
    expect(b.groups[0].tilesX).toBe(b.x + CONSOLE.padX);
  });

  it('FUSED_DOME_RISE clears the shield dome\'s own rise, with room to spare for its glow', () => {
    expect(FUSED_DOME_RISE).toBeGreaterThan(SHIELD_ARC.rise);
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

// #495 playtest (Jackson: "armor should not deplete AROUND the ability, it should deplete from
// top to bottom"): the fused readout's per-tile armor geometry, replacing `perimeterRun` for
// that one layer — a draining-tank overlay anchored to the tile's own bottom edge.
describe('#495 armor drain rect (fused, top-to-bottom)', () => {
  const rect = { x: 100, y: 200, w: 40, h: 60 };

  it('is zero-height at frac 0 and covers the whole tile at frac 1', () => {
    const empty = armorDrainRect(rect, 0);
    expect(empty.h).toBe(0);
    const full = armorDrainRect(rect, 1);
    expect(full.h).toBe(rect.h);
    expect(full.y).toBe(rect.y);
    expect(full.full).toBe(true);
  });

  it('is bottom-pinned: the overlay always reaches the tile\'s own bottom edge', () => {
    for (const f of [0.1, 0.5, 0.9, 1]) {
      const d = armorDrainRect(rect, f);
      expect(d.y + d.h).toBeCloseTo(rect.y + rect.h, 6);
    }
  });

  it("the TOP edge recedes downward as the fraction drops — never sideways", () => {
    const d3 = armorDrainRect(rect, 0.3);
    const d7 = armorDrainRect(rect, 0.7);
    expect(d3.x).toBe(rect.x);
    expect(d7.x).toBe(rect.x);
    expect(d3.w).toBe(rect.w);
    expect(d7.w).toBe(rect.w);
    // Less armor ⇒ a shorter overlay ⇒ its top edge sits FURTHER down (a bigger y) than a
    // healthier tile's — the "drains downward" behaviour Jackson asked for.
    expect(d3.y).toBeGreaterThan(d7.y);
  });

  it('height scales linearly with the fraction', () => {
    expect(armorDrainRect(rect, 0.25).h).toBeCloseTo(0.25 * rect.h, 6);
    expect(armorDrainRect(rect, 0.75).h).toBeCloseTo(0.75 * rect.h, 6);
  });

  it('`full` is true only at frac >= 1 — a partial drain\'s top edge stays a flat, unrounded line', () => {
    expect(armorDrainRect(rect, 0.99).full).toBe(false);
    expect(armorDrainRect(rect, 1).full).toBe(true);
  });

  it('clamps out-of-range fractions', () => {
    expect(armorDrainRect(rect, 1.5)).toEqual(armorDrainRect(rect, 1));
    expect(armorDrainRect(rect, -0.4).h).toBe(0);
  });
});

describe('#448 whole-mech aggregate pools', () => {
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

// Playtest follow-up (2026-07-23): paper-doll structure is shown by COLOUR, not fill level.
// A part's colour rides a continuous ramp light blue → purple → red as structure drops.
describe('#448 structure colour ramp (paper doll)', () => {
  const rgb = (int) => ({ r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff });
  // Recover the HUE (degrees) from a packed colour — the axis the ramp sweeps (blue ~200 →
  // purple ~280 → red ~358), so it climbs monotonically as structure drops.
  const hue = (int) => {
    const { r, g, b } = rgb(int);
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };

  it('endpoints hit the ramp anchors exactly', () => {
    const top = STRUCTURE_RAMP[0], bot = STRUCTURE_RAMP[STRUCTURE_RAMP.length - 1];
    expect(structureColor(1)).toBe(hslToInt(top.h, top.s, top.l));   // full → light blue
    expect(structureColor(0)).toBe(hslToInt(bot.h, bot.s, bot.l));   // dead-low → red
  });

  it('#448 playtest: the full-health endpoint is a DARK blue (well below the old ~0.66 lightness)', () => {
    // Jackson asked to "start with a darker blue" — pin that the top anchor's lightness is clearly
    // darker than the original 0.66 so the ramp never drifts back to the pale endpoint.
    expect(STRUCTURE_RAMP[0].l).toBeLessThanOrEqual(0.5);
    // and it is still recognisably BLUE (hue in the blue band), not darkened into something else.
    expect(STRUCTURE_RAMP[0].h).toBeGreaterThan(180);
    expect(STRUCTURE_RAMP[0].h).toBeLessThan(240);
  });

  it('full structure reads BLUE (blue channel dominant), low reads RED (red channel dominant)', () => {
    const full = rgb(structureColor(1));
    const low = rgb(structureColor(0));
    expect(full.b).toBeGreaterThan(full.r);
    expect(low.r).toBeGreaterThan(low.b);
  });

  it('the 0.5 anchor is the purple stop', () => {
    const mid = STRUCTURE_RAMP.find((s) => s.at === 0.5);
    expect(structureColor(0.5)).toBe(hslToInt(mid.h, mid.s, mid.l));
  });

  it('a 70% segment is a DISTINCT in-between colour, not snapped to a neighbour', () => {
    const c = structureColor(0.7);
    expect(c).not.toBe(structureColor(1));
    expect(c).not.toBe(structureColor(0.5));
    // and its hue sits strictly between its two anchor neighbours (full blue and half purple)
    expect(hue(c)).toBeGreaterThan(hue(structureColor(1)));
    expect(hue(c)).toBeLessThan(hue(structureColor(0.5)));
  });

  it('marches monotonically blue→purple→red as structure drops (continuous, no banding)', () => {
    const samples = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0];
    const hues = samples.map((f) => hue(structureColor(f)));
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]).toBeGreaterThan(hues[i - 1]);   // hue climbs 200→358 as frac decreases
    }
  });

  it('clamps out-of-range fractions to the endpoints', () => {
    expect(structureColor(1.4)).toBe(structureColor(1));
    expect(structureColor(-0.3)).toBe(structureColor(0));
  });

  it('hslToInt produces the expected pure primaries (sanity check on the converter)', () => {
    expect(hslToInt(0, 1, 0.5)).toBe(0xff0000);     // red
    expect(hslToInt(120, 1, 0.5)).toBe(0x00ff00);   // green
    expect(hslToInt(240, 1, 0.5)).toBe(0x0000ff);   // blue
    expect(hslToInt(0, 0, 1)).toBe(0xffffff);       // white
    expect(hslToInt(0, 0, 0)).toBe(0x000000);       // black
  });
});

// #495: the fused readout's whole-mech shield dome — two mirrored arcs over the top+sides of the
// tile row, sharing one apex at 12 o'clock, each retracting independently toward it as the shield
// fraction drops. New geometry (not `ringSweep`'s single clockwise sweep, not `perimeterRun`'s
// rectangular outline), so it gets its own coverage.
describe('#495 shield arc (fused)', () => {
  const rect = { x: 100, y: 500, w: 300, h: 80 };

  it('is empty at zero and a full quarter-turn polyline each side at one', () => {
    const empty = shieldArcLayout(rect, 0);
    expect(empty.left).toEqual([]);
    expect(empty.right).toEqual([]);

    const full = shieldArcLayout(rect, 1);
    expect(full.left.length).toBe(SHIELD_ARC.steps + 1);
    expect(full.right.length).toBe(SHIELD_ARC.steps + 1);
  });

  // #495 playtest (Jackson: shield should deplete from the MIDDLE out, not the sides in): each
  // arc is now anchored at its OUTER end (index 0) and grows toward the shared apex as the
  // fraction rises — the reverse of the original cut, which anchored at the apex (index 0) and
  // grew outward. So at full shield, the apex is the LAST point of each arc, not the first.
  it("both arcs reach the SAME apex point at full shield — the shared 12 o'clock they meet at", () => {
    const full = shieldArcLayout(rect, 1);
    const leftApex = full.left[full.left.length - 1];
    const rightApex = full.right[full.right.length - 1];
    expect(leftApex).toEqual(rightApex);
    expect(leftApex.y).toBeLessThan(rect.y);   // and it clears the row's own top edge
  });

  // The literal playtest ask: at LOW shield only two stubs near the outer sides survive, and the
  // gap at top-centre (the apex end of each arc) is what's missing.
  it('at low shield only a stub near each OUTER side survives — the apex end is what vanished first', () => {
    const low = shieldArcLayout(rect, 0.15);
    expect(low.left.length).toBeGreaterThan(1);
    // The surviving points are the OUTER end (index 0) growing a short way toward the apex —
    // none of them should have reached anywhere near the apex's own height.
    const apexY = shieldArcLayout(rect, 1).left[shieldArcLayout(rect, 1).left.length - 1].y;
    for (const pt of low.left) expect(pt.y).toBeGreaterThan(apexY);
    // And the fixed outer stub itself (index 0) is unchanged regardless of how little survives.
    expect(low.left[0]).toEqual(shieldArcLayout(rect, 1).left[0]);
  });

  it("is symmetric: the left arc mirrors the right arc around the row's own centre-x", () => {
    const full = shieldArcLayout(rect, 1);
    const cx = rect.x + rect.w / 2;
    for (let i = 0; i < full.left.length; i++) {
      expect(full.left[i].x - cx).toBeCloseTo(-(full.right[i].x - cx), 6);
      expect(full.left[i].y).toBeCloseTo(full.right[i].y, 6);
    }
  });

  it("each arc's reach grows monotonically with the fraction", () => {
    const reach = (frac) => {
      const L = shieldArcLayout(rect, frac).left;
      if (L.length < 2) return 0;
      const end = L[L.length - 1];
      return Math.hypot(end.x - L[0].x, end.y - L[0].y);
    };
    expect(reach(0.3)).toBeGreaterThan(reach(0));
    expect(reach(0.6)).toBeGreaterThan(reach(0.3));
    expect(reach(1)).toBeGreaterThan(reach(0.6));
  });

  it('the TRACK — the full dome — never depends on the live fraction (always-legible backing)', () => {
    const t0 = shieldArcLayout(rect, 0).track;
    const t1 = shieldArcLayout(rect, 1).track;
    expect(t0).toEqual(t1);
  });

  it('the track runs left-end → apex → right-end as one continuous polyline', () => {
    const { track } = shieldArcLayout(rect, 1);
    const full = shieldArcLayout(rect, 1);
    expect(track[0]).toEqual(full.left[0]);
    expect(track[track.length - 1]).toEqual(full.right[0]);
  });

  it('the dome clears the row: above the top edge, past both side edges', () => {
    const full = shieldArcLayout(rect, 1);
    const leftApex = full.left[full.left.length - 1];
    expect(leftApex.y).toBeLessThan(rect.y);
    expect(full.left[0].x).toBeLessThan(rect.x);
    expect(full.right[0].x).toBeGreaterThan(rect.x + rect.w);
  });

  // #495 playtest (Jackson: "the shield arc should wrap the row of four ability buttons"): each
  // side now genuinely wraps down the FULL height of the tile row — the outer end lands exactly
  // at the row's own bottom edge, not partway down it — reading as a capsule/bracket enclosing
  // the row rather than an arch with a partial droop.
  it("each side's outer end reaches the row's own BOTTOM edge — a full wrap, not a partial droop", () => {
    const full = shieldArcLayout(rect, 1);
    expect(full.left[0].y).toBeCloseTo(rect.y + rect.h, 5);
    expect(full.right[0].y).toBeCloseTo(rect.y + rect.h, 5);
  });

  it('clamps out-of-range fractions to the endpoints', () => {
    expect(shieldArcLayout(rect, 1.5).left.length).toBe(shieldArcLayout(rect, 1).left.length);
    expect(shieldArcLayout(rect, -0.4).left).toEqual([]);
  });
});
