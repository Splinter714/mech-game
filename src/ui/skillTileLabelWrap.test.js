// #330 regression guard. Skill-tile subtitles carry single long ONE-WORD item names
// ("Autocannon", "Repeater"). Phaser's default wordWrap only breaks on whitespace, so at
// narrow window widths — where tileRow shrinks the tiles well below the label's natural
// width — such a name overflows its tile and runs into the neighbouring one, reading as
// labels smashed together. `useAdvancedWrap: true` makes Phaser break mid-word once a
// single word exceeds the wrap width. This has been lost once already (the fix sat
// unmerged in an abandoned worktree), so pin it.

import { describe, it, expect } from 'vitest';
import { drawSkillTile, tileRow, TILE_ORDER } from './skillTiles.js';

// Minimal stub of the Phaser surface drawSkillTile touches. Text/Image/Rectangle factories
// record the style they were constructed with and no-op the chainable setters.
function stubScene() {
  const texts = [];
  const chainable = (obj) => new Proxy(obj, {
    get: (t, k) => (k in t ? t[k] : () => chainable(t)),
  });
  return {
    texts,
    add: {
      text(x, y, str, style) {
        const t = { x, y, text: str, style };
        texts.push(t);
        return chainable(t);
      },
      image: () => chainable({}),
      rectangle: () => chainable({}),
    },
  };
}

const drawTile = (rect) => {
  const scene = stubScene();
  drawSkillTile(scene, { add() {} }, rect, { loc: rect.loc, itemId: null });
  // The subtitle is the only text built with a wordWrap.
  return scene.texts.find((t) => t.style && t.style.wordWrap);
};

describe('skill-tile label wrapping (#330)', () => {
  it('wraps the subtitle mid-word so a long one-word name cannot escape its tile', () => {
    const sub = drawTile({ loc: 'leftArm', x: 0, y: 0, w: 120, h: 120 });
    expect(sub).toBeDefined();
    expect(sub.style.wordWrap.useAdvancedWrap).toBe(true);
  });

  it('keeps the wrap width inside the tile at every width tileRow can produce', () => {
    // A deliberately cramped row — the narrow-width case where the bug showed.
    for (const w of [480, 300, 200]) {
      for (const rect of tileRow(0, w, { y: 0 })) {
        const sub = drawTile(rect);
        expect(sub.style.wordWrap.width).toBeLessThan(rect.w);
        expect(sub.style.wordWrap.useAdvancedWrap).toBe(true);
      }
    }
  });

  it('tileRow never overlaps tiles, so a wrapped label stays in its own column', () => {
    const row = tileRow(0, 300, { y: 0 });
    expect(row).toHaveLength(TILE_ORDER.length);
    for (let i = 1; i < row.length; i++) {
      expect(row[i].x).toBeGreaterThanOrEqual(row[i - 1].x + row[i - 1].w);
    }
  });
});
