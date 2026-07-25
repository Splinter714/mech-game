// #506: skillTiles.js's new ability-diamond layout primitives (diamondLayout/coreTileRect) and
// the generalized bindGlyph/emptyLabel opts on updateSkillTile, which now serve the HUD diamond
// and Garage ability/core mounting UI as well as the original 4 weapon tiles.

import { describe, it, expect } from 'vitest';
import { diamondLayout, coreTileRect, drawSkillTile, updateSkillTile, tileRow } from './skillTiles.js';
import { ABILITY_SLOTS, ABILITY_SLOT_LAYOUT } from '../data/anatomy.js';

// A chainable stub whose setText/setVisible/etc. actually mutate a plain field the test can
// read back — unlike skillTileLabelWrap.test.js's stub (which only needs the CONSTRUCTION-time
// style, never a post-hoc setter's effect), these tests assert on state applied via setText, so
// a pure "returns itself" no-op stub isn't enough.
function makeChainable(seed = {}) {
  const obj = { ...seed };
  for (const k of ['setOrigin', 'setColor', 'setAlpha', 'setPosition', 'setScale', 'setFillStyle',
    'setStrokeStyle', 'setSize', 'setDisplaySize', 'setTexture', 'setRotation', 'clear', 'lineStyle',
    'fillStyle', 'fillRoundedRect', 'strokeRoundedRect', 'beginPath', 'moveTo', 'lineTo', 'strokePath']) {
    obj[k] = () => obj;
  }
  obj.setText = (s) => { obj.text = s; return obj; };
  obj.setVisible = (v) => { obj.visible = v; return obj; };
  return obj;
}

function stubScene() {
  return {
    add: {
      text: (x, y, str) => makeChainable({ x, y, text: str }),
      image: () => makeChainable(),
      rectangle: () => makeChainable(),
      graphics: () => makeChainable(),
    },
  };
}

describe('diamondLayout (#506)', () => {
  it('places the 4 ability slots per ABILITY_SLOT_LAYOUT\'s unit offsets', () => {
    const cx = 100, cy = 200, size = 40, radius = 50;
    const rects = diamondLayout(cx, cy, { size, radius });
    expect(rects.map((r) => r.loc)).toEqual(ABILITY_SLOTS);
    for (const r of rects) {
      const { dx, dy } = ABILITY_SLOT_LAYOUT[r.loc];
      expect(r.x).toBe(Math.round(cx + dx * radius - size / 2));
      expect(r.y).toBe(Math.round(cy + dy * radius - size / 2));
      expect(r.w).toBe(size);
      expect(r.h).toBe(size);
    }
  });

  it('defaults radius from size when omitted', () => {
    const [top] = diamondLayout(0, 0, { size: 46 });
    // abilityY is dx:0, dy:-1 — its y offset is exactly -radius (size * 1.15) minus half-size.
    expect(top.y).toBe(Math.round(0 + -1 * (46 * 1.15) - 23));
  });
});

describe('coreTileRect (#506)', () => {
  it('centers a size x size box on (cx, cy) with loc "core"', () => {
    const r = coreTileRect(10, 20, 30);
    expect(r).toEqual({ loc: 'core', x: -5, y: 5, w: 30, h: 30 });
  });
});

describe('updateSkillTile bindGlyph/emptyLabel (#506)', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };

  it('honors an explicit bindGlyph instead of deriving from SKILL_BINDS', () => {
    const scene = stubScene();
    const refs = drawSkillTile(scene, { add() {} }, rect, { loc: 'abilityY', itemId: null, bindGlyph: 'Y' });
    expect(refs.bind.text).toBe('Y');
  });

  it('falls back to an empty glyph for a non-weapon loc when bindGlyph is omitted', () => {
    const scene = stubScene();
    const refs = drawSkillTile(scene, { add() {} }, rect, { loc: 'abilityY', itemId: null });
    expect(refs.bind.text).toBe('');
  });

  it('honors an explicit emptyLabel on an empty slot', () => {
    const scene = stubScene();
    const refs = drawSkillTile(scene, { add() {} }, rect, { loc: 'core', itemId: null, emptyLabel: 'core' });
    expect(refs.subtitle.text).toBe('core');
  });

  it('defaults emptyLabel to "weapon", preserving existing weapon-tile behavior', () => {
    const scene = stubScene();
    const refs = drawSkillTile(scene, { add() {} }, rect, { loc: 'leftArm', itemId: null });
    expect(refs.subtitle.text).toBe('weapon');
  });

  it('updateSkillTile re-applies a new bindGlyph/emptyLabel on an existing tile', () => {
    const scene = stubScene();
    const refs = drawSkillTile(scene, { add() {} }, rect, { loc: 'core', itemId: null });
    updateSkillTile(refs, { loc: 'core', itemId: null, bindGlyph: 'X', emptyLabel: 'core' });
    expect(refs.bind.text).toBe('X');
    expect(refs.subtitle.text).toBe('core');
  });
});

describe('tileRow still works unchanged alongside the new layouts (#506 regression guard)', () => {
  it('returns the 4 weapon-slot rects it always has', () => {
    const row = tileRow(0, 400, { y: 0 });
    expect(row).toHaveLength(4);
  });
});
