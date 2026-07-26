// #506: skillTiles.js's new ability-diamond layout primitives (diamondLayout/coreTileRect) and
// the generalized bindGlyph/emptyLabel opts on updateSkillTile, which now serve the HUD diamond
// and Garage ability/core mounting UI as well as the original 4 weapon tiles.

import { describe, it, expect } from 'vitest';
import {
  diamondLayout, coreTileRect, drawSkillTile, updateSkillTile, tileRow,
  isWideTile, wideTileLayout, weaponAbilityRows, TILE_ORDER, HUD_ABILITY_ORDER,
} from './skillTiles.js';
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
  it('places every ABILITY_SLOTS entry per ABILITY_SLOT_LAYOUT\'s unit offsets', () => {
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
    const [left] = diamondLayout(0, 0, { size: 46 });
    // abilityY is dx:-1, dy:0 — its x offset is exactly -radius (size * 1.15) minus half-size.
    expect(left.x).toBe(Math.round(0 + -1 * (46 * 1.15) - 23));
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

// #506 THIRD rework: the ability tiles' width-fill fix. A tile only counts as WIDE when its
// aspect departs meaningfully from square — a normal weapon tile never trips it, no matter how
// small the window shrinks it.
describe('isWideTile (#506 third rework)', () => {
  it('is false for every square weapon-tile size tileRow can produce', () => {
    for (const size of [46, 60, 92, 132]) {
      expect(isWideTile({ x: 0, y: 0, w: size, h: size })).toBe(false);
    }
  });

  it('is true for a double-wide/half-height ability tile', () => {
    const size = 92;
    const rect = { x: 0, y: 0, w: size * 2 + 12, h: Math.round(size / 2) };
    expect(isWideTile(rect)).toBe(true);
  });
});

// `wideTileLayout` is the pure geometry `drawSkillTile`/`updateSkillTile` use to lay a wide
// tile's icon-left/text-right content out — pinned directly so the "always inside the rect,
// column never negative" invariant doesn't depend on booting Phaser.
describe('wideTileLayout (#506 third rework)', () => {
  const rectFor = (weaponSize) => ({
    x: 20, y: 50, w: weaponSize * 2 + 12, h: Math.round(weaponSize / 2),
  });

  it('sizes the icon off the tile\'s own HEIGHT, not its width, so it never overflows vertically', () => {
    for (const weaponSize of [46, 60, 92, 132]) {
      const rect = rectFor(weaponSize);
      const L = wideTileLayout(rect);
      expect(L.iconSize).toBeLessThanOrEqual(rect.h);
      expect(L.iconSize).toBeGreaterThan(0);
    }
  });

  it('keeps the icon fully inside the rect horizontally', () => {
    const rect = rectFor(92);
    const L = wideTileLayout(rect);
    expect(L.iconCx - L.iconSize / 2).toBeGreaterThanOrEqual(rect.x);
    expect(L.iconCx + L.iconSize / 2).toBeLessThanOrEqual(rect.x + rect.w);
  });

  it('gives the text column real, positive width to the right of the icon, at both size extremes', () => {
    for (const weaponSize of [46, 92]) {
      const rect = rectFor(weaponSize);
      const L = wideTileLayout(rect);
      expect(L.colX).toBeGreaterThan(L.iconCx);
      expect(L.colW).toBeGreaterThan(0);
      // The column never runs past the tile's own right edge.
      expect(L.colX + L.colW).toBeLessThanOrEqual(rect.x + rect.w);
    }
  });
});

// #506 THIRD rework (playtest experiment): the ability row moved from above the weapon row to
// below it. Pinned directly against the pure layout function (HudScene's own geometry tests in
// hudPanels.test.js pin the same thing through the scene wiring).
describe('weaponAbilityRows — ability row below the weapon row (#506 third rework)', () => {
  it('anchors the ability row to `bottom` and puts the weapon row above it', () => {
    const bottom = 800;
    const { weapons, abilities, top } = weaponAbilityRows(0, 800, { bottom, maxSize: 92 });
    expect(weapons).toHaveLength(4);
    expect(abilities).toHaveLength(2);
    // Abilities sit at the very bottom of the block...
    expect(abilities[0].y + abilities[0].h).toBe(bottom);
    // ...and the weapon row is physically ABOVE them (smaller y), separated by the row gap.
    expect(weapons[0].y).toBeLessThan(abilities[0].y);
    expect(abilities[0].y - (weapons[0].y + weapons[0].h)).toBe(12);   // default rowGap
    // `top` reports whichever row is now highest — the weapon row.
    expect(top).toBe(weapons[0].y);
  });

  it('still matches each ability tile\'s span exactly to its weapon pair', () => {
    const { weapons, abilities } = weaponAbilityRows(0, 800, { bottom: 800, maxSize: 92 });
    const [leftArm, leftTorso, rightTorso, rightArm] = weapons;
    const [x, y] = abilities;
    expect(x.x).toBe(leftArm.x);
    expect(x.x + x.w).toBe(leftTorso.x + leftTorso.w);
    expect(y.x).toBe(rightTorso.x);
    expect(y.x + y.w).toBe(rightArm.x + rightArm.w);
  });

  it('assigns HUD_ABILITY_ORDER (X then Y) to the left/right slots respectively', () => {
    const { abilities } = weaponAbilityRows(0, 800, { bottom: 800, maxSize: 92 });
    expect(abilities.map((a) => a.loc)).toEqual(HUD_ABILITY_ORDER);
  });

  it('returns empty rows and falls back top to `bottom` when there are no weapon slots', () => {
    const { weapons, abilities, top } = weaponAbilityRows(0, 800, { bottom: 800, weaponOrder: [] });
    expect(weapons).toEqual([]);
    expect(abilities).toEqual([]);
    expect(top).toBe(800);
  });
});

// Ties `wideTileLayout`'s geometry to what `drawSkillTile`/`updateSkillTile` actually apply to a
// live tile — a regression guard against the icon-sizing formula drifting back to `rect.w`-based
// sizing (the original bug: an icon sized off the WIDTH of a short/wide tile overflows it
// vertically while only covering half the width).
describe('drawSkillTile/updateSkillTile icon sizing on a wide tile (#506 third rework)', () => {
  function wideStubScene() {
    const images = [];
    return {
      scene: {
        add: {
          text: (x, y, str) => ({
            x, y, text: str,
            setOrigin: function () { return this; },
            setColor: function () { return this; },
            setVisible: function () { return this; },
            setText: function (t) { this.text = t; return this; },
          }),
          image: (x, y) => {
            const img = {
              x, y, displaySize: null,
              setVisible: function () { return this; },
              setTexture: function () { return this; },
              setAlpha: function () { return this; },
              setDisplaySize: function (w, h) { this.displaySize = { w, h }; return this; },
            };
            images.push(img);
            return img;
          },
          rectangle: () => ({ setOrigin: function () { return this; }, setVisible: function () { return this; }, setFillStyle: function () { return this; }, setScale: function () { return this; } }),
          graphics: () => ({ clear: function () { return this; }, lineStyle: function () { return this; }, strokeRoundedRect: function () { return this; }, fillStyle: function () { return this; }, fillRoundedRect: function () { return this; }, beginPath: function () { return this; }, moveTo: function () { return this; }, lineTo: function () { return this; }, strokePath: function () { return this; } }),
        },
      },
      images,
    };
  }

  it('sizes the icon off wideTileLayout, not rect.w, for a double-wide/half-height tile', () => {
    const { scene, images } = wideStubScene();
    const rect = { x: 0, y: 0, w: 196, h: 46 };   // 2×92 weapon tiles + 12 gap, half-height
    expect(isWideTile(rect)).toBe(true);
    drawSkillTile(scene, { add() {} }, rect, { loc: 'abilityX', itemId: 'dash', bindGlyph: 'X' });
    const expected = wideTileLayout(rect).iconSize;
    expect(images[0].displaySize).toEqual({ w: expected, h: expected });
    // Sanity: this is well under the old `rect.w * 0.46` formula (≈ 90) and fits inside the
    // tile's own 46px height — the bug this fix addresses.
    expect(expected).toBeLessThanOrEqual(rect.h);
  });

  it('leaves a normal square weapon tile\'s icon sizing exactly as it was (rect.w * 0.46)', () => {
    const { scene, images } = wideStubScene();
    const rect = { x: 0, y: 0, w: 92, h: 92 };
    expect(isWideTile(rect)).toBe(false);
    drawSkillTile(scene, { add() {} }, rect, { loc: 'leftArm', itemId: 'autocannon' });
    expect(images[0].displaySize).toEqual({ w: 92 * 0.46, h: 92 * 0.46 });
  });
});
