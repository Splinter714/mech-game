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
];

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
