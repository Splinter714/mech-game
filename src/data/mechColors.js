import { PLAYER_COLORS } from './players.js';

// The GARAGE COLOUR PICKER (#487) — pure data: the curated swatch palette, the "what colour does
// this build show" resolver, and the co-op distinct-pick rules. The GarageScene draws the swatch
// row over these; the arena bakes each player's mech from them.
//
// Until #487 a player's colour was ASSIGNED, not chosen: `PLAYER_COLORS[playerIndex]` (data/
// players.js) — four clash-proof auto-colours from #404. That stays as the DEFAULT; this module
// lets a player override it from a larger curated set, saved per build slot (Mech.color, which
// round-trips through the roster save exactly like mounts/chassis).
//
// ── THE PALETTE (#487) ──────────────────────────────────────────────────────────────────────
// Same bar as #404's four auto-colours, applied to a bigger set: every swatch must read as its OWN
// marking on the battlefield and never be mistaken for a muzzle glow, a projectile, a powerup, an
// enemy accent, or the alert/UI reds. The audit method is #404's exactly (see mechColors.test.js,
// which reuses players.test.js's hsl/confusable check verbatim over this whole set):
//   • hue+tone distance from every signal colour (a hue within 20° only clashes if its tone is
//     also close — a drab olive body and a vivid lime rim share a hue family but never confuse),
//   • NOTHING in the 0–45° danger band (that whole arc is either an alert red or a ballistic
//     muzzle gold), and
//   • the FIRST FOUR entries are exactly PLAYER_COLORS, so every player's auto-default is itself a
//     selectable swatch and the picker can always highlight "your current colour".
//
// The occupied hues this set is picked AROUND (from #404): 0–45° alert/ballistic, ~76° infantry
// olive, ~140–145° support green, ~172–196° energy/shield/infinite-fire/wall-turret cyans, ~264–288°
// reactor/barrage/carrier violets, ~331° missile pink. The clean gaps left are the blues (216–245),
// a green ramp (83–173 kept clear of olive and the support/cyan bands by hue+tone), magenta (307)
// and a wine-rose (323, tone-separated from the missile pink). The violet band 255–290 is fully
// occupied, so the only violet-family swatch is the indigo at 245.
//
// This is the ONE place a swatch value lives — Jackson approves/adjusts the hexes here (like #404's
// four were shown to him first); mechColors.test.js re-runs the whole clash audit on any edit.
export const MECH_SWATCHES = [
  0x427ffa, // AZURE      (h220) electric blue    — PLAYER_COLORS[0], P1 auto-default
  0x7cf042, // LIME       (h100) lime             — PLAYER_COLORS[1], P2 auto-default
  0xff3de8, // MAGENTA    (h307) magenta          — PLAYER_COLORS[2], P3 auto-default
  0x17cf82, // JADE       (h155) jade             — PLAYER_COLORS[3], P4 auto-default
  0x5a86c8, // STEEL      (h216) muted steel blue — same hue family as azure, half the saturation
  0x6a5cff, // INDIGO     (h245) blue-violet      — the one clean violet-family gap
  0xd63f9c, // ROSE       (h323) wine rose        — 8° off missile pink but a full tone apart
  0xa6e838, // CHARTREUSE (h83)  yellow-green     — sat twice the infantry olive it neighbours
  0x2fa83f, // FOREST     (h128) deep green
  0x0f9c8c, // TEAL       (h173) deep teal        — dark enough to never read as the cyan glows
  // Standard neutrals (low/zero saturation) — every hue band above is already packed tight against
  // a signal colour, but a near-zero-saturation swatch can't be confused with any of them regardless
  // of hue: the audit's own rule is that a shared hue only clashes when the TONE is also close, and
  // a vivid alert red/ballistic gold is about as far in tone from a desaturated neutral as it gets.
  0xe6e6ea, // WHITE      near-white cool grey
  0x8a8f96, // ASH        true neutral mid grey
  0x3a3d42, // CHARCOAL   dark neutral grey — kept off pure black so it stays visible against shadow
  0xb08968, // BRONZE     desaturated warm tan/brown
  // Vivid warm colours (2026-07-26, Jackson's explicit call): these DO sit in/near the 0–45° band
  // this file otherwise avoids on purpose (alert red, ballistic muzzle gold) — asked for anyway,
  // accepting the risk of reading as an alert/muzzle flash in the heat of combat, to be judged in
  // actual play rather than screened out here.
  0xff8a1f, // ORANGE     (h29)  vivid orange
  0xf7d000, // YELLOW     (h50)  vivid yellow
  0xe23a55, // CRIMSON    (h352) vivid red
  // Two more blues, tone-separated from AZURE/STEEL/INDIGO above rather than duplicating either.
  0x6cc3f5, // SKY        (h204) light pale blue
  0x1f3f78, // NAVY       (h226) dark saturated navy
];

// Human-readable name per swatch, aligned index-for-index with MECH_SWATCHES. The cycle picker
// (#487, second pass) shows the CURRENT colour's name beside a single indicator swatch instead of
// the old 10-tile grid, so the name lives here as data next to the hex it names.
export const MECH_SWATCH_NAMES = [
  'AZURE', 'LIME', 'MAGENTA', 'JADE', 'STEEL',
  'INDIGO', 'ROSE', 'CHARTREUSE', 'FOREST', 'TEAL',
  'WHITE', 'ASH', 'CHARCOAL', 'BRONZE',
  'ORANGE', 'YELLOW', 'CRIMSON', 'SKY', 'NAVY',
];

// The display name for a swatch hex, or '' if it isn't one.
export function swatchName(color) {
  const i = MECH_SWATCHES.indexOf(color);
  return i >= 0 ? MECH_SWATCH_NAMES[i] : '';
}

// Fast membership test — one Set, built once. A saved Mech.color is only honoured if it is still
// a real swatch, so trimming/re-picking the palette can never leave a slot showing a colour the
// picker no longer offers.
const SWATCH_SET = new Set(MECH_SWATCHES);

export function isSwatch(color) {
  return typeof color === 'number' && SWATCH_SET.has(color);
}

// The auto-default colour for player `index` — the #348/#404 assignment. Always one of the first
// four swatches (they ARE PLAYER_COLORS), so a player who never picks still resolves to a swatch.
export function defaultMechColor(index) {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[(((index ?? 0) % n) + n) % n];
}

// The colour a build ACTUALLY shows: its explicit valid pick, else the per-player default. This is
// the single resolver both surfaces call — the garage preview and the arena spawn/reskin — so the
// two can never disagree about what colour a slot is. `build` is duck-typed (a Mech or a raw save
// object); only `.color` is read.
export function mechColorFor(build, index) {
  return isSwatch(build?.color) ? build.color : defaultMechColor(index);
}

// ── Co-op distinctness (#487) ───────────────────────────────────────────────────────────────
// Each player picks in their own garage turn, and no two live players may hold the same colour, so
// the picker greys out any swatch already held by ANOTHER joined player. `builds` is the joined
// players' builds in player order; `editingIndex` is whose turn it is. Each other player holds its
// resolved colour (explicit pick OR default). Solo (one build) yields an empty set — P1 picks
// freely from the whole palette.
export function takenSwatches(builds, editingIndex) {
  const taken = new Set();
  (builds ?? []).forEach((b, i) => {
    if (i === editingIndex) return;
    taken.add(mechColorFor(b, i));
  });
  return taken;
}

// Can the player at `editingIndex` select `color`? Only a real swatch not already held by another
// player. The editing player's OWN current colour is always selectable (re-picking is a no-op),
// because it is excluded from `takenSwatches`. This one predicate backs BOTH the picker's
// enable/disable state AND the guard the pick action re-checks, so the UI and the model agree.
export function canPickSwatch(builds, editingIndex, color) {
  if (!isSwatch(color)) return false;
  return !takenSwatches(builds, editingIndex).has(color);
}

// #614: WHICH other player holds `color` — the index of the first build (other than `editingIndex`)
// whose resolved colour is `color`, or -1 if nobody does. `canPickSwatch` answers whether a swatch
// is available; this answers who took it, which is what the greyed-out card has to NAME ("P2") so
// the player can decide what to switch to instead. Same walk as `takenSwatches` by construction —
// a colour is unavailable exactly when this returns >= 0 — so display and guard cannot disagree.
export function swatchHolder(builds, editingIndex, color) {
  const list = builds ?? [];
  for (let i = 0; i < list.length; i++) {
    if (i === editingIndex) continue;
    if (mechColorFor(list[i], i) === color) return i;
  }
  return -1;
}

// ── Legible variants of an identity colour (#614/#615) ────────────────────────────────────────
// A swatch is chosen to read as MECH PAINT on the battlefield, which is a different job from
// reading as UI INK on a near-black panel: CHARCOAL (0x3a3d42) and NAVY (0x1f3f78) are deliberate,
// good picks for a mech and all but invisible as a 2px cursor ring or a label over the dim
// "unavailable" scrim. `legibleColor` derives the UI variant — same HUE, so it still reads as that
// player's colour, with brightness guaranteed:
//   • VALUE floored at MIN_V, so a dark pick is lifted to a bright one, and
//   • SATURATION capped at MAX_S, so the floor actually reaches every channel (a fully saturated
//     colour has a zero channel no matter how high its value is, which is what leaves NAVY dark).
// Together those pin the darkest channel at MIN_V * (1 - MAX_S) ≈ 0.26 and the brightest at
// MIN_V ≈ 0.85 — comfortably clear of the card panel (0x161b22) and the lock scrim beneath it —
// while a colour that is ALREADY bright (AZURE, WHITE, LIME) comes back essentially untouched.
// Pure RGB↔HSV here rather than Phaser's colour helpers: this module stays Phaser-free.
const MIN_V = 0.85;
const MAX_S = 0.70;

export function legibleColor(color) {
  const r = ((color >> 16) & 0xff) / 255, g = ((color >> 8) & 0xff) / 255, b = (color & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const v = Math.max(max, MIN_V);
  const s = Math.min(max === 0 ? 0 : d / max, MAX_S);
  // HSV → RGB.
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [nr, ng, nb] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  const byte = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return (byte(nr) << 16) | (byte(ng) << 8) | byte(nb);
}

// ── The cycle picker's resolver (#487, second pass) ───────────────────────────────────────────
// The garage swatch GRID read as garish, so the picker became a single CURRENT-COLOUR indicator
// advanced by a button (gamepad + keyboard) and on-screen ‹ › arrows. This is the pure step: from
// `current`, walk `dir` (+1 forward / -1 back) through the palette and return the FIRST swatch the
// editing player may actually pick — i.e. skipping any colour a live co-op player already holds
// (their pick OR default), exactly what `canPickSwatch` gates. Wraps around the palette. If nothing
// else is available (e.g. solo with a one-colour palette, or every other swatch taken), it returns
// `current` unchanged — the editing player's own colour is always pickable, so the cycle simply
// lands back on itself and the pick becomes a no-op rather than an error.
export function cycleSwatch(builds, editingIndex, current, dir = 1) {
  const n = MECH_SWATCHES.length;
  if (n === 0) return current;
  const step = dir < 0 ? -1 : 1;
  // Start from `current`'s slot; if it isn't a swatch, a forward step lands on index 0 first.
  let idx = MECH_SWATCHES.indexOf(current);
  for (let i = 0; i < n; i++) {
    idx = (((idx + step) % n) + n) % n;
    const hex = MECH_SWATCHES[idx];
    if (canPickSwatch(builds, editingIndex, hex)) return hex;
  }
  return current;
}
