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
// #505 (fifth rework, playtest): the per-column header row that used to live here (the passive-
// slot "avatar" icon top-left, the "READY?" pill top-right) is gone — see the `passive` rect and
// GarageScene's compact ready indicator (next to the PLAYER # label) for where those two pieces
// moved. Nothing draws in the column's own top strip any more, so there's nothing left to reserve
// space for.
export const HEADER_H = 0;
// #505 (sixth rework, playtest): FOOTER_H used to reserve extra dead space below the tile block
// for a footer label that no longer exists (the PLAYER # label lives INSIDE the preview box now,
// see LABEL_BOTTOM_INSET) — that leftover reserve read as an unexplained empty gap under the
// panel, AND wasn't covered by the panel's own click-blocker (GarageScene's `col.panelBlocker`),
// so a scrolled catalog card sitting underneath it could still catch a click. Removed outright
// rather than zeroed, so nothing keeps referencing a footer that isn't drawn any more.
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
//   preview   — { cx, cy, w, h } for the mech-preview panel: SQUARE, sized to the WEAPON ROW's
//               own height (#505 fifth rework — see below), sitting immediately LEFT of the tile
//               block, aligned with the weapon row specifically (not the combined block)
//   passive   — { loc: 'core', x, y, w, h } for the passive/core slot's own tile, stacked directly
//               ABOVE the preview at the SAME width, sized to the ability tiles' own height —
//               mirrors the ability row's position on the tile-block side, so the two columns
//               (passive+preview / ability+weapon) read as one matched pair (#505 fifth rework)
//   panel     — { x, y, w, h } the FULL bounding box of the passive+preview+ability+weapon block,
//               flush with the column's own bottom padding (no leftover footer gap below it, #505
//               sixth rework) — this is what GarageScene's click-blocker/top-border are sized to,
//               so a scrolled-out (masked but still input-live) catalog card underneath can never
//               catch a click meant for the panel or the dead space around it (Refs #528)
//   label     — { cx, y } — where the player-number label sits, centered horizontally on the
//               preview and anchored INSIDE it, near its bottom edge (#505 playtest follow-up:
//               "move the PLAYER N label to sit inside the preview box, at its bottom" — it used
//               to sit just below the preview box entirely)
//
// #505 FIFTH rework (fresh playtest correction on top of the fourth): the mech preview used to
// span the FULL combined ability+weapon block height. Jackson's screenshot feedback moved the
// passive/core slot out of the old per-column header row and into a brand-new tile sitting above
// the preview, "same height as the X/Y ability tiles... same width as the mech preview box" —
// which only reads cleanly if the preview shrinks to match just the WEAPON row (its counterpart on
// the tile-block side), leaving the ability row's counterpart on the preview's side to be the new
// passive tile, not extra preview height. Because both the ability row and the passive tile are
// pinned to `blockTop` (the topmost row) and both the weapon row and the preview share their own Y
// span, the two side-by-side columns stay in lockstep automatically — no separate gap constant to
// keep in sync, it falls out of both sides reading their geometry off the SAME weaponAbilityRows
// call.
//
// The preview+tiles pair is centered as ONE unit within the column's inner width. At a narrow
// column width (more players, smaller colW — see GarageScene's `colW = W / session.count`) the
// pair's fixed width (full arena tile size + square preview) can exceed the column's own inner
// width; this deliberately does NOT shrink the tiles or the preview to compensate (that would
// contradict "the same size as it is in arena") — `pairX` simply goes negative and the group
// overflows the column visually. See columnLayout.test.js for the width this becomes a problem at.
export function garageColumnLayout(w, h, opts = {}) {
  const {
    pad = COLUMN_PAD, headerH = HEADER_H, gap = GAP,
    previewTileGap = PREVIEW_TILE_GAP, tileSize = TILE_SIZE, tileGap = TILE_GAP, tileN = TILE_N,
    labelBottomInset = LABEL_BOTTOM_INSET,
  } = opts;
  const innerW = Math.max(0, w - pad * 2);
  const tileBlockW = tileRowWidth(tileSize, tileN, tileGap);
  // The tile block is anchored to its own BOTTOM, flush with the column's own bottom padding (no
  // separate footer reserve any more, #505 sixth rework) — weaponAbilityRows lays out from that
  // bottom anchor upward and reports back `top`, whichever row ended up physically highest, so
  // this stays correct regardless of which row (weapon or ability) the shared layout currently
  // puts on top.
  const blockBottom = Math.max(headerH + gap, h - pad);

  // First pass at x=0 purely to measure the WEAPON row's own square size (its `y`/`h` don't depend
  // on x, only on width/bottom/maxSize) — the preview and the passive tile both derive their
  // sizing/position from this pass before the pair's real x offset is known.
  const probe = weaponAbilityRows(0, tileBlockW, { bottom: blockBottom, maxSize: tileSize });
  const previewSize = probe.weapons.length ? probe.weapons[0].h : 0;

  // The pair — square preview (matching the weapon row's own height), then the fixed-width tile
  // block — centered as ONE unit. The passive tile (below) stacks above the preview at this same
  // width, so the preview column's total footprint mirrors the tile column's exactly.
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
  const previewCy = weapons.length ? weapons[0].y + weapons[0].h / 2 : blockBottom - previewSize / 2;

  // The passive/core tile: same x/width as the preview, same y/height as the ability row — so it
  // sits directly above the preview, flush with the ability row's own top and bottom.
  const passive = abilities.length
    ? { loc: 'core', x: pairX, y: abilities[0].y, w: previewSize, h: abilities[0].h }
    : { loc: 'core', x: pairX, y: blockTop, w: previewSize, h: 0 };

  // The full panel bounding box — passive tile through the weapon row, spanning the column's own
  // inner width (same x/w as the catalog above it) so the click-blocker/top-border cover it edge
  // to edge, with no leftover strip of dead space either side or below.
  const panel = { x: pad, y: blockTop, w: innerW, h: blockBottom - blockTop };

  return {
    innerW,
    catalog: { x: pad, y: catalogY, w: innerW, h: catalogH },
    tiles: { weapons, abilities },
    preview: { cx: previewCx, cy: previewCy, w: previewSize, h: previewSize },
    passive,
    panel,
    label: { cx: previewCx, y: previewCy + previewSize / 2 - labelBottomInset },
  };
}
