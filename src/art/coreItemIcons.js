// Per-core-item tile art (#526-followup: "we need real per-item icons for the passive/core slot
// items, similar to the bespoke procedural icons already built for the mountable abilities").
// Mirrors `abilityIcons.js`'s own contract exactly: `drawCoreItemIcon(g, id, S, c, color)`, baked
// into the SAME `wfx_<id>` texture key every other mountable item uses (`itemFxKey`,
// projectileArt.js) — `ui/skillTiles.js`'s tile-icon code never has to know weapon vs. ability vs.
// core, it just asks for `itemFxKey(itemId)`.
//
// Replaces `drawSwatchIcon` (projectileArt.js) as the CORE_ITEMS build path — that flat swatch was
// a stand-in from when the passive slot had no HUD presence at all; now that it rides in the same
// ability row as X/Y (#526-followup's row redesign), it wants the same bespoke-glyph treatment.
//
// Same design box as `abilityIcons.js`'s glyphs — roughly the same ~22-unit-wide area within the
// 30-unit `ICON` canvas — so the whole row (weapons, abilities, core) reads as one family.

// Shield: a solid worn-plating silhouette — deliberately NOT the ability row's `shieldBurstIcon`
// (which has radiating burst ticks, reading as an activation blast). This is the PASSIVE item —
// continuous cover, not a burst — so it's just the shield shape itself, filled solid with a soft
// highlight arc suggesting a curved, lit plate.
function shieldIcon(g, S, c, color) {
  const pts = [
    { x: c, y: c - 11 * S }, { x: c + 8.5 * S, y: c - 5 * S }, { x: c + 7.5 * S, y: c + 6.5 * S },
    { x: c, y: c + 11.5 * S }, { x: c - 7.5 * S, y: c + 6.5 * S }, { x: c - 8.5 * S, y: c - 5 * S },
  ];
  g.fillStyle(color, 0.85);
  g.fillPoints(pts, true);
  g.lineStyle(1.6 * S, 0xffffff, 0.3);
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.strokePath();
  // A soft highlight arc, upper-left — reads as "worn curved plating" rather than a burst.
  g.lineStyle(1.2 * S, 0xffffff, 0.5);
  g.beginPath();
  g.arc(c, c, 5.5 * S, Math.PI * 1.05, Math.PI * 1.7);
  g.strokePath();
}

// Anti-Missile Defense: a point-defense "radar" glyph — two concentric detection rings around a
// small emitter dot, with short inward ticks representing incoming fire being intercepted at the
// perimeter — reads as "a standing defense system," distinct from every weapon/ability glyph's
// own travel-direction language.
function antiMissileIcon(g, S, c, color) {
  g.lineStyle(1.4 * S, color, 0.85);
  g.strokeCircle(c, c, 9 * S);
  g.lineStyle(1 * S, color, 0.4);
  g.strokeCircle(c, c, 5.5 * S);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const x0 = c + Math.cos(a) * 13 * S, y0 = c + Math.sin(a) * 13 * S;
    const x1 = c + Math.cos(a) * 9.5 * S, y1 = c + Math.sin(a) * 9.5 * S;
    g.lineStyle(1.6 * S, 0xffffff, 0.65);
    g.lineBetween(x0, y0, x1, y1);
  }
  g.fillStyle(0xffffff, 0.9);
  g.fillCircle(c, c, 2 * S);
}

const CORE_ITEM_ICONS = {
  shield: shieldIcon,
  antiMissile: antiMissileIcon,
};

// Defensive fallback for any future core item added to `CORE_ITEMS` before it gets its own glyph
// here — same shape `abilityIcons.js`'s own fallback uses, so a forgotten entry degrades to "a
// colored button," never a blank/missing texture.
function fallbackIcon(g, S, c, color) {
  const size = 18 * S, r = 4 * S;
  g.fillStyle(color, 0.85);
  g.fillRoundedRect(c - size / 2, c - size / 2, size, size, r);
  g.lineStyle(1.5 * S, 0xffffff, 0.25);
  g.strokeRoundedRect(c - size / 2, c - size / 2, size, size, r);
}

export function drawCoreItemIcon(g, id, S, c, color) {
  (CORE_ITEM_ICONS[id] ?? fallbackIcon)(g, S, c, color);
}

// Every entry in `CORE_ITEMS` (data/coreItems.js) that has its own bespoke glyph above — mirrors
// `abilityIcons.js`'s own `ABILITY_ICON_IDS` guard-test pattern.
export const CORE_ITEM_ICON_IDS = Object.keys(CORE_ITEM_ICONS);
