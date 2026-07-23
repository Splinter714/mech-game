// Per-player HUD layout (#366, co-op phase 4).
//
// The arena HUD was written for THE player: one integrity column top-left, one skill-tile row
// along the bottom. In co-op that left player 2 with no weapon, ammo or health
// readout at all — the same "a player-1 value used where each-player was meant" shape as #360,
// #364 and #365. Jackson chose a FULL second HUD, not a compact health/ammo strip.
//
// This module is the pure part: given how many players are on the field it hands back where each
// player's panel goes, plus where the SHARED readouts (the objective line, buff rings) go so they
// don't collide with a right-hand panel. No Phaser, no scene — HudScene just builds to these numbers.
//
// **Solo is byte-identical.** With `count === 1` every number below is literally the constant
// that was hardcoded in HudScene before this issue: the column at x=16, the tile row spanning
// `W*0.12 .. W*0.88`, the top-right readout right-aligned at `W-16`, the buff rings hugging the
// right edge. One player therefore gets exactly today's HUD in today's position, on every path.
//
// #449: the top-right shared slot used to hold the ENEMY COUNT; it now holds the OBJECTIVE LINE
// (the enemy/structure tally folded into that line via data/bases.js `baseClearLabel`), so the
// fields are named for what actually rides there. The geometry is unchanged.
//
// The layout is asked EVERY FRAME from the live player list, never decided once at construction —
// #348's player-ring fix had exactly the mid-sortie-join bug that comes from deciding at build
// time, so pressing START on gamepad 2 mid-sortie has to grow a second panel with no redeploy.
//
// #448: the integrity readout itself moved from a top-left COLUMN to a bottom-corner block of
// vertical bars — see `INTEGRITY_BARS`/`integrityLayout` below. A panel's `columnX` still names
// which edge that player's chrome hugs (and still places the block), so the panel geometry here
// is unchanged; only what gets drawn against it changed.

import { LOCATIONS } from './anatomy.js';

// Width reserved for ONE player's side of the screen. It used to be the literal width of the
// top-left integrity column (label + bar + the "255+255/255+255" numbers beside it); #448 moved
// that readout to the bottom corner and deleted the numbers, so it is now simply the band each
// player's chrome owns on its own edge — what decides how far in from the right edge a second
// panel starts, and the right edge a right-hand panel's bottom block hangs off. Unchanged value:
// the co-op column/tile geometry is tuned around it.
export const HUD_COLUMN_W = 226;

// Screen inset shared by both panels' columns — today's left-hand column sits at x=16.
export const HUD_EDGE = 16;

// Buff-ring geometry that has to agree between here and HudScene's `_updateBuffHud` (the ring
// radius decides how far in from its anchor the stack of rings actually starts).
export const BUFF_RING_R = 15;

// Where each player's panel lives, plus where the shared readouts move to.
//
//  - `count === 1` → one panel, all of today's numbers.
//  - `count >= 2`  → player 1 keeps the left column, player 2 gets a mirrored right column, and
//    the bottom tile row splits into two half-width rows (left half = P1, right half = P2) so
//    the two rows read as belonging to the column above them. The shared objective/buff readouts
//    move to top-centre, which is the one region neither panel claims — leaving them top-right
//    would have them draw straight through player 2's integrity column.
export function hudLayout(count, W) {
  const n = Math.max(1, count | 0);
  if (n === 1) {
    return {
      count: 1,
      panels: [{
        index: 0,
        side: 'left',
        columnX: HUD_EDGE,
        tilesX: W * 0.12,
        tilesW: W * 0.76,
      }],
      // Today's shared readouts: right-aligned objective line, rings hugging the right edge.
      shared: { objectiveX: W - HUD_EDGE, objectiveOriginX: 1, buffCx: W - HUD_EDGE - BUFF_RING_R },
      // Today's wayfinding margins (HudScene adds the top/bottom, which don't change).
      margins: { left: 24, right: 24 },
    };
  }
  const half = 0.45;
  const panels = [
    {
      index: 0,
      side: 'left',
      columnX: HUD_EDGE,
      tilesX: W * 0.03,
      tilesW: W * half,
    },
    {
      index: 1,
      side: 'right',
      columnX: Math.round(W - HUD_EDGE - HUD_COLUMN_W),
      tilesX: W * 0.52,
      tilesW: W * half,
    },
  ];
  return {
    count: n,
    panels: panels.slice(0, n),
    shared: { objectiveX: Math.round(W / 2), objectiveOriginX: 0.5, buffCx: Math.round(W / 2 + 78) },
    // Keep the off-screen chevrons clear of BOTH columns now that the right edge is occupied.
    margins: { left: 24, right: HUD_COLUMN_W + 24 },
  };
}

// ── #448: the integrity readout's own geometry ───────────────────────────────────────────────
//
// The armor/HP/shield readout is a block of VERTICAL bars in the bottom corner of that player's
// side (bottom-LEFT for player 1), sharing the skill-tile row's baseline so stage 3's console
// frame (#452) can wrap or abut both without moving either. Bars only — no numbers anywhere.
//
// One SEGMENT per damage-tracked location, each segment being two bars: HP on the LEFT, armor on
// the RIGHT (armor drains first in play, so the right-hand bar is the one that empties first, and
// both keep their empty space visible — armor because it can be patched back up, HP because the
// loss has to stay legible even though it never refills). Then a gap and ONE more bar, rightmost:
// the whole-mech shield, which is not per-segment.
//
// Everything is derived from `INTEGRITY_BARS` rather than hardcoded in the scene, so #452 can
// reposition/reframe the block by changing these numbers alone.
export const INTEGRITY_BARS = {
  barW: 9,          // one bar's nominal width
  innerGap: 2,      // between a segment's HP bar and its armor bar
  segGap: 7,        // between segments
  shieldGap: 11,    // between the last segment and the overall shield bar
  shieldW: 11,      // the shield bar is a touch wider — it is not one of the pairs
  barH: 76,         // bar height (never squeezed: only the widths give)
  labelH: 13,       // room under the bars for the two-letter location label
  headerH: 20,      // room above the bars for the panel header
  statusH: 15,      // the downed/respawn line, above the header
  tileClear: 10,    // breathing room between the block and the skill-tile row beside it
  minScale: 0.55,   // never squeeze the bars thinner than this, even in a cramped co-op half
  shieldMaxGrowth: 2,   // #381's temp pool grows the shield bar UPWARD; cap how far
};

// Left→right body order for the segments, matching the skill-tile row (ui/skillTiles.js
// TILE_ORDER) so the block reads as the same paper-doll the buttons under it do. Filtered
// through LOCATIONS so it can only ever name locations the model actually tracks damage on
// (#448: the four mount locations ARE the damage-tracked set and the kill condition — legs and
// the cosmetic head/cockpit/centre torso are not tracked and must not appear here).
export const INTEGRITY_ORDER = ['leftArm', 'leftTorso', 'rightTorso', 'rightArm']
  .filter((loc) => LOCATIONS.includes(loc));

// Where every bar in one player's integrity block goes. `anchorX` is the block's OUTER edge on
// its own side of the screen (its left edge for a left-hand panel, its right edge for a
// right-hand one), `bottomY` the baseline it shares with the skill tiles, and `availW` how much
// room there is between that edge and the tiles. A cramped co-op half squeezes the WIDTHS
// (uniformly, down to `minScale`) and never the height, so both players' bars stay the same
// length and read against each other. A missing/zero `availW` means "unmeasured" and lays the
// block out at full size. Pure — HudScene only paints to these numbers.
export function integrityLayout(locs, { anchorX, bottomY, availW, side = 'left' }) {
  const S = INTEGRITY_BARS;
  const n = locs.length;
  const nominal = n * (2 * S.barW + S.innerGap) + (n - 1) * S.segGap + S.shieldGap + S.shieldW;
  const scale = Math.max(S.minScale, Math.min(1, (availW > 0 ? availW : nominal) / nominal));
  const barW = S.barW * scale;
  const innerGap = S.innerGap * scale;
  const segGap = S.segGap * scale;
  const segW = 2 * barW + innerGap;
  const shieldW = S.shieldW * scale;
  const w = n * segW + (n - 1) * segGap + S.shieldGap * scale + shieldW;
  const x = side === 'right' ? anchorX - w : anchorX;
  const bottom = bottomY - S.labelH;
  const top = bottom - S.barH;
  const segments = locs.map((loc, i) => {
    const sx = x + i * (segW + segGap);
    // HP left, armor right — the order is the whole point of the pairing, so it lives here.
    return { loc, x: sx, w: segW, cx: sx + segW / 2, hpX: sx, armorX: sx + barW + innerGap };
  });
  return {
    scale, x, w, top, bottom, barW, barH: S.barH,
    labelY: bottom + 2,
    headerY: top - S.headerH,
    statusY: top - S.headerH - S.statusH,
    segments,
    // The shield slot is reserved whether or not this mech HAS a shield, so a build without one
    // doesn't shift every other bar sideways relative to a build with one.
    shield: { x: x + w - shieldW, w: shieldW, maxGrowth: S.shieldMaxGrowth },
  };
}

// The header over an integrity column. Solo keeps the bare 'INTEGRITY' it has always had; only
// once there is somebody to be told apart from does it name the player — the same rule as
// `showsPlayerColor` (data/players.js), so the HUD label and the on-field ring/reticle colour
// turn on together and never disagree about whether identification is even in play.
export function panelLabel(index, count) {
  return count > 1 ? `P${index + 1} INTEGRITY` : 'INTEGRITY';
}

// A downed player's panel must read sensibly rather than showing a stale or zeroed column. This
// is the line shown across their panel while they wait. `respawn` is data/respawn.js's own state
// ({ remainingMs, waitingOnCombat }) — the clock keeps ticking while the survivor is under fire
// and it is the PLACEMENT that waits, so "clock done but still hot" gets its own wording rather
// than sitting at a silent 0.0s.
export function panelStatusText(snapshot) {
  if (!snapshot || !snapshot.dead) return '';
  const r = snapshot.respawn;
  if (!r || r.remainingMs == null) return 'DESTROYED';
  if (r.waitingOnCombat) return 'DOWN — WAITING FOR THE ALL-CLEAR';
  return `DOWN — RESPAWN ${(r.remainingMs / 1000).toFixed(1)}s`;
}

// #368: the world point of a player's OWN current lock target, as a plain `{x,y}` copy (or null
// when there is no target / it just died). Mirrors targeting.js `_lockAimPoint`'s liveness rule
// exactly — the difference is deliberate: that one hands back the LIVE enemy handle because homing
// rounds must keep following it, while the HUD only ever wants this frame's position, and copying
// keeps the published snapshot free of scene internals.
export function lockPointOf(p) {
  const t = p?.convergeTarget;
  if (!t) return null;
  if (t.mech && t.mech.isDestroyed()) return null;
  return { x: t.x, y: t.y };
}

// The per-frame snapshot ONE player publishes to the HUD. Everything the HUD needs about a
// player and nothing else, so the HUD never reaches into scene internals (and so a test can
// build one by hand). Pure.
export function hudPlayerSnapshot(p) {
  return {
    id: p.id,
    color: p.color,
    mech: p.mech,
    dead: !!p.dead,
    // #368: each player's own off-screen lock chevron rides this same channel rather than a
    // second parallel one — the count-change rebuild in HudScene then covers the chevrons too.
    lock: lockPointOf(p),
    respawn: p.respawn ? { ...p.respawn } : null,
  };
}

// Does the HUD have to REBUILD its panels this frame? Only when the number of players changed —
// panel geometry is a function of the count alone, so a steady co-op frame rebuilds nothing while
// a mid-sortie join (or a garage-deploy pair) is picked up the very frame it happens. Asked every
// frame on purpose; deciding this once at construction is the #348 join bug.
export function panelsNeedRebuild(builtCount, liveCount) {
  return builtCount !== Math.max(1, liveCount | 0);
}
