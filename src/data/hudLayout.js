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
//
// #449: the top-right shared slot used to hold the ENEMY COUNT; it now holds the OBJECTIVE LINE
// (the enemy/structure tally folded into that line via data/bases.js `baseClearLabel`), so the
// fields are named for what actually rides there. The geometry is unchanged.
//
// The layout is asked EVERY FRAME from the live player list, never decided once at construction —
// #348's player-ring fix had exactly the mid-sortie-join bug that comes from deciding at build
// time, so pressing START on gamepad 2 mid-sortie has to grow a second panel with no redeploy.
//
// #448: the integrity readout itself moved from a top-left COLUMN to a block of vertical bars on
// the tile row's baseline — see `INTEGRITY_BARS`/`integrityLayout` below.
//
// #452 (style pass): nothing in the bottom band hugs a screen edge any more. The integrity block
// and the tile row are packed into ONE centred console band (`consoleBand`) whose width is the
// width of its contents, and the locked-enemy readout left the band entirely for a disc in the
// top-left corner (`targetDiscBox`), mirroring the minimap's disc top-right.

import { LOCATIONS } from './anatomy.js';

// Screen inset for the top-corner chrome (the objective line, the buff rings).
export const HUD_EDGE = 16;

// ── #452 (style pass): the two CORNER DISCS ──────────────────────────────────────────────────
//
// The minimap has always been a disc pinned to the top-RIGHT corner. The locked-enemy preview —
// which shipped as a bay in the bottom-right of the console — now mirrors it as a disc in the
// top-LEFT (Jackson: "the locked enemy preview should be in a circle top left similar to the
// minimap on top right; both circles should be the same size, and should be slightly larger than
// current minimap size"). ONE size constant feeds both, so they can never drift apart; it is a
// touch larger than the 132px the map used to be.
//
// Co-op stacks a second target disc directly under the first rather than putting one in each top
// corner: the right corner is the map's, and two players each need their own lock readout.
export const HUD_DISC = {
  d: 150,          // diameter of BOTH discs (was 132 for the map alone)
  inset: 14,       // screen inset, unchanged from the map's
  nameH: 20,       // room under a target disc for its unit-name line
  stackGap: 8,     // between one target disc's name line and the next disc down
};

// The minimap's bounding box (a square whose inscribed circle is the disc).
export function minimapBox(W) {
  const { d, inset } = HUD_DISC;
  return { x: W - inset - d, y: inset, w: d, h: d };
}

// One player's target disc, stacked down the left edge.
export function targetDiscBox(index = 0) {
  const { d, inset, nameH, stackGap } = HUD_DISC;
  return { x: inset, y: inset + index * (d + nameH + stackGap), w: d, h: d };
}

// How far down the screen the top-corner chrome reaches — what the wayfinding chevrons and the
// objective line have to clear.
export function discReserveBottom(count = 1) {
  const b = targetDiscBox(Math.max(1, count | 0) - 1);
  return b.y + b.h + HUD_DISC.nameH;
}

// Buff-ring geometry that has to agree between here and HudScene's `_updateBuffHud` (the ring
// radius decides how far in from its anchor the stack of rings actually starts).
export const BUFF_RING_R = 15;

// ── #449: the OBJECTIVE BLOCK ────────────────────────────────────────────────────────────────
//
// Jackson, playtest 2026-07-22: "it's hard to read" → triage: "fewer lines, bigger, and solid
// backing". The block is now ONE line (the base-clear requirement, which #449 already folded the
// enemy tally into), set large, on an OPAQUE plate so it reads over snow, sand or a burning
// compound alike — the same problem the minimap's near-solid backing solved in #383, solved the
// same way rather than with an outline or a shadow.
//
// It hangs under the top-right minimap disc in solo and moves to top-centre in co-op (see
// `hudLayout` below); the plate is sized to whatever the line MEASURES, so neither placement can
// clip it and neither can collide with the disc above it.
export const OBJECTIVE_PANEL = {
  fontSize: 20,     // px — "bigger", up from the 13px it shipped at
  padX: 14,
  padY: 8,
  radius: 8,
  minW: 120,        // a very short line still reads as a plate, not a chip
};

// The backing plate for a measured objective line. `x`/`y` are where the TEXT is anchored and
// `originX` how it is anchored there (1 = right-aligned under the map, 0.5 = centred in co-op) —
// exactly the two values `hudLayout().shared` hands the scene, so the plate can never drift off
// the text it backs. Pure: HudScene measures the Text object and paints this rect.
export function objectivePanelRect(textW, textH, { x, y, originX = 1 }) {
  const P = OBJECTIVE_PANEL;
  // The text's own span, inflated by the padding...
  let left = x - originX * textW - P.padX;
  let w = textW + P.padX * 2;
  // ...then grown to the floor width AWAY from whichever edge the text is anchored to, so a
  // right-aligned plate grows leftward (never out past the screen edge it is tucked against) and
  // a centred one grows both ways.
  if (w < P.minW) {
    left -= (P.minW - w) * originX;
    w = P.minW;
  }
  return { x: Math.round(left), y: Math.round(y - P.padY), w: Math.round(w), h: Math.round(textH + P.padY * 2) };
}

// Which panels exist, plus where the shared readouts sit.
//
// #452 (style pass) took the per-panel SCREEN-EDGE geometry out of here. The bottom readouts no
// longer hug the left/right edges at all: they are packed into ONE centred console whose width is
// the width of its contents (see `consoleBand`), so a panel spec is now just "player N exists" and
// the band decides where that player's block and tile row land. What survives here is the only
// thing that still differs by count: the shared objective line + buff rings are right-aligned
// under the corner minimap in solo, and move to top-centre in co-op (where the top-left corner is
// a stack of target discs and the top-right is the map).
export function hudLayout(count, W) {
  const n = Math.max(1, count | 0);
  return {
    count: n,
    panels: Array.from({ length: n }, (_, index) => ({ index })),
    shared: n === 1
      ? { objectiveX: W - HUD_EDGE, objectiveOriginX: 1, buffCx: W - HUD_EDGE - BUFF_RING_R }
      : { objectiveX: Math.round(W / 2), objectiveOriginX: 0.5, buffCx: Math.round(W / 2 + 78) },
    // Wayfinding margins. Both edges are now free of HUD chrome below the corner discs (the
    // console is centred and narrow), so a chevron only has to clear the screen inset.
    margins: { left: 24, right: 24 },
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
// #452: `headerH` shrank (20 → 16) and the separate `statusH` slot is GONE. The downed/respawn
// line now REPLACES the header on the same line instead of stacking a second one above it —
// they're mutually exclusive states ("this is your integrity" / "you are down, here is the
// clock"), and the console shell that now wraps this block (see `CONSOLE` below) takes its height
// from whatever the tallest thing in the band is. Stacking two text rows nobody ever sees at once
// made the console 15px taller for nothing.
export const INTEGRITY_BARS = {
  barW: 9,          // one bar's nominal width
  innerGap: 2,      // between a segment's HP bar and its armor bar
  segGap: 7,        // between segments
  shieldGap: 11,    // between the last segment and the overall shield bar
  shieldW: 11,      // the shield bar is a touch wider — it is not one of the pairs
  barH: 76,         // bar height (never squeezed: only the widths give)
  labelH: 13,       // room under the bars for the two-letter location label
  headerH: 16,      // room above the bars for the panel header (or the downed line in its place)
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
    // The header line. The downed/respawn line shares it (see the INTEGRITY_BARS note) — one of
    // the two is drawn, never both, so there is exactly one text row above the bars.
    headerY: top - S.headerH,
    segments,
    // The shield slot is reserved whether or not this mech HAS a shield, so a build without one
    // doesn't shift every other bar sideways relative to a build with one.
    shield: { x: x + w - shieldW, w: shieldW, maxGrowth: S.shieldMaxGrowth },
  };
}

// ── #452: the CONSOLE ────────────────────────────────────────────────────────────────────────
//
// The integrity readout and the skill tiles sit in ONE mech-style instrument shell along the
// bottom edge. The style pass changed two things about that shell (Jackson: "too much
// transparency and too full-screen-width; it should have similar opaque colors and styles as the
// mech art itself, and it should be centered and only as wide as it needs to be"):
//
//   - it is drawn OPAQUE, in the player mech's own plate palette (HudScene borrows `themeFor`
//     from art/mechPrims.js, so the console is literally painted in the mech's colours), and
//   - it is only as wide as its CONTENTS, centred on the screen — which means the contents can no
//     longer be placed against the screen edges. `consoleBand` packs each player's group
//     (integrity block, then that player's four skill tiles) into one centred run and hands back
//     where each piece lands; the shell is then simply that run plus its padding.
//
// The target readout is no longer in here at all — it moved to the top-left disc (`targetDiscBox`).
export const CONSOLE = {
  // #452 follow-up (Jackson: the console must reach the BOTTOM EDGE of the screen — "there's
  // currently a gap between the console and the bottom of the viewport"). The shell is FLUSH: its
  // rounded top lip is the only visible edge, and the bottom runs off the frame, which is what
  // makes it read as built into the machine rather than as a floating card. This stays 0 whatever
  // is inside the band — a NONE-mode band (#448) is shorter, not lifted.
  edgeGap: 0,       // px of bare screen left showing past the shell at the bottom
  padX: 16,         // inner padding at each END of the shell
  padTop: 10,       // inner padding above the tallest bay
  radius: 14,       // the shell's TOP corner rounding (the bottom is flush with the screen edge)
  bayRadius: 8,     // a recessed bay's corner rounding
  bayPad: 6,        // how far a bay's frame stands off the content inside it
  railInset: 18,    // how far in from each end the lit top rail runs
  boltInset: 10,    // bolt heads, in from each end of the rail
  boltR: 1.7,
  blockGap: 16,     // one player's integrity block ↔ that player's own tile row
  playerGap: 34,    // one player's whole group ↔ the next player's
};

// The skill tile row's own dial. The row is FOUR tiles, and in a centred console they want their
// natural size — only a genuinely narrow window (or a co-op pair) ever squeezes them.
export const CONSOLE_TILES = { n: 4, gap: 12, max: 92, min: 46 };

export function tileRowWidth(size, n = CONSOLE_TILES.n, gap = CONSOLE_TILES.gap) {
  return size * n + gap * (n - 1);
}

// The biggest tile size that still lets every player's group fit across the screen. `blockWs` is
// each player's integrity-block width (which differs per readout mode — bars, orbs, paper doll —
// so it is measured, not assumed).
export function consoleTileSize(W, blockWs) {
  const n = Math.max(1, blockWs.length);
  const budget = W - CONSOLE.edgeGap * 2 - CONSOLE.padX * 2
    - blockWs.reduce((s, b) => s + blockRun({ blockW: b }), 0)
    - CONSOLE.playerGap * (n - 1);
  const size = Math.floor((budget / n - CONSOLE_TILES.gap * (CONSOLE_TILES.n - 1)) / CONSOLE_TILES.n);
  return Math.max(CONSOLE_TILES.min, Math.min(CONSOLE_TILES.max, size));
}

// Pack the groups into one centred run. `groups` is `[{ blockW, tilesW }]` in player order; each
// one comes back with the x its integrity block and its tile row start at. The band's own
// `{ x, w }` is what the shell is drawn to — so the shell is exactly its contents plus `padX`,
// and centring the band centres the console.
// #448: a group whose integrity block has ZERO width (the NONE readout) takes NO block gap either.
// Without this the band would keep a 16px void where the block used to be and the console would
// read as a panel with a bite out of it — "collapse gracefully" is the whole requirement of that
// mode. One rule here rather than a mode check in the scene, so every caller gets it.
function blockRun(g) {
  return g.blockW > 0 ? g.blockW + CONSOLE.blockGap : 0;
}

export function consoleBand(W, groups) {
  const inner = groups.reduce((s, g) => s + blockRun(g) + g.tilesW, 0)
    + CONSOLE.playerGap * Math.max(0, groups.length - 1);
  const w = Math.round(inner + CONSOLE.padX * 2);
  const x = Math.round((W - w) / 2);
  let cx = x + CONSOLE.padX;
  const placed = groups.map((g) => {
    const blockX = cx;
    const tilesX = cx + blockRun(g);
    cx = tilesX + g.tilesW + CONSOLE.playerGap;
    return { blockX, blockW: g.blockW, tilesX, tilesW: g.tilesW };
  });
  return { x, w, groups: placed };
}

// The shell's rectangle: the band's own x/width, running from the tallest thing in it down to the
// bottom edge. `contentTop` is the highest thing any panel put in the band (in practice the
// integrity header line, which sits a touch above the tile row).
export function consoleLayout(H, contentTop, band) {
  const y = Math.round(contentTop - CONSOLE.padTop);
  return { x: band.x, y, w: band.w, h: H - CONSOLE.edgeGap - y };
}

// ── #452 (style pass): the TARGET DISC ───────────────────────────────────────────────────────
//
// The locked-enemy readout, as the top-left mirror of the corner minimap: an animated preview of
// the unit posed inside the disc, ringed by three concentric GAUGE ARCS carrying the same three
// layers the player's own block draws — shield, armor, structure. #478 inverted the ring order so
// SHIELD is the outermost ring and HP/structure the innermost; the player's own integrity bars keep
// their own left → right order, so the two readouts no longer have to match (the owner's call).
export const TARGET_DISC = {
  ringW: 4,         // one gauge ring's stroke width
  ringGap: 1.5,     // between rings (trimmed with the thicker rings so the art square barely shrinks)
  rimInset: 4,      // the outermost ring, in from the disc's frame
  artPad: 5,        // between the innermost ring and the art's bounding square
  order: ['shield', 'armor', 'hp'],   // outermost → innermost (#478: shield outermost, structure in)
};

// Every number the target disc is painted from, for a given bounding box (`targetDiscBox`).
export function targetDiscLayout(box) {
  const T = TARGET_DISC;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = box.w / 2;
  const rings = T.order.map((key, i) => ({
    key,
    r: r - T.rimInset - T.ringW / 2 - i * (T.ringW + T.ringGap),
    w: T.ringW,
  }));
  // The art sits in the largest square that fits inside the innermost ring.
  const inner = Math.max(0, rings[rings.length - 1].r - T.ringW / 2 - T.artPad);
  const side = inner * Math.SQRT2;
  return {
    cx, cy, r, rings, inner,
    art: { x: cx - side / 2, y: cy - side / 2, w: side, h: side },
    nameX: cx,
    nameY: box.y + box.h + 4,
  };
}

// One gauge arc's sweep: clockwise from twelve o'clock, so a full ring means full and a draining
// one unwinds the way a dial does. `frac` outside 0..1 is clamped; 0 draws nothing.
export function ringSweep(frac) {
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const start = -Math.PI / 2;
  return { start, end: start + f * Math.PI * 2, drawn: f > 0 };
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

// #452: what the target readout shows of a targeted unit's condition, as FRACTIONS in the same
// three layers the player's own block draws — hp, armor, shield. Deliberately aggregate: a
// vehicle (HpBody) genuinely has ONE pool of each, so there is nothing per-location to show for
// most targets, and an enemy mech's four locations would make the pod a second full integrity
// block rather than a glance. Handles both models without either knowing about this file: a flat
// hp/maxHp body reads its own fields, anything part-shaped (a Mech) sums its parts.
export function bodyPools(body) {
  if (!body) return null;
  let hp = 0, maxHp = 0, armor = 0, maxArmor = 0;
  if (typeof body.hp === 'number' && typeof body.maxHp === 'number') {
    hp = body.hp; maxHp = body.maxHp;
    armor = body.armor ?? 0; maxArmor = body.maxArmor ?? 0;
  } else {
    for (const key of Object.keys(body.parts ?? {})) {
      const part = body.parts[key];
      hp += Math.max(0, part.hp ?? 0); maxHp += part.maxHp ?? 0;
      armor += Math.max(0, part.armor ?? 0); maxArmor += part.maxArmor ?? 0;
    }
  }
  const hasShield = body.hasShield?.() ?? false;
  const shieldHp = body.shieldTotalHp?.() ?? body.shield?.hp ?? 0;
  const shieldMax = body.shield?.max ?? 0;
  return {
    hp: maxHp > 0 ? Math.min(1, hp / maxHp) : 0,
    armor: maxArmor > 0 ? Math.min(1, armor / maxArmor) : 0,
    hasArmor: maxArmor > 0,
    shield: hasShield && shieldMax > 0 ? Math.min(1, shieldHp / shieldMax) : 0,
    hasShield,
  };
}

// Which of a mech's locations are gone, as a string. The target pod rebuilds its posed sprites
// when this changes — a mech reskins IN PLACE on damage (same texture keys, new pixels), so
// nothing else would tell the pod that its cached silhouette fit is now wrong.
function damageSignature(body) {
  if (!body?.isPartDestroyed) return '';
  return LOCATIONS.map((loc) => (body.isPartDestroyed(loc) ? '1' : '0')).join('');
}

// #452: the unit ONE player currently has locked, described for the HUD. Reads `convergeTarget`
// — the single pick targeting.js makes each frame — so the readout and the red reticle can never
// be pointed at different things.
//
// Three shapes come back: a `vehicle`/`mech` (a live enemy, with the texture keys its art is
// assembled from and this frame's condition), a `structure` (the lock also takes destructible
// hexes and wall spans, which have no body to read), or null for nothing targeted at all. The
// live `mech` handle rides along ONLY for the mech case, because posing its parts needs the real
// chassis layout; everything else here is plain data.
export function hudTargetSnapshot(p) {
  const t = p?.convergeTarget;
  if (!t) return null;
  const body = t.mech;
  if (!body) return { kind: 'structure', name: t.edgeKey ? 'WALL SECTION' : 'STRUCTURE', pools: null };
  if (body.isDestroyed?.()) return null;
  const isMech = t.kind === 'mech';
  const def = t.kindDef ?? null;
  return {
    kind: isMech ? 'mech' : 'vehicle',
    name: (body.name ?? 'CONTACT').toUpperCase(),
    // The texture set this unit's art is assembled from. One set per unit now (#472 removed the
    // second, "plated" enemy set), so this is simply the unit's own key.
    texKey: t.key ?? null,
    mech: isMech ? body : null,
    art: def?.art ?? null,
    legFrames: def?.legFrames ?? 0,
    turretFrames: def?.turretFrames ?? 0,
    turretFrame: t.turretFrame ?? 0,
    damageSig: isMech ? damageSignature(body) : '',
    pools: bodyPools(body),
  };
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
    // #452: the same pick the chevron above rides, described in full for the bottom-corner target
    // readout — one channel, so the reticle, the off-screen chevron and the readout are three
    // views of ONE decision rather than three separate lookups that can disagree.
    target: hudTargetSnapshot(p),
    respawn: p.respawn ? { ...p.respawn } : null,
  };
}

// #462: the minimap's enemy dots, gated. They used to be published raw — every living enemy,
// every frame, with no visibility test at all — so the corner map quietly revealed the garrison
// of a compound the player had never driven into. This applies the SAME per-enemy rule that
// already decides whether the enemy's SPRITE is drawn (`_enemyPerceivable` →
// `enemyPerceivableInFog`), so a dot can never contradict the world: if you can see it on the map,
// it is on screen, and vice versa. #460: deliberately the PERCEIVABLE gate, not the lockable one —
// hard cover blocks the reticle, not your eyes, so a tank behind a boulder keeps its dot.
//
// Deliberately NO last-seen memory and no fade (owner's call): a dot that is not visible right
// now simply is not published. Co-op needs no extra handling here — the visibility rule itself is
// already team-wide (its hard-cover raycast unions over `fogOriginsOf`, and the compound fog is
// one shared set), so "visible to ANY live player" falls out of asking it once.
//
// `isVisible` is optional so a scene double without the visibility mixin still publishes dots
// (the same `_enemyPerceivable ? … : true` fallback mission.js uses). Pure.
export function minimapEnemyDots(enemies, isVisible = null) {
  const out = [];
  for (const e of enemies ?? []) {
    if (e.mech?.isDestroyed?.()) continue;
    if (isVisible && !isVisible(e)) continue;
    out.push({ x: e.x, y: e.y });
  }
  return out;
}

// Does the HUD have to REBUILD its panels this frame? Only when the number of players changed —
// panel geometry is a function of the count alone, so a steady co-op frame rebuilds nothing while
// a mid-sortie join (or a garage-deploy pair) is picked up the very frame it happens. Asked every
// frame on purpose; deciding this once at construction is the #348 join bug.
export function panelsNeedRebuild(builtCount, liveCount) {
  return builtCount !== Math.max(1, liveCount | 0);
}
