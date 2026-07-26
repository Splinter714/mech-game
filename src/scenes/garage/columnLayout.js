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
// slot "avatar" icon top-left, the "READY?" pill top-right) is gone — the passive slot now rides
// inside the shared ability row (`gl.tiles.abilities`, via weaponAbilityRows) and the "READY?"
// pill became GarageScene's compact ready indicator next to the PLAYER # label. Nothing draws in
// the column's own top strip any more, so there's nothing left to reserve space for.
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
//               hand straight to drawSkillTile — always at the arena's full TILE_SIZE. The
//               passive/core slot is now ONE of the three `abilities` rects (folded into the
//               shared ability row alongside X/Y — see skillTiles.js's `weaponAbilityRows`
//               #526-followup redesign), not a separate Garage-only tile any more.
//   preview   — { cx, cy, w, h } for the mech-preview panel: SQUARE, sized to and centered on the
//               FULL combined ability-row+weapon-row block height (both rows together) — its
//               original sizing, restored now that the passive slot lives inside the shared
//               ability row instead of its own tile stacked above the preview (see the removed
//               `passive` rect below)
//   panel     — { x, y, w, h } the FULL bounding box of the ability+weapon block PLUS a small
//               top buffer (see below), flush with the column's own bottom padding (no leftover
//               footer gap below it, #505 sixth rework) — this is what GarageScene's click-
//               blocker/top-border are sized to, so a scrolled-out (masked but still input-live)
//               catalog card underneath can never catch a click meant for the panel or the dead
//               space around it (Refs #528)
//   label     — { cx, y } — where the player-number label sits, centered horizontally on the
//               preview and anchored INSIDE it, near its bottom edge (#505 playtest follow-up:
//               "move the PLAYER N label to sit inside the preview box, at its bottom" — it used
//               to sit just below the preview box entirely)
//
// #505 EIGHTH rework (follow-up, Refs #505): the passive/core slot no longer gets its own
// Garage-only tile stacked above the preview — the shared `weaponAbilityRows` redesign folded it
// into the SAME row as X/Y (1.5x/1x/1.5x widths), so there is nothing left here for the preview's
// height to "leave room for" on the tile-block side. The preview re-expands back to matching the
// FULL combined ability-row+weapon-row block height (its size before the fifth rework's shrink),
// and the old `passive` rect computation (and its lockstep-with-the-preview math) is gone —
// dead code once the passive tile moved into `weaponAbilityRows`'s own output.
//
// Gap fix (same follow-up): the block already sits flush with the column's own bottom padding —
// tiles touch `blockBottom` exactly, then `pad` of clear space separates that from the column's
// true bottom edge. There was no matching clear space between the ABILITY row's own top edge and
// the panel's top border (the two touched directly, zero gap) even though a `gap`-sized buffer
// already existed between the catalog above and the block below. `panel.y` now sits one `gap`
// higher than the ability row's own top (flush with the catalog's own bottom edge instead of the
// tiles), so the panel/border/blocker owns that buffer directly — the ability row reads with the
// same small breathing room above it that the weapon row already has below it.
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

  // First pass at x=0 purely to measure the combined block's own square size (its `y`/`h`s don't
  // depend on x, only on width/bottom/maxSize) — the preview derives its sizing/position from this
  // pass before the pair's real x offset is known. #505 eighth rework: the preview is SQUARE,
  // sized to the FULL combined ability-row+weapon-row height again (its pre-fifth-rework size),
  // now that the passive slot lives inside the shared ability row instead of its own tile.
  const probe = weaponAbilityRows(0, tileBlockW, { bottom: blockBottom, maxSize: tileSize });
  const probeTop = probe.weapons.length ? probe.top : blockBottom;
  const previewSize = blockBottom - probeTop;

  // The pair — square preview (matching the combined block's own height), then the fixed-width
  // tile block — centered as ONE unit.
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
  const previewCy = weapons.length ? (blockTop + blockBottom) / 2 : blockBottom - previewSize / 2;

  // The panel's own top sits one `gap` above the ability row's top edge — flush with the
  // catalog's own bottom edge instead of the tiles themselves — so the panel/border/blocker owns
  // a small buffer above the ability row, matching the `pad`-sized buffer the weapon row already
  // has below it (down to the column's own bottom padding). See the gap-fix note above.
  const panelTop = blockTop - gap;

  // The full panel bounding box, spanning the column's own inner width (same x/w as the catalog
  // above it) so the click-blocker/top-border cover it edge to edge, with no leftover strip of
  // dead space either side or below.
  const panel = { x: pad, y: panelTop, w: innerW, h: blockBottom - panelTop };

  return {
    innerW,
    catalog: { x: pad, y: catalogY, w: innerW, h: catalogH },
    tiles: { weapons, abilities },
    preview: { cx: previewCx, cy: previewCy, w: previewSize, h: previewSize },
    panel,
    label: { cx: previewCx, y: previewCy + previewSize / 2 - labelBottomInset },
  };
}
