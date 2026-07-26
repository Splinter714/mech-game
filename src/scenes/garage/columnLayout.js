// Pure column-geometry math for GarageScene's per-column layout (#505 FOURTH rework, a fresh
// layout correction from Jackson on top of the THIRD rework's "preview left of tiles" move —
// his exact words: "I was expecting the mech preview and ability layout to be next to each
// other and then that whole bunch center aligned; I was also expecting the mech preview to be
// square and taller, matching the height of the ability layout, which should be the same size
// as it is in arena").
//
// GarageScene.js is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling guard
// tests in src/scenes/GarageScene.*.guard.test.js), so the actual pixel math that decides where
// everything in a column sits lives here instead, fully unit-tested with no Phaser involved.
//
// Critically, the loadout tile block itself is NOT reimplemented here — this module calls the
// REAL shared HUD layout function, `weaponAbilityRows` from ui/skillTiles.js (the exact function
// HudScene.js's arena console calls), so a future change to that shared layout (tile sizing, row
// order, spacing) applies to the Garage automatically. The tile SIZE is pinned to the arena's own
// `CONSOLE_TILES.max` (data/hudLayout.js) rather than fit to the column's width — "the same size
// as it is in arena," not a scaled-down copy — so the tile block always renders at full arena
// pixel dimensions here too. This module only decides the geometry AROUND that fixed-size block:
// the square preview's size (derived FROM the block's height), and how the preview+tiles pair,
// as ONE unit, centers in the column.
import { weaponAbilityRows } from '../../ui/skillTiles.js';
import { CONSOLE_TILES, tileRowWidth } from '../../data/hudLayout.js';

export const COLUMN_PAD = 8;
export const HEADER_H = 34;
export const FOOTER_H = 18;
export const GAP = 8;
export const PREVIEW_TILE_GAP = 10;
// #505 playtest follow-up: the player-number label sits INSIDE the preview box now, near its
// bottom edge, rather than below it — this is the gap from the box's own bottom edge to the top
// of the label text (the text itself, via GarageScene's `setOrigin(0.5, 0)`, then reads a few
// pixels above that bottom edge instead of clipping it).
export const LABEL_BOTTOM_INSET = 20;
// The loadout block's tile size/gap/count are pinned to the arena's own dial (CONSOLE_TILES),
// not a Garage-local constant — "the same size as it is in arena" means literally the same
// pixels, so there is nothing left here to independently tune.
export const TILE_SIZE = CONSOLE_TILES.max;
export const TILE_GAP = CONSOLE_TILES.gap;
export const TILE_N = CONSOLE_TILES.n;

// Full column layout for a `w` x `h` column. Returns:
//   innerW    — usable width inside the column's own padding
//   catalog   — { x, y, w, h } for the WeaponCardList catalog
//   tiles     — { weapons, abilities } — the exact rects weaponAbilityRows returned, ready to
//               hand straight to drawSkillTile — always at the arena's full TILE_SIZE
//   preview   — { cx, cy, w, h } for the mech-preview panel: SQUARE, sized to the tile block's
//               own height, sitting immediately LEFT of it
//   label     — { cx, y } — where the player-number label sits, centered horizontally on the
//               preview and anchored INSIDE it, near its bottom edge (#505 playtest follow-up:
//               "move the PLAYER N label to sit inside the preview box, at its bottom" — it used
//               to sit just below the preview box entirely)
//
// The preview+tiles pair is centered as ONE unit within the column's inner width. At a narrow
// column width (more players, smaller colW — see GarageScene's `colW = W / session.count`) the
// pair's fixed width (full arena tile size + square preview) can exceed the column's own inner
// width; this deliberately does NOT shrink the tiles or the preview to compensate (that would
// contradict "the same size as it is in arena") — `pairX` simply goes negative and the group
// overflows the column visually. See columnLayout.test.js for the width this becomes a problem at.
export function garageColumnLayout(w, h, opts = {}) {
  const {
    pad = COLUMN_PAD, headerH = HEADER_H, footerH = FOOTER_H, gap = GAP,
    previewTileGap = PREVIEW_TILE_GAP, tileSize = TILE_SIZE, tileGap = TILE_GAP, tileN = TILE_N,
    labelBottomInset = LABEL_BOTTOM_INSET,
  } = opts;
  const innerW = Math.max(0, w - pad * 2);
  const tileBlockW = tileRowWidth(tileSize, tileN, tileGap);
  // The tile block is anchored to its own BOTTOM (leaving room for the footer label below it) —
  // weaponAbilityRows lays out from that bottom anchor upward and reports back `top`, whichever
  // row ended up physically highest, so this stays correct regardless of which row (weapon or
  // ability) the shared layout currently puts on top.
  const blockBottom = Math.max(headerH + gap, h - pad - footerH - gap);

  // First pass at x=0 purely to measure the block's real height (weapon row + row gap + the half-
  // height ability row above it) — `top` doesn't depend on x, only on width/bottom/maxSize, so
  // this is safe to throw away once the pair's real x offset is known.
  const probe = weaponAbilityRows(0, tileBlockW, { bottom: blockBottom, maxSize: tileSize });
  const blockH = probe.weapons.length ? blockBottom - probe.top : 0;
  const previewSize = blockH;

  // The pair — square preview, then the fixed-width tile block — centered as ONE unit.
  const pairW = previewSize + previewTileGap + tileBlockW;
  const pairX = pad + (innerW - pairW) / 2;
  const tileAreaX = pairX + previewSize + previewTileGap;

  const { weapons, abilities, top } = weaponAbilityRows(tileAreaX, tileBlockW, {
    bottom: blockBottom, maxSize: tileSize,
  });
  const blockTop = weapons.length ? top : blockBottom;

  const catalogY = headerH + gap;
  const catalogH = Math.max(70, blockTop - gap - catalogY);

  const previewCx = pairX + previewSize / 2;
  const previewCy = blockTop + blockH / 2;

  return {
    innerW,
    catalog: { x: pad, y: catalogY, w: innerW, h: catalogH },
    tiles: { weapons, abilities },
    preview: { cx: previewCx, cy: previewCy, w: previewSize, h: previewSize },
    label: { cx: previewCx, y: previewCy + previewSize / 2 - labelBottomInset },
  };
}
