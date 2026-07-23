// Per-player HUD layout (#366, co-op phase 4).
//
// The arena HUD was written for THE player: one integrity column top-left, one skill-tile row
// along the bottom. In co-op that left player 2 with no weapon, ammo or health
// readout at all — the same "a player-1 value used where each-player was meant" shape as #360,
// #364 and #365. Jackson chose a FULL second HUD, not a compact health/ammo strip.
//
// This module is the pure part: given how many players are on the field it hands back where each
// player's panel goes, plus where the SHARED readouts (enemy count, buff rings) go so they don't
// collide with a right-hand panel. No Phaser, no scene — HudScene just builds to these numbers.
//
// **Solo is byte-identical.** With `count === 1` every number below is literally the constant
// that was hardcoded in HudScene before this issue: the column at x=16, the tile row spanning
// `W*0.12 .. W*0.88`, the enemy count right-aligned at `W-16`, the buff rings hugging the right
// edge. One player therefore gets exactly today's HUD in today's position, on every path.
//
// The layout is asked EVERY FRAME from the live player list, never decided once at construction —
// #348's player-ring fix had exactly the mid-sortie-join bug that comes from deciding at build
// time, so pressing START on gamepad 2 mid-sortie has to grow a second panel with no redeploy.

// Width reserved for one integrity column: the short location label, the armor/hp bar, and the
// numbers to its right ("255+255/255+255" at 11px monospace). HudScene's own PART_BAR_X/W feed
// the first two; this is their sum plus the number column, kept here because it is what decides
// how far in from the right edge a second panel has to start.
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
//    the two rows read as belonging to the column above them. The shared enemy/buff readouts
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
      // Today's shared readouts: right-aligned enemy count, rings hugging the right edge.
      shared: { enemyX: W - HUD_EDGE, enemyOriginX: 1, buffCx: W - HUD_EDGE - BUFF_RING_R },
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
    shared: { enemyX: Math.round(W / 2), enemyOriginX: 0.5, buffCx: Math.round(W / 2 + 78) },
    // Keep the off-screen chevrons clear of BOTH columns now that the right edge is occupied.
    margins: { left: 24, right: HUD_COLUMN_W + 24 },
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
