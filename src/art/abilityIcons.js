// Per-ability tile art (#506 THIRD rework, Jackson: "we need art for these abilities similar to
// weapon button art"). Mirrors `projectileArt.js`'s `drawWeaponIcon` — one small procedural
// glyph per mountable ability, baked into the SAME `wfx_<id>` texture key weapon icons use
// (`itemFxKey`, projectileArt.js), so `ui/skillTiles.js`'s tile-icon code never has to know
// weapon vs. ability at all: it just asks for `itemFxKey(itemId)`.
//
// Replaces the flat colored-swatch placeholder (`drawSwatchIcon`, projectileArt.js) the #506
// SECOND rework shipped as a stand-in for abilities.
//
// Same calling convention as `drawWeaponIcon(g, weapon, S, c)`: `g` is a raw Phaser Graphics,
// `S` is the super-sample scale (`ART_SCALE`), `c` is the icon's center in BOTH x and y (the
// icon canvas is square). Every glyph is drawn within roughly the same ~22-unit-wide design box
// `drawWeaponIcon`'s shapes use (half of the 30-unit `ICON` canvas), heading the same
// "up-and-right" `-45°` direction the weapon icons favor, so the whole tile row reads as one
// consistent family at a glance.

// Dash: a cluster of forward speed-lines culminating in a bright arrowhead — reads as "a burst
// of forward motion," the same up-and-right heading the weapon icons use for their own travel
// direction.
function dashIcon(g, S, c, color) {
  const ang = -Math.PI / 4;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const px = -uy, py = ux;
  for (let i = 0; i < 3; i++) {
    const back = (-9 + i * 2) * S, front = (2 + i * 3.4) * S;
    const off = (i - 1) * 4.2 * S;
    g.lineStyle((2.4 - i * 0.4) * S, color, 0.32 + i * 0.28);
    g.lineBetween(c + ux * back + px * off, c + uy * back + py * off,
                  c + ux * front + px * off, c + uy * front + py * off);
  }
  const tipX = c + ux * 10.5 * S, tipY = c + uy * 10.5 * S;
  const bx = c + ux * 4 * S, by = c + uy * 4 * S;
  g.fillStyle(0xffffff, 0.92);
  g.fillTriangle(tipX, tipY, bx + px * 3.2 * S, by + py * 3.2 * S, bx - px * 3.2 * S, by - py * 3.2 * S);
}

// Shield Burst: a hexagonal shield silhouette with radiating burst ticks around it — the "AoE
// pulse off a defensive shape" the ability itself is (an activation blast, not sustained cover).
function shieldBurstIcon(g, S, c, color) {
  const pts = [
    { x: c, y: c - 10 * S }, { x: c + 8 * S, y: c - 4 * S }, { x: c + 7 * S, y: c + 6 * S },
    { x: c, y: c + 11 * S }, { x: c - 7 * S, y: c + 6 * S }, { x: c - 8 * S, y: c - 4 * S },
  ];
  g.fillStyle(color, 0.28);
  g.fillPoints(pts, true);
  g.lineStyle(1.6 * S, color, 0.9);
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.strokePath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const x0 = c + Math.cos(a) * 9 * S, y0 = c + Math.sin(a) * 9 * S;
    const x1 = c + Math.cos(a) * 12.5 * S, y1 = c + Math.sin(a) * 12.5 * S;
    g.lineStyle(1.4 * S, 0xffffff, 0.55);
    g.lineBetween(x0, y0, x1, y1);
  }
  g.fillStyle(0xffffff, 0.7);
  g.fillCircle(c, c, 2 * S);
}

// Jump Blast: an upward arrow (the leap) sitting over a pair of shockwave rings (the landing
// blast) — the ability's own two-part shape (burst of movement, then an AoE hit on arrival).
function jumpBlastIcon(g, S, c, color) {
  g.fillStyle(color, 0.95);
  g.fillTriangle(c, c - 11.5 * S, c - 6 * S, c - 1.5 * S, c + 6 * S, c - 1.5 * S);
  g.fillRect(c - 2.2 * S, c - 1.5 * S, 4.4 * S, 5.5 * S);
  g.lineStyle(1.6 * S, color, 0.55);
  g.strokeCircle(c, c + 8.5 * S, 7 * S);
  g.lineStyle(1.2 * S, 0xffffff, 0.4);
  g.strokeCircle(c, c + 8.5 * S, 4 * S);
}

// Drone Launcher: a top-down quadcopter — hub + crossed arms + four rotor rings — read instantly
// as "a small flying thing," distinct from every other ability's more abstract-effect glyph.
function droneLauncherIcon(g, S, c, color) {
  const diag = 8 * S * 0.7071;
  g.lineStyle(1.6 * S, color, 0.85);
  g.lineBetween(c - diag, c - diag, c + diag, c + diag);
  g.lineBetween(c - diag, c + diag, c + diag, c - diag);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    g.fillStyle(0xffffff, 0.55);
    g.fillCircle(c + dx * diag, c + dy * diag, 2.4 * S);
    g.lineStyle(1 * S, color, 0.8);
    g.strokeCircle(c + dx * diag, c + dy * diag, 2.4 * S);
  }
  g.fillStyle(color, 0.9);
  g.fillCircle(c, c, 3.2 * S);
}

// Cloak: a figure fading to nothing — three concentric rings falling to near-zero alpha outward
// — cut by a bright diagonal dashed slash, the universal "off the grid / hidden" glyph.
function cloakIcon(g, S, c, color) {
  g.fillStyle(color, 0.55);
  g.fillCircle(c, c, 4 * S);
  g.lineStyle(1.4 * S, color, 0.4);
  g.strokeCircle(c, c, 7.5 * S);
  g.lineStyle(1.1 * S, color, 0.2);
  g.strokeCircle(c, c, 10.5 * S);
  const ang = -Math.PI / 4, ux = Math.cos(ang), uy = Math.sin(ang);
  for (let i = 0; i < 4; i++) {
    const t0 = (-10 + i * 5.4) * S, t1 = t0 + 3.2 * S;
    g.lineStyle(2 * S, 0xffffff, 0.85);
    g.lineBetween(c + ux * t0, c + uy * t0, c + ux * t1, c + uy * t1);
  }
}

// Smoke Screen: a soft cluster of overlapping cloud puffs — round and hazy where every other
// icon here is sharp-edged, matching what the effect actually looks like in the arena.
function smokeScreenIcon(g, S, c, color) {
  const puffs = [[-6, 2, 5], [0, -2, 6.5], [6, 2, 5], [-2, 5.5, 4.5], [3.5, 5.5, 4.5]];
  for (const [dx, dy, r] of puffs) {
    g.fillStyle(0xffffff, 0.12);
    g.fillCircle(c + dx * S, c + dy * S, r * S);
  }
  for (const [dx, dy, r] of puffs) {
    g.lineStyle(1.2 * S, color, 0.5);
    g.strokeCircle(c + dx * S, c + dy * S, r * S);
  }
}

// Anti-Missile Defense: a point-defense "radar" glyph — two concentric detection rings around a
// small emitter dot, with short inward ticks representing incoming fire being intercepted at the
// perimeter — reads as "a standing defense system," distinct from every other ability glyph's own
// travel-direction language. Carried over from the item's old passive/core-slot life (#494) when
// it moved into the mountable-ability system as an active burst-window intercept.
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

// EMP Trap (#621): a broken ring of trap "ticks" (the scatter of traps planted around the player)
// with a jagged lightning bolt through the middle (the disable/stun payload) — reads as "a ring of
// electric traps," distinct from Anti-Missile's unbroken defensive ring and Shield Burst's solid
// hexagon.
function empTrapIcon(g, S, c, color) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = c + Math.cos(a) * 10 * S, y = c + Math.sin(a) * 10 * S;
    g.lineStyle(1.6 * S, color, 0.7);
    g.strokeCircle(x, y, 2 * S);
  }
  g.fillStyle(0xffffff, 0.95);
  g.fillTriangle(c - 1 * S, c - 9 * S, c + 3.5 * S, c - 1 * S, c - 0.5 * S, c - 1 * S);
  g.fillTriangle(c - 0.5 * S, c - 1 * S, c + 1 * S, c + 9 * S, c - 3.5 * S, c + 1 * S);
}

const ABILITY_ICONS = {
  dash: dashIcon,
  shieldBurst: shieldBurstIcon,
  jumpBlast: jumpBlastIcon,
  droneLauncher: droneLauncherIcon,
  cloak: cloakIcon,
  smokeScreen: smokeScreenIcon,
  antiMissile: antiMissileIcon,
  empTrap: empTrapIcon,
};

// Defensive fallback for any future ability added to `ABILITIES` before it gets its own glyph
// here — a plain rounded swatch (the same shape the #506 second rework's placeholder used for
// every ability), so a forgotten entry degrades to "a colored button," never a blank/missing
// texture.
function fallbackIcon(g, S, c, color) {
  const size = 18 * S, r = 4 * S;
  g.fillStyle(color, 0.85);
  g.fillRoundedRect(c - size / 2, c - size / 2, size, size, r);
  g.lineStyle(1.5 * S, 0xffffff, 0.25);
  g.strokeRoundedRect(c - size / 2, c - size / 2, size, size, r);
}

export function drawAbilityIcon(g, id, S, c, color) {
  const fn = ABILITY_ICONS[id];
  (fn ?? fallbackIcon)(g, S, c, color);
}

// Every entry in `ABILITIES` (data/abilities.js) that has its own bespoke glyph above — a guard
// test pins this against `Object.keys(ABILITIES)` so a new ability added there without art here
// is caught rather than silently falling back.
export const ABILITY_ICON_IDS = Object.keys(ABILITY_ICONS);
