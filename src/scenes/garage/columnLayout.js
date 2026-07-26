// Pure column-geometry math for GarageScene's per-column layout (#505 THIRD rework, playtest
// feedback — Jackson's exact asks: the loadout section should be "nearly identical to the
// in-game UI... just that same layout of buttons," the mech preview should be "the same height
// as that button layout AND should be left of those buttons," and the player label should sit
// "at the bottom below the mech preview art").
//
// GarageScene.js is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling guard
// tests in src/scenes/GarageScene.*.guard.test.js), so the actual pixel math that decides where
// everything in a column sits lives here instead, fully unit-tested with no Phaser involved.
//
// Critically, the loadout tile block itself is NOT reimplemented here — this module calls the
// REAL shared HUD layout function, `weaponAbilityRows` from ui/skillTiles.js (the exact function
// HudScene.js's arena console calls), so a future change to that shared layout (tile sizing, row
// order, spacing) applies to the Garage automatically. This module only decides the geometry
// AROUND that block: how much width the mech preview claims to its left, where the catalog and
// footer land relative to it.
import { weaponAbilityRows } from '../../ui/skillTiles.js';

export const COLUMN_PAD = 8;
export const HEADER_H = 34;
export const FOOTER_H = 18;
export const GAP = 8;
export const PREVIEW_TILE_GAP = 10;
export const PREVIEW_FRACTION = 0.38;   // share of the column's inner width the preview claims
export const TILE_MAX_SIZE = 60;

// Full column layout for a `w` x `h` column. Returns:
//   innerW    — usable width inside the column's own padding
//   catalog   — { x, y, w, h } for the WeaponCardList catalog
//   tiles     — { weapons, abilities } — the exact rects weaponAbilityRows returned, ready to
//               hand straight to drawSkillTile
//   preview   — { cx, cy, w, h } for the mech-preview panel, LEFT of the tile block, same
//               height as the block (both rows together)
//   label     — { cx, y } — where the player-number label sits, centered under the preview
export function garageColumnLayout(w, h, opts = {}) {
  const {
    pad = COLUMN_PAD, headerH = HEADER_H, footerH = FOOTER_H, gap = GAP,
    previewFraction = PREVIEW_FRACTION, previewTileGap = PREVIEW_TILE_GAP, tileMaxSize = TILE_MAX_SIZE,
  } = opts;
  const innerW = Math.max(0, w - pad * 2);
  const previewW = Math.max(0, Math.round(innerW * previewFraction));
  const tileAreaX = pad + previewW + previewTileGap;
  const tileAreaW = Math.max(0, innerW - previewW - previewTileGap);
  // The tile block is anchored to its own BOTTOM (leaving room for the footer label below it) —
  // weaponAbilityRows lays out from that bottom anchor upward and reports back `top`, whichever
  // row ended up physically highest, so this stays correct regardless of which row (weapon or
  // ability) the shared layout currently puts on top.
  const blockBottom = Math.max(headerH + gap, h - pad - footerH - gap);

  const { weapons, abilities, top } = weaponAbilityRows(tileAreaX, tileAreaW, {
    bottom: blockBottom, maxSize: tileMaxSize,
  });
  const blockTop = weapons.length ? top : blockBottom;
  const blockH = Math.max(0, blockBottom - blockTop);

  const catalogY = headerH + gap;
  const catalogH = Math.max(70, blockTop - gap - catalogY);

  const previewCx = pad + previewW / 2;
  const previewCy = blockTop + blockH / 2;

  return {
    innerW,
    catalog: { x: pad, y: catalogY, w: innerW, h: catalogH },
    tiles: { weapons, abilities },
    preview: { cx: previewCx, cy: previewCy, w: previewW, h: blockH },
    label: { cx: previewCx, y: blockBottom + gap * 0.5 },
  };
}
