// Shared "skill bar" — the row of square skill-button tiles used by BOTH the garage and
// the arena HUD, so the two read identically. Each tile shows its control bind (big, mode-
// aware) and the mounted item's visual-effect icon; a subtitle line under the icon carries
// the item name (garage) or the live ammo / cooldown (arena), with an optional ammo bar.
//
// The garage rebuilds its tiles on every refresh (items change), so it just calls
// drawSkillTile. The arena builds its tiles once and updates them in place each frame via
// updateSkillTile (only ammo/cooldown/online change), to avoid per-frame object churn.

import { itemFxKey } from '../art/index.js';
import { getItem } from '../data/items.js';
import { SKILL_BINDS } from '../input/Controls.js';
import { ABILITY_SLOTS, ABILITY_SLOT_LAYOUT } from '../data/anatomy.js';
import { CONSOLE_TILES, ARMOR_PEEK_PAD } from '../data/hudLayout.js';
import { structureColor } from '../data/healthReadout.js';

// Body order, left → right: left arm · left torso · right torso · right arm. #188: the old
// centre-torso ability slot is gone (#261: L3/Space is a hardcoded Dash, not mounted), so
// this is now four weapon slots only. Still what the Garage's paper-doll tile row uses.
export const TILE_ORDER = ['leftArm', 'leftTorso', 'rightTorso', 'rightArm'];

// #506 SECOND rework (playtest): the first rework's one-row-of-6 didn't stick. Jackson: "move x/y
// abilities in weapon HUD to double-wide half-height buttons (as compared to the weapon buttons)
// that sit in a single row above the 4 weapon buttons; so the X ability sits above the left sided
// weapons and the Y ability above the right sided weapons." X is therefore first (left) here, Y
// second (right) — see `weaponAbilityRows` below, which is what actually places them.
export const HUD_ABILITY_ORDER = ['abilityX', 'abilityY'];

// #544 (Jackson: "LB and X/L3 button contents swap ... RB and Y/R3 button contents swap"): the
// two RENDER-POSITION swaps `weaponAbilityRows` applies at the end of its own layout — leftTorso's
// weapon-row rect trades screen geometry with abilityX's ability-row rect, and rightTorso's with
// abilityY's. Pure position swap: `mounts`/`abilityMounts`, TILE_ORDER, HUD_ABILITY_ORDER,
// SKILL_BINDS, ABILITY_BINDS and GarageScene's `_navSlot` are all untouched — see that function's
// own comment for the full reasoning.
const RENDER_SWAP_PAIRS = [
  ['leftTorso', 'abilityX'],
  ['rightTorso', 'abilityY'],
];

export const TILE_UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a',
  card: 0x131820, cardSel: 0x1b2430, edge: 0x2a333f, sel: 0xefc14a, slotEdge: 0x323c49, track: 0x0e1218,
  // #238: a distinct cool color for the "empty + locked out" cooldown state — separates it
  // visually from the plain warm/red "empty but actively regenerating" look so the player
  // isn't left wondering why the bar isn't creeping back up.
  cooldown: '#5e7ce0', cooldownHex: 0x5e7ce0,
  // #452: the button now reads as a physical KEY on a console rather than a flat swatch —
  // rounded corners and a soft halo just outside the edge so it pops off the console plate
  // behind it. Deliberately a small move: this is still the same tile, better lit.
  radius: 9,          // corner rounding
  // #544 (Jackson: "remove dog-ear styling from shield meter and overall panel" — his own words
  // for the nipped/cut-corner look): `nipRadius` and the whole per-corner "nip into the console's
  // own notch" treatment (#526) are gone — every tile now rounds all four corners at the same
  // plain `radius` above, ability tiles included. See `paintTilePlate` and `SHIELD_ARC.corner`
  // (healthReadout.js) for the matching removal on the shield-meter frame/panel side.
  edgeLit: 0x46566b,  // the crisp outer edge — brighter than the old flat `edge`
  halo: 0x5ec8e0,     // the faint outside-the-edge pop (the shared UI accent)
  // Live-chat ask: a hot, unmistakable halo while a weapon's trigger is actually down — distinct
  // from the cool accent `sel`/`halo` use for "focused/mounted" so the two states never blur.
  firing: 0xff9c3c, firingEdge: 0xffd199,
};

// Paint one tile's PLATE — the rounded body, its edge and the halo just outside it. A Graphics
// rather than a Rectangle purely because Phaser's Rectangle cannot round its corners; the tile's
// hit area is still the plain rect (see `drawSkillTile`).
//
// #544: this used to take an optional `nipCorners` flag that gave the double-wide ability tiles a
// bigger, asymmetric round on their own outer-top corner so they'd taper into the console's own
// nipped-corner notch (#526). Removed along with that notch shape — every tile, weapon or
// ability, now rounds all four corners at the same plain `TILE_UI.radius`.
//
// Live-chat ask: `firing` (true while the tile's own weapon is actively being fired, see
// scenes/arena/firing.js's `player.firingNow`) takes over the SAME halo+edge language `selected`
// already uses, just hotter — the two never co-occur in practice (`selected` is Garage-only,
// `firing` Arena-only), so one param each is enough; `firing` wins if somehow both were set.
export function paintTilePlate(g, rect, { selected = false, firing = false } = {}) {
  const { x, y, w, h } = rect;
  const r = Math.min(TILE_UI.radius, w / 4);
  g.clear();
  // Outside-the-edge halo: two fading passes, since plain Graphics has no blur (the same stacked-
  // silhouette stand-in the HUD's chevron glow and shield bar use).
  const haloCol = firing ? TILE_UI.firing : selected ? TILE_UI.sel : TILE_UI.halo;
  const haloBoost = firing ? 1.4 : 1;   // hotter/more opaque than a plain "selected" glow
  for (const [pad, a] of [[3.5, (selected || firing ? 0.20 : 0.07) * haloBoost], [1.5, (selected || firing ? 0.40 : 0.16) * haloBoost]]) {
    g.lineStyle(2, haloCol, Math.min(1, a));
    g.strokeRoundedRect(x - pad, y - pad, w + pad * 2, h + pad * 2, r + pad);
  }
  // The plate itself.
  g.fillStyle(selected ? TILE_UI.cardSel : TILE_UI.card, 1);
  g.fillRoundedRect(x, y, w, h, r);
  // Crisp outer edge. (#505 playtest: a separate "lit top bevel" highlight used to be stroked
  // just inside this same top edge — with the two lines only ~1.5px apart it read as a stray
  // double border along the top of every tile, so it's gone; the crisp edge alone is the border,
  // same as every other side of the tile.)
  g.lineStyle(selected || firing ? 2 : 1.25, firing ? TILE_UI.firingEdge : selected ? TILE_UI.sel : TILE_UI.edgeLit, 1);
  g.strokeRoundedRect(x, y, w, h, r);
}

// A centred row of N square tiles within [x, x+w]. Position by `y` (top) OR `bottom`. `order`
// is the location/slot id list to draw from — defaults to the Garage's plain weapon-only
// TILE_ORDER.
export function tileRow(x, w, { y, bottom, order = TILE_ORDER, n = order.length, gap = 12, maxSize = 132 } = {}) {
  const size = Math.min(maxSize, Math.floor((w - gap * (n - 1)) / n));
  const totalW = size * n + gap * (n - 1);
  const x0 = Math.round(x + (w - totalW) / 2);
  const top = bottom != null ? bottom - size : y;
  return order.slice(0, n).map((loc, i) => ({ loc, x: x0 + i * (size + gap), y: top, w: size, h: size }));
}

// A tile counts as WIDE when it departs meaningfully from square — the #506 ability tiles
// (double-wide/half-height) vs. every weapon tile (always square). `drawSkillTile` uses this to
// pick icon-left/text-right content instead of the square tile's icon-centered/text-stacked
// layout, so a wide tile's drawn content actually spans the extra width instead of a
// normal-tile-sized icon floating centered with empty space on both sides (Jackson, playtest:
// "the buttons themselves should be double-width also").
const WIDE_ASPECT = 1.6;
export function isWideTile(rect) { return rect.w > rect.h * WIDE_ASPECT; }

// #526 (playtest: "the ammo bar is only noticeable when nearly out of ammo, make it visible
// sooner") originally fixed this with two snapped-band thresholds. Live-chat ask (this pass):
// go further and make it a continuous gradient, always visibly shifting rather than sitting flat
// until it crosses a cutoff — the SAME blue → purple → red HSL sweep the shield/structure
// readouts already use (`structureColor`, data/healthReadout.js) so the whole HUD reads one
// consistent "health-like gauge" color language instead of ammo having its own separate one.
export const AMMO_BAR_W = 7;      // the vertical column's width
export const AMMO_BAR_PAD = 6;    // top/bottom inset from the tile's own edges
export const ammoBarColor = structureColor;

// Pure geometry for a wide tile's content: a square icon, sized off the tile's own HEIGHT (the
// limiting dimension, so it actually fills the short tile instead of overflowing it), followed by
// a text column (bind glyph + subtitle) — but the icon+text PAIR is centered as one group within
// the tile, rather than the icon pinned to the left pad and the text column stretched all the way
// to the right pad. #506 follow-up (Jackson, after trying icon-left/text-right full width: "I like
// the new ability art and text, although let's center it within the button") — pinning the icon
// left and stretching the text column to the far pad left the visible content (a small icon plus
// whatever short text happens to be showing) clustered on the left half of the tile with empty
// space on the right, even though the abstract box was pad-symmetric. `colW` is capped to a
// fraction of the tile's own width instead of filling every remaining pixel, so the icon+column
// block has a real width to center — not the full tile. Exported so the "always inside the rect,
// column never negative" invariant is unit-testable without booting Phaser.
export function wideTileLayout(rect, { pad = 6, iconGap = 8, colWFrac = 0.46 } = {}) {
  const iconSize = Math.round(rect.h * 0.8);
  const maxColW = Math.max(0, rect.w - pad * 2 - iconSize - iconGap);
  const colW = Math.min(maxColW, Math.round(rect.w * colWFrac));
  const totalW = iconSize + iconGap + colW;
  const left = Math.round(rect.x + (rect.w - totalW) / 2);
  const iconCx = Math.round(left + iconSize / 2);
  const iconCy = Math.round(rect.y + rect.h / 2);
  const colX = left + iconSize + iconGap;
  return { iconSize, iconCx, iconCy, colX, colW };
}

// #526-followup (point 5): the X/Y ability tiles' own content layout — the mounted ability's own
// icon centred in the tile, the control-bind glyph ("X"/"Y") demoted to a small badge in the
// top-left corner, and the ready/charge-status text centred underneath. Distinct from
// `wideTileLayout`'s icon-left/text-right arrangement (which the core/passive tile — also wide, at
// 1× weapon-width — keeps unchanged) only in HOW the icon and text share the tile, not in whether
// there's an icon at all.
// #526-followup2 (playtest: "restore the per-ability icon" — an earlier pass dropped it entirely
// in favour of bind-glyph-over-status-text with no icon, which read as a blank/broken tile):
// brought the icon back as the tile's dominant content, with the bind glyph shrunk into a corner
// badge instead of removed, so the button still reads as a KEY (bind visible) but also as the
// actual ability mounted there (icon visible) rather than plain text.
// Pure geometry: icon size + centre, the corner bind position and the status line's y, always
// inside the rect regardless of size.
export function stackedTileLayout(rect) {
  const iconSize = Math.round(rect.h * 0.64);
  return {
    cx: rect.x + rect.w / 2,
    iconSize,
    iconCx: rect.x + rect.w / 2,
    iconCy: rect.y + rect.h * 0.42,
    bindX: rect.x + 5,
    bindY: rect.y + 2,
    subtitleY: rect.y + rect.h * 0.74,
  };
}

// #526-followup (redesign, replacing the FOURTH rework's two-tile double-wide/half-height shape):
// Jackson folded the passive/core slot INTO this same row, in the MIDDLE between X and Y, rather
// than leaving it as Garage-only chrome. That passive/core slot is gone now (shield is an
// unconditional baseline with no equip choice, and Anti-Missile Defense moved into the mountable-
// ability system alongside X/Y) — this is back to a plain TWO-way X/Y split of the row's own
// ARMORED width, each tile taking half, separated by the row's own standard `gap`.
//
// The row's OUTER edges matched the weapon row's own BARE span exactly at first — but #526-
// followup2 (point 5, playtest) moved that to the weapon row's ARMORED span instead (bare tiles
// widened by `ARMOR_PEEK_PAD` on each outer edge, the same footprint the armor backing behind each
// weapon tile actually paints), so the sizing lines up with what's actually visible below it
// rather than the tiles hiding under that backing. See `SHIELD_ARC.overhang` (healthReadout.js)
// for how the shield/console notch still gets an EQUAL margin against this row despite the two
// footprints differing (point 1).
export function weaponAbilityRows(x, w, {
  bottom, weaponOrder = TILE_ORDER, abilityOrder = HUD_ABILITY_ORDER,
  // #526-followup2 (point 4, playtest: "add a gap between the ability/passive row and the weapon
  // row below it — they read as flush/touching"): the raw 12px only measured against the BARE
  // weapon tile rects, but each weapon tile's armor backing (`ARMOR_PEEK_PAD`, HudScene.js's
  // `_paintFusedReadout`) now peeks out ABOVE the tile by that same amount — so the actual visible
  // gap between the ability row and the armor plate below it was only `12 - ARMOR_PEEK_PAD`px,
  // reading as touching. Baking `ARMOR_PEEK_PAD` into the default keeps the intended ~12px of
  // daylight between the two visible surfaces, not just the two bare rects.
  gap = CONSOLE_TILES.gap, rowGap = 12 + ARMOR_PEEK_PAD, maxSize = 132,
} = {}) {
  const weapons = tileRow(x, w, { bottom, order: weaponOrder, gap, maxSize });
  if (!weapons.length) return { weapons, abilities: [], top: bottom };
  // The row's own ARMORED bounds: the bare weapon row's span, widened by the armor backing peeking
  // out past the first/last tile on each side (mirrors `CONSOLE_TILES.gap`'s own widening logic).
  const last = weapons[weapons.length - 1];
  const rowX = weapons[0].x - ARMOR_PEEK_PAD;
  const rowW = (last.x + last.w - weapons[0].x) + ARMOR_PEEK_PAD * 2;
  const abilityH = Math.round(weapons[0].h / 2);
  const abilityTop = weapons[0].y - rowGap - abilityH;
  // X and Y split the row's armored width evenly in half, with the row's own standard `gap`
  // between them — still summing to the same `rowW` total (the weapon-row-matching invariant).
  const halfW = Math.round((rowW - gap) / 2);
  const leftW = halfW;
  const rightW = rowW - leftW - gap;
  const rightX = rowX + leftW + gap;
  const abilities = [
    { loc: abilityOrder[0], x: rowX, y: abilityTop, w: leftW, h: abilityH },
    { loc: abilityOrder[1], x: rightX, y: abilityTop, w: rightW, h: abilityH },
  ];
  // #544 (Jackson: "LB and X/L3 button contents swap, sizes stay the same" — same for RB/Y —
  // "and armor display moves to the new position"): a pure GEOMETRY swap between two paired
  // rects, applied as the very last step so every position computed above (rowX/rowW/abilityTop,
  // the weapon row itself) is derived from the UN-swapped layout first. Each pair trades its
  // `{x,y,w,h}` only — the `loc` label on each rect stays put, so every consumer (HudScene,
  // GarageScene/columnLayout) still looks up content by the SAME unchanged key
  // (`mech.mounts.leftTorso`, `mech.abilityMounts.abilityX`, TILE_ORDER, HUD_ABILITY_ORDER,
  // SKILL_BINDS, ABILITY_BINDS, GarageScene's `_navSlot` pad cursor — none of it touched) and
  // hands the looked-up content to `drawSkillTile`, which simply draws into whichever box this
  // function attached to that loc. The weapon content now lands in the ability row's own
  // half-height slot and the ability content lands in the weapon row's own square slot, each at
  // its SLOT's existing size — not a resize, not an input rebind. `isWideTile`'s aspect check
  // (run against the rect, not the loc) is what then makes the relocated weapon content
  // auto-render "wide" (icon-left/text-right, like the core tile already does) and the relocated
  // ability content auto-render "square" (icon-centered, like every other weapon tile) — no
  // separate style branch needed for either. The armor-backing plate (HudScene's
  // `_paintFusedReadout`) reads its box straight off `panel.skillRefs[loc].rect` for `loc` in
  // TILE_ORDER, so it follows the weapon content to its new position for free.
  for (const [weaponLoc, abilityLoc] of RENDER_SWAP_PAIRS) {
    const wTile = weapons.find((t) => t.loc === weaponLoc);
    const aTile = abilities.find((t) => t.loc === abilityLoc);
    if (!wTile || !aTile) continue;
    const g = { x: wTile.x, y: wTile.y, w: wTile.w, h: wTile.h };
    wTile.x = aTile.x; wTile.y = aTile.y; wTile.w = aTile.w; wTile.h = aTile.h;
    aTile.x = g.x; aTile.y = g.y; aTile.w = g.w; aTile.h = g.h;
  }
  return { weapons, abilities, top: abilityTop };
}

// Places every ABILITY_SLOTS entry around (cx, cy), using ABILITY_SLOT_LAYOUT's unit dx/dy
// offsets — the ability-slot counterpart to `tileRow`'s linear layout. Two slots today (Y left,
// X right, flanking the core tile), but the function itself doesn't assume a count or shape —
// it just places whatever ABILITY_SLOT_LAYOUT says. Same `{loc, x, y, w, h}` shape as `tileRow`'s
// rows. (Named `diamondLayout` from when there were four slots arranged as one; kept as-is
// rather than renamed for a cosmetic-only diff — see anatomy.js for the current two-slot shape.)
export function diamondLayout(cx, cy, { size = 46, radius } = {}) {
  radius = radius ?? size * 1.15;
  return ABILITY_SLOTS.map((loc) => {
    const { dx, dy } = ABILITY_SLOT_LAYOUT[loc];
    return { loc, x: Math.round(cx + dx * radius - size / 2), y: Math.round(cy + dy * radius - size / 2), w: size, h: size };
  });
}

// Build one tile's display objects into `parent` (a Container) and apply `opts`. Returns
// refs for in-place updates. `opts`: { itemId, mode, selected, subtitle, subtitleColor,
// iconAlpha, ammoFrac, emptyLabel }.
export function drawSkillTile(scene, parent, rect, opts) {
  const cx = rect.x + rect.w / 2;
  const wide = isWideTile(rect);
  // #452: the visible body of the tile is `plate` (a Graphics, so it can round its corners and
  // carry a halo). `bg` survives as an INVISIBLE rectangle covering the same box — it is the hit
  // area the garage attaches its click handler to (`refs.bg.setInteractive(...)`), which a
  // Graphics has no implicit shape for.
  const plate = scene.add.graphics();
  const bg = scene.add.rectangle(rect.x, rect.y, rect.w, rect.h, TILE_UI.card, 0)
    .setOrigin(0, 0);

  const stacked = wide && !!opts.bindOverStatus;
  let bind, icon, plus, subtitle;
  if (stacked) {
    // #526-followup2 (point 6, playtest: "restore the per-ability icon"): the ability tiles' own
    // layout — the mounted ability's real icon centred in the tile, the control-bind glyph
    // ("X"/"Y") shrunk to a small badge in the top-left corner, and the ready/charge-status text
    // centred underneath. `icon` is a real, visible piece of this tile's content again (see
    // `updateSkillTile`) — only `plus` (the empty-slot "+" swatch) still only shows when the slot
    // is actually empty, same as every other tile.
    const L = stackedTileLayout(rect);
    bind = scene.add.text(L.bindX, L.bindY, '', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.h * 0.24)}px`, color: TILE_UI.accent,
    }).setOrigin(0, 0);
    icon = scene.add.image(L.iconCx, L.iconCy, '__WHITE').setVisible(false);
    plus = scene.add.text(L.iconCx, L.iconCy, '+', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.h * 0.42)}px`, color: TILE_UI.slotEdge,
    }).setOrigin(0.5).setVisible(false);
    subtitle = scene.add.text(L.cx, L.subtitleY, '', {
      fontFamily: 'monospace', fontSize: '10px', color: TILE_UI.dim, align: 'center',
      wordWrap: { width: rect.w - 10, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
  } else if (wide) {
    // Icon-left / text-right, but the pair is centered as one group within the rect (see
    // `wideTileLayout`) — so a wide tile's content sits balanced in the wide rect instead
    // of pinned to the left pad with empty space trailing off to the right. Still used by the
    // core/passive tile, which keeps a real item icon (see the module doc above `stackedTileLayout`).
    const L = wideTileLayout(rect);
    bind = scene.add.text(L.colX, rect.y + Math.round(rect.h * 0.1), '', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.h * 0.34)}px`, color: TILE_UI.accent,
    }).setOrigin(0, 0);
    icon = scene.add.image(L.iconCx, L.iconCy, '__WHITE').setVisible(false);
    plus = scene.add.text(L.iconCx, L.iconCy, '+', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.h * 0.5)}px`, color: TILE_UI.slotEdge,
    }).setOrigin(0.5).setVisible(false);
    subtitle = scene.add.text(L.colX, rect.y + Math.round(rect.h * 0.56), '', {
      fontFamily: 'monospace', fontSize: '10px', color: TILE_UI.dim, align: 'left',
      wordWrap: { width: L.colW, useAdvancedWrap: true },
    }).setOrigin(0, 0);
  } else {
    bind = scene.add.text(cx, rect.y + 6, '', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.w * 0.13)}px`, color: TILE_UI.accent,
    }).setOrigin(0.5, 0);
    icon = scene.add.image(cx, rect.y + rect.h * 0.5, '__WHITE').setVisible(false);
    plus = scene.add.text(cx, rect.y + rect.h * 0.46, '+', {
      fontFamily: 'monospace', fontSize: `${Math.round(rect.w * 0.2)}px`, color: TILE_UI.slotEdge,
    }).setOrigin(0.5).setVisible(false);
    // #121 follow-up: at narrow window widths the tile row shrinks (see GarageScene's
    // dollW/tileRow), and a single long item name (e.g. "Autocannon", "Repeater" — one word,
    // nothing to break on) doesn't fit the default wordWrap's whitespace-only splitting, so it
    // overflows the tile and visually runs into the next one, reading as "smashed together."
    // useAdvancedWrap makes Phaser break mid-word when a word alone exceeds the wrap width, so
    // the label always stays inside its own tile.
    subtitle = scene.add.text(cx, rect.y + rect.h - 22, '', {
      fontFamily: 'monospace', fontSize: '10px', color: TILE_UI.dim, align: 'center',
      wordWrap: { width: rect.w - 6, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
  }
  // Live-chat ask: the ammo/cooldown gauge is a real vertical COLUMN inset along the tile's right
  // edge now, spanning nearly its full height, rather than a hairline at the bottom — origin
  // (0.5, 1) bottom-anchors it, so `setScale(1, frac)` in `updateSkillTile` grows/shrinks it
  // straight up out of the floor instead of sideways, reading as depleting OUT of the box.
  const barCx = rect.x + rect.w - 5 - AMMO_BAR_W / 2;
  const barBottom = rect.y + rect.h - AMMO_BAR_PAD;
  const barH = rect.h - AMMO_BAR_PAD * 2;
  const barTrack = scene.add.rectangle(barCx, barBottom, AMMO_BAR_W, barH, TILE_UI.track).setOrigin(0.5, 1).setVisible(false);
  const bar = scene.add.rectangle(barCx, barBottom, AMMO_BAR_W, barH, TILE_UI.good).setOrigin(0.5, 1).setVisible(false);
  parent.add([plate, bg, bind, icon, plus, subtitle, barTrack, bar]);
  const refs = { rect, wide, stacked, plate, bg, bind, icon, plus, subtitle, barTrack, bar };
  updateSkillTile(refs, opts);
  return refs;
}

// Apply dynamic state to a tile built by drawSkillTile.
// #506: `bindGlyph` (the control-bind label text) and `emptyLabel` (the empty-slot subtitle) are
// now caller-supplied rather than derived from `SKILL_BINDS[loc]`/hardcoded 'weapon' — the SAME
// tile-paint code now serves weapon tiles, ability tiles, and the core tile, each with their own
// bind source (SKILL_BINDS vs. ABILITY_BINDS vs. none) and empty-state copy. Omitting them
// reproduces the old weapon-tile defaults exactly, so no existing behavior changes.
export function updateSkillTile(refs, opts) {
  const { rect, plate, bind, icon, plus, subtitle, barTrack, bar, wide, stacked = false } = refs;
  const { loc, itemId, mode = 'kbm', selected = false, firing = false, subtitle: sub = '', subtitleColor = TILE_UI.dim,
    iconAlpha = 1, ammoFrac = null, onCooldown = false, cooldownFrac = 0,
    // Falls back to the old SKILL_BINDS[loc] derivation ONLY when `loc` is actually a weapon
    // location — an ability/core `loc` (not in SKILL_BINDS) degrades to an empty glyph instead
    // of throwing, so a caller that forgets to pass `bindGlyph` explicitly fails safe, not loud.
    bindGlyph = SKILL_BINDS[loc] ? (mode === 'pad' ? SKILL_BINDS[loc].pad : SKILL_BINDS[loc].key) : '',
    emptyLabel = 'weapon' } = opts;

  // #544: `nipCorners` (#526) is gone — see `paintTilePlate`'s own comment.
  paintTilePlate(plate, rect, { selected, firing });
  bind.setText(bindGlyph).setColor(selected ? '#efc14a' : TILE_UI.accent);

  // #506 THIRD rework: a wide tile sizes its icon off the tile's own HEIGHT (via
  // `wideTileLayout`, the limiting dimension for a double-wide/half-height tile) instead of its
  // width — sizing off `rect.w` here is what made the old icon overflow the tile vertically
  // while only covering half the width horizontally. #526-followup2 (point 6): the stacked
  // (bind-over-status) ability tiles size their icon off `stackedTileLayout` instead — its own
  // icon+corner-badge geometry, not `wideTileLayout`'s icon-left/text-right one.
  const iconSize = stacked ? stackedTileLayout(rect).iconSize : wide ? wideTileLayout(rect).iconSize : rect.w * 0.46;
  if (itemId) {
    // #526-followup2 (point 6): the stacked ability tiles show their mounted ability's real icon
    // again — same texture convention (`itemFxKey`) every weapon and core tile already uses.
    icon.setTexture(itemFxKey(itemId)).setDisplaySize(iconSize, iconSize).setAlpha(iconAlpha).setVisible(true);
    plus.setVisible(false);
    subtitle.setText(sub).setColor(subtitleColor);
    if (onCooldown) {
      // #238: the bar fills back up bottom-to-top as the lockout counts down (1 - remaining
      // fraction), in the distinct cooldown blue — reads as "recharging," clearly different
      // from the red "dry and just sitting there" look an out-of-cooldown empty magazine
      // would otherwise share.
      barTrack.setVisible(true);
      bar.setVisible(true).setScale(1, Math.max(0, Math.min(1, 1 - cooldownFrac)))
        .setFillStyle(TILE_UI.cooldownHex);
    } else if (ammoFrac != null) {
      barTrack.setVisible(true);
      bar.setVisible(true).setScale(1, Math.max(0, Math.min(1, ammoFrac)))
        .setFillStyle(ammoBarColor(ammoFrac));
    } else {
      barTrack.setVisible(false); bar.setVisible(false);
    }
  } else {
    icon.setVisible(false);
    barTrack.setVisible(false); bar.setVisible(false);
    // #526-followup2 (point 6): now that a mounted stacked tile shows a real icon, an EMPTY one
    // shows the same "+" swatch every other empty tile does (in its own icon slot) rather than
    // the old stacked-only "no + either" carve-out.
    plus.setVisible(true);
    subtitle.setText(emptyLabel).setColor(TILE_UI.dim);
  }
}
