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

// Body order, left → right: left arm · left torso · right torso · right arm. #188: the old
// centre-torso ability slot is gone (Sprint is a hardcoded L3/Space toggle, not mounted), so
// this is now four weapon slots only.
export const TILE_ORDER = ['leftArm', 'leftTorso', 'rightTorso', 'rightArm'];

export const TILE_UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a',
  card: 0x131820, cardSel: 0x1b2430, edge: 0x2a333f, sel: 0xefc14a, slotEdge: 0x323c49, track: 0x0e1218,
  // #238: a distinct cool color for the "empty + locked out" cooldown state — separates it
  // visually from the plain warm/red "empty but actively regenerating" look so the player
  // isn't left wondering why the bar isn't creeping back up.
  cooldown: '#5e7ce0', cooldownHex: 0x5e7ce0,
};

// A centred row of N square tiles within [x, x+w]. Position by `y` (top) OR `bottom`.
export function tileRow(x, w, { y, bottom, n = TILE_ORDER.length, gap = 12, maxSize = 132 } = {}) {
  const size = Math.min(maxSize, Math.floor((w - gap * (n - 1)) / n));
  const totalW = size * n + gap * (n - 1);
  const x0 = Math.round(x + (w - totalW) / 2);
  const top = bottom != null ? bottom - size : y;
  return TILE_ORDER.slice(0, n).map((loc, i) => ({ loc, x: x0 + i * (size + gap), y: top, w: size, h: size }));
}

// Build one tile's display objects into `parent` (a Container) and apply `opts`. Returns
// refs for in-place updates. `opts`: { itemId, mode, selected, subtitle, subtitleColor,
// iconAlpha, ammoFrac, emptyLabel }.
export function drawSkillTile(scene, parent, rect, opts) {
  const cx = rect.x + rect.w / 2;
  const bg = scene.add.rectangle(rect.x, rect.y, rect.w, rect.h, TILE_UI.card)
    .setOrigin(0, 0).setStrokeStyle(1, TILE_UI.edge);
  const bind = scene.add.text(cx, rect.y + 6, '', {
    fontFamily: 'monospace', fontSize: `${Math.round(rect.w * 0.13)}px`, color: TILE_UI.accent,
  }).setOrigin(0.5, 0);
  const icon = scene.add.image(cx, rect.y + rect.h * 0.5, '__WHITE').setVisible(false);
  const plus = scene.add.text(cx, rect.y + rect.h * 0.46, '+', {
    fontFamily: 'monospace', fontSize: `${Math.round(rect.w * 0.2)}px`, color: TILE_UI.slotEdge,
  }).setOrigin(0.5).setVisible(false);
  // #121 follow-up: at narrow window widths the tile row shrinks (see GarageScene's
  // dollW/tileRow), and a single long item name (e.g. "Autocannon", "Repeater" — one word,
  // nothing to break on) doesn't fit the default wordWrap's whitespace-only splitting, so it
  // overflows the tile and visually runs into the next one, reading as "smashed together."
  // useAdvancedWrap makes Phaser break mid-word when a word alone exceeds the wrap width, so
  // the label always stays inside its own tile.
  const subtitle = scene.add.text(cx, rect.y + rect.h - 22, '', {
    fontFamily: 'monospace', fontSize: '10px', color: TILE_UI.dim, align: 'center',
    wordWrap: { width: rect.w - 6, useAdvancedWrap: true },
  }).setOrigin(0.5, 0);
  const barTrack = scene.add.rectangle(rect.x + 5, rect.y + rect.h - 5, rect.w - 10, 3, TILE_UI.track).setOrigin(0, 0.5).setVisible(false);
  const bar = scene.add.rectangle(rect.x + 5, rect.y + rect.h - 5, rect.w - 10, 3, TILE_UI.good).setOrigin(0, 0.5).setVisible(false);
  parent.add([bg, bind, icon, plus, subtitle, barTrack, bar]);
  const refs = { rect, bg, bind, icon, plus, subtitle, barTrack, bar };
  updateSkillTile(refs, opts);
  return refs;
}

// Apply dynamic state to a tile built by drawSkillTile.
export function updateSkillTile(refs, opts) {
  const { rect, bg, bind, icon, plus, subtitle, barTrack, bar } = refs;
  const { loc, itemId, mode = 'kbm', selected = false, subtitle: sub = '', subtitleColor = TILE_UI.dim,
    iconAlpha = 1, ammoFrac = null, onCooldown = false, cooldownFrac = 0 } = opts;

  bg.setFillStyle(selected ? TILE_UI.cardSel : TILE_UI.card).setStrokeStyle(selected ? 2 : 1, selected ? TILE_UI.sel : TILE_UI.edge);
  bind.setText(mode === 'pad' ? SKILL_BINDS[loc].pad : SKILL_BINDS[loc].key).setColor(selected ? '#efc14a' : TILE_UI.accent);

  if (itemId) {
    icon.setTexture(itemFxKey(itemId)).setDisplaySize(rect.w * 0.46, rect.w * 0.46).setAlpha(iconAlpha).setVisible(true);
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
        .setFillStyle(ammoFrac > 0.33 ? TILE_UI.good : ammoFrac > 0 ? 0xefc14a : TILE_UI.bad);
    } else {
      barTrack.setVisible(false); bar.setVisible(false);
    }
  } else {
    icon.setVisible(false);
    barTrack.setVisible(false); bar.setVisible(false);
    plus.setVisible(true);
    subtitle.setText('weapon').setColor(TILE_UI.dim);
  }
}
