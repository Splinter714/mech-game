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

// Body order, left → right: left arm · left torso · right torso · right arm. #188: the old
// centre-torso ability slot is gone (#261: L3/Space is a hardcoded Dash, not mounted), so
// this is now four weapon slots only. Still what the Garage's paper-doll tile row uses.
export const TILE_ORDER = ['leftArm', 'leftTorso', 'rightTorso', 'rightArm'];

// #506 SECOND rework (playtest): the first rework's one-row-of-6 didn't stick. Jackson: "move x/y
// abilities in weapon HUD to double-wide half-height buttons (as compared to the weapon buttons)
// that sit in a single row above the 4 weapon buttons; so the X ability sits above the left sided
// weapons and the Y ability above the right sided weapons." X is therefore first (left) here, Y
// second (right) — see `weaponAbilityRows` below, which is what actually places them. The passive
// core slot is still deliberately NOT in this list — see HudScene.js's `_makePanel`.
export const HUD_ABILITY_ORDER = ['abilityX', 'abilityY'];

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
  // #526: the double-wide ABILITY tiles get a bigger round on their own OUTER-top corner (the one
  // nearest the console's own nipped-corner notch, `SHIELD_ARC.corner` in healthReadout.js) so
  // they visibly taper INTO that notch shape instead of sitting inside it as plain rectangles that
  // need extra clearance. Only the outer corner nips; the inner one and both bottom corners keep
  // the normal `radius`. Tunable — picked close to, but not matching exactly, the console notch's
  // own 14px so the tile still reads as its own button.
  nipRadius: 16,
  edgeLit: 0x46566b,  // the crisp outer edge — brighter than the old flat `edge`
  halo: 0x5ec8e0,     // the faint outside-the-edge pop (the shared UI accent)
};

// Paint one tile's PLATE — the rounded body, its edge and the halo just outside it. A Graphics
// rather than a Rectangle purely because Phaser's Rectangle cannot round its corners; the tile's
// hit area is still the plain rect (see `drawSkillTile`).
//
// #526: `nipCorners` (optional, e.g. `{ tl: true }` or `{ tr: true }`) nips ONE outer-top corner
// to `TILE_UI.nipRadius` instead of the normal `radius` — used by the double-wide ability tiles so
// they taper into the console's own nipped-corner notch (see `TILE_UI.nipRadius`'s own comment).
// Every other tile (every weapon tile, and an ability tile with no flag set) is unaffected — the
// per-corner object collapses right back to the old single-radius rounding when every flag is
// false/absent.
export function paintTilePlate(g, rect, { selected = false, nipCorners = null } = {}) {
  const { x, y, w, h } = rect;
  const r = Math.min(TILE_UI.radius, w / 4);
  const corners = nipCorners
    ? {
      tl: nipCorners.tl ? TILE_UI.nipRadius : r, tr: nipCorners.tr ? TILE_UI.nipRadius : r,
      bl: r, br: r,
    }
    : r;
  const grow = (pad) => (typeof corners === 'number'
    ? corners + pad
    : { tl: corners.tl + pad, tr: corners.tr + pad, bl: corners.bl + pad, br: corners.br + pad });
  g.clear();
  // Outside-the-edge halo: two fading passes, since plain Graphics has no blur (the same stacked-
  // silhouette stand-in the HUD's chevron glow and shield bar use).
  const haloCol = selected ? TILE_UI.sel : TILE_UI.halo;
  for (const [pad, a] of [[3.5, selected ? 0.20 : 0.07], [1.5, selected ? 0.40 : 0.16]]) {
    g.lineStyle(2, haloCol, a);
    g.strokeRoundedRect(x - pad, y - pad, w + pad * 2, h + pad * 2, grow(pad));
  }
  // The plate itself.
  g.fillStyle(selected ? TILE_UI.cardSel : TILE_UI.card, 1);
  g.fillRoundedRect(x, y, w, h, corners);
  // Crisp outer edge. (#505 playtest: a separate "lit top bevel" highlight used to be stroked
  // just inside this same top edge — with the two lines only ~1.5px apart it read as a stray
  // double border along the top of every tile, so it's gone; the crisp edge alone is the border,
  // same as every other side of the tile.)
  g.lineStyle(selected ? 2 : 1.25, selected ? TILE_UI.sel : TILE_UI.edgeLit, 1);
  g.strokeRoundedRect(x, y, w, h, corners);
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
// sooner"): the bar's WIDTH already tracks `ammoFrac` exactly (full mag = full-width bar) — what
// made it easy to miss was that it stayed the same flat GOOD colour across the entire 33%-100%
// range, on a thin (3px) track, so a magazine burning down from full read as "no change" until it
// suddenly snapped to warn/bad near the end. Two fixes: the track is thicker now (`AMMO_BAR_H`,
// see `drawSkillTile`), and the WARN colour now kicks in at `AMMO_WARN_FRAC` (60%) instead of the
// old 33% — noticeably earlier, while `AMMO_LOW_FRAC` (25%) still gates the final BAD/red state.
// Pulled out as a pure function so the thresholds are unit-testable without booting Phaser.
export const AMMO_BAR_H = 5;
export const AMMO_WARN_FRAC = 0.6;
export const AMMO_LOW_FRAC = 0.25;
export function ammoBarColor(frac) {
  if (frac <= 0 || frac <= AMMO_LOW_FRAC) return TILE_UI.bad;
  if (frac <= AMMO_WARN_FRAC) return 0xefc14a;
  return TILE_UI.good;
}

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

// #506 FOURTH rework (reverting the THIRD's below-weapons experiment, Jackson: "I want 506 to
// move the X/Y abilities back to being above the weapons, but I'm glad I tried it"): the ability
// row is back to owning the space directly ABOVE the weapon row, which itself anchors to the
// shared `bottom` — the SECOND rework's arrangement, restored. `tileRow` still supplies each
// weapon slot's SIZE/X, so the horizontal math — width, gaps, centring — is exactly what it
// always was; only which row sits where changed (again).
export function weaponAbilityRows(x, w, {
  bottom, weaponOrder = TILE_ORDER, abilityOrder = HUD_ABILITY_ORDER,
  gap = 12, rowGap = 12, maxSize = 132,
} = {}) {
  const weapons = tileRow(x, w, { bottom, order: weaponOrder, gap, maxSize });
  if (!weapons.length) return { weapons, abilities: [], top: bottom };
  const half = Math.floor(weapons.length / 2);
  const leftPair = weapons.slice(0, half);
  const rightPair = weapons.slice(half);
  const abilityH = Math.round(weapons[0].h / 2);
  const abilityTop = weapons[0].y - rowGap - abilityH;
  const spanOf = (pair) => {
    const last = pair[pair.length - 1];
    return { x: pair[0].x, w: last.x + last.w - pair[0].x };
  };
  const leftSpan = spanOf(leftPair);
  const rightSpan = spanOf(rightPair);
  const abilities = [
    { loc: abilityOrder[0], x: leftSpan.x, y: abilityTop, w: leftSpan.w, h: abilityH },
    { loc: abilityOrder[1], x: rightSpan.x, y: abilityTop, w: rightSpan.w, h: abilityH },
  ];
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

// #496: the single core-slot tile, nested in the diamond's own hollow centre — smaller than the
// ring tiles so it doesn't crowd them. Callers own the size/radius/coreSize choices that keep it
// clear of `diamondLayout`'s ring (coreSize/2 + size/2 < radius).
export function coreTileRect(cx, cy, size = 30) {
  return { loc: 'core', x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), w: size, h: size };
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

  let bind, icon, plus, subtitle;
  if (wide) {
    // Icon-left / text-right, but the pair is centered as one group within the rect (see
    // `wideTileLayout`) — so a wide tile's content sits balanced in the double-wide rect instead
    // of pinned to the left pad with empty space trailing off to the right.
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
  // #526 (playtest: "the ammo bar is only noticeable when nearly out of ammo") — thickened from
  // 3px to `AMMO_BAR_H` so it reads as a real gauge at a glance instead of a hairline that only
  // catches the eye once it's short and red.
  const barTrack = scene.add.rectangle(rect.x + 5, rect.y + rect.h - AMMO_BAR_H, rect.w - 10, AMMO_BAR_H, TILE_UI.track).setOrigin(0, 0.5).setVisible(false);
  const bar = scene.add.rectangle(rect.x + 5, rect.y + rect.h - AMMO_BAR_H, rect.w - 10, AMMO_BAR_H, TILE_UI.good).setOrigin(0, 0.5).setVisible(false);
  parent.add([plate, bg, bind, icon, plus, subtitle, barTrack, bar]);
  const refs = { rect, wide, plate, bg, bind, icon, plus, subtitle, barTrack, bar };
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
  const { rect, plate, bind, icon, plus, subtitle, barTrack, bar, wide } = refs;
  const { loc, itemId, mode = 'kbm', selected = false, subtitle: sub = '', subtitleColor = TILE_UI.dim,
    iconAlpha = 1, ammoFrac = null, onCooldown = false, cooldownFrac = 0, nipCorners = null,
    // Falls back to the old SKILL_BINDS[loc] derivation ONLY when `loc` is actually a weapon
    // location — an ability/core `loc` (not in SKILL_BINDS) degrades to an empty glyph instead
    // of throwing, so a caller that forgets to pass `bindGlyph` explicitly fails safe, not loud.
    bindGlyph = SKILL_BINDS[loc] ? (mode === 'pad' ? SKILL_BINDS[loc].pad : SKILL_BINDS[loc].key) : '',
    emptyLabel = 'weapon' } = opts;

  paintTilePlate(plate, rect, { selected, nipCorners });
  bind.setText(bindGlyph).setColor(selected ? '#efc14a' : TILE_UI.accent);

  // #506 THIRD rework: a wide tile sizes its icon off the tile's own HEIGHT (via
  // `wideTileLayout`, the limiting dimension for a double-wide/half-height tile) instead of its
  // width — sizing off `rect.w` here is what made the old icon overflow the tile vertically
  // while only covering half the width horizontally.
  const iconSize = wide ? wideTileLayout(rect).iconSize : rect.w * 0.46;
  if (itemId) {
    icon.setTexture(itemFxKey(itemId)).setDisplaySize(iconSize, iconSize).setAlpha(iconAlpha).setVisible(true);
    plus.setVisible(false);
    subtitle.setText(sub).setColor(subtitleColor);
    if (onCooldown) {
      // #238: the bar fills back up left-to-right as the lockout counts down (1 - remaining
      // fraction), in the distinct cooldown blue — reads as "recharging," clearly different
      // from the red "dry and just sitting there" look an out-of-cooldown empty magazine
      // would otherwise share.
      barTrack.setVisible(true);
      bar.setVisible(true).setScale(Math.max(0, Math.min(1, 1 - cooldownFrac)), 1)
        .setFillStyle(TILE_UI.cooldownHex);
    } else if (ammoFrac != null) {
      barTrack.setVisible(true);
      bar.setVisible(true).setScale(Math.max(0, Math.min(1, ammoFrac)), 1)
        .setFillStyle(ammoBarColor(ammoFrac));
    } else {
      barTrack.setVisible(false); bar.setVisible(false);
    }
  } else {
    icon.setVisible(false);
    barTrack.setVisible(false); bar.setVisible(false);
    plus.setVisible(true);
    subtitle.setText(emptyLabel).setColor(TILE_UI.dim);
  }
}
