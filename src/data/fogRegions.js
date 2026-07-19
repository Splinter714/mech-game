// #337 — REGION-BASED FOG OF WAR. Pure geometry/set logic, no Phaser; the scene-side wiring is
// scenes/arena/visibility.js.
//
// This REPLACES #306's per-hex raycast dimming. Jackson's framing: "rework the greying out thing,
// I have in 'inside/outside' concept that's less frequently updating that I think would be good".
// The whole point of the model is the CADENCE, so read this before changing anything here:
//
//   • The player is always in exactly ONE region. Regions are (a) a base COMPOUND — its footprint,
//     the thing its wall ring is the outline of — or (b) an OPEN CELL, a coarse block of the open
//     world. Visibility is a property of the REGION, not of the player's exact position, so it
//     changes only when he crosses a region threshold. Driving across a cell recomputes nothing.
//   • Breach/gate reveals are a property of the WALL GEOMETRY, so they change only when a span
//     falls or a gate opens/closes. Static between those events.
//   • Symmetric visibility ("if they can shoot me, I can see them") is per-ENGAGING-ENEMY — a few
//     dozen entities — never per-hex.
//
// There is deliberately NO per-frame, per-hex pass anywhere in this file. If you find yourself
// adding one, you have re-created the thing this issue exists to delete.
import { axialKey, distance, hexToPixel, neighbors, pixelToHex, range } from './hexgrid.js';
import { coverBlocksForRay } from './terrain.js';

// ── Open-world regions ───────────────────────────────────────────────────────────────
// The open world has no natural boundaries to key off, so it is diced into coarse axial BLOCKS:
// `cell = (floor(q/S), floor(r/S))`. The block is only an INDEX — what actually gets revealed is a
// disc centred on the block's centre hex, so the revealed shape reads round rather than as a skewed
// parallelogram. Crossing a block edge is the "threshold" the whole design is built around.
export const OPEN_CELL_SIZE = 5;

// How far the open-cell reveal reaches, in hex rings from the cell centre. Must exceed the cell's
// own half-extent (4 rings, worst corner) or a player at a block corner would be standing at the
// edge of his own light — 9 leaves at least 5 rings ahead in that worst case and ~9 typically.
// Deliberately SHORTER than the camera's reach (~11-13 rings at a normal window) so there is always
// visible fog on screen: fog you never actually see isn't fog. Revealed terrain persists, so the
// moving frontier is what he reads, not the disc.
export const OPEN_REVEAL_RADIUS = 9;

// Fog darkness. #306 ended at DIM_ALPHA 0.8 (near-blackout); Jackson on this rework: "I would like
// to soften the edges of the shadow itself. So it's not quite so stark." Two knobs do that:
// a lower ceiling, and a RAMP so the edge is a gradient over several hexes instead of a stencil.
export const FOG_ALPHA = 0.62;         // never-seen ground
export const KNOWN_ALPHA = 0.34;       // terrain seen earlier this run, not currently in a region
export const FOG_SOFT_STEPS = 3;       // rings over which fog ramps up from the lit frontier

// Optional cap on how deep a breach/gate reveal penetrates a compound, in hex rings from the
// opening. `null` = uncapped, which is what shipped: Jackson was shown that the all-angles union is
// generous ("for a fairly open compound may be most of the interior") and accepted it. THIS IS THE
// KNOB if it plays too generously — set it to a number, nothing else changes.
export const BREACH_MAX_DEPTH = null;

// ── World precompute ─────────────────────────────────────────────────────────────────
// Built once per run from the base descriptors. `footprint` (worldgen.js) is the compound's hex
// set; its OUTLINE is the ring of footprint hexes touching the outside — which is exactly where the
// wall spans and their turrets sit. The outline belongs to BOTH regions: Jackson, "Wall turrets
// should be visible from inside or outside, right?" So an outside observer sees the wall (and its
// guns) while the interior stays dark, which is also what makes the fog read as a fortified
// perimeter rather than a shapeless blob.
export function buildFogWorld(bases = []) {
  const owner = new Map();      // hex key -> baseId, over the whole footprint
  const footprints = new Map(); // baseId -> Set(key)
  const interiors = new Map();  // baseId -> Set(key)  (footprint minus outline)
  const outlines = new Map();   // baseId -> Set(key)
  for (const base of bases) {
    const fp = new Set((base.footprint ?? []).map((h) => axialKey(h.q, h.r)));
    if (!fp.size) continue;
    footprints.set(base.id, fp);
    for (const k of fp) owner.set(k, base.id);
    const outline = new Set();
    for (const h of base.footprint ?? []) {
      if (neighbors(h.q, h.r).some((n) => !fp.has(axialKey(n.q, n.r)))) outline.add(axialKey(h.q, h.r));
    }
    outlines.set(base.id, outline);
    const inner = new Set();
    for (const k of fp) if (!outline.has(k)) inner.add(k);
    interiors.set(base.id, inner);
  }
  return { owner, footprints, interiors, outlines, bases };
}

// Which region key does this hex belong to? Any footprint hex (outline included — you can only
// stand on an outline hex by being inside the sealed ring) is the base's region; everything else is
// an open cell. Region keys are opaque strings, compared with `===` by the caller.
export function regionKeyAt(q, r, world) {
  const b = world?.owner?.get(axialKey(q, r));
  if (b != null) return `base:${b}`;
  return openCellKey(q, r);
}

export function openCellKey(q, r, size = OPEN_CELL_SIZE) {
  return `open:${Math.floor(q / size)},${Math.floor(r / size)}`;
}

// The centre hex of an open cell — what its reveal disc is drawn around.
export function openCellCenter(cellKey, size = OPEN_CELL_SIZE) {
  const [cq, cr] = cellKey.slice(5).split(',').map(Number);
  const half = Math.floor(size / 2);
  return { q: cq * size + half, r: cr * size + half };
}

// ── What a region reveals ────────────────────────────────────────────────────────────
// Called ONCE per threshold crossing. Two cases, and nothing in between:
//
//   • Inside a compound → the whole compound. You are in the yard; you see the yard. You do NOT
//     re-light the outside from in here — you already walked it, so it's remembered terrain, and
//     enemies out there are hidden, which is the "enemies still hide" half of the rule.
//   • Out in the open → a disc around the cell centre, MINUS every base INTERIOR (outlines stay, so
//     walls and wall turrets read). That exclusion is the whole "you can't see inside a compound
//     before you enter it" consequence Jackson was shown and accepted ("that's fine").
export function regionVisibleHexes(regionKey, world, opts = {}) {
  const { revealRadius = OPEN_REVEAL_RADIUS, cellSize = OPEN_CELL_SIZE } = opts;
  const out = new Set();
  if (regionKey.startsWith('base:')) {
    const fp = world?.footprints?.get(regionKey.slice(5));
    if (fp) for (const k of fp) out.add(k);
    return out;
  }
  const c = openCellCenter(regionKey, cellSize);
  for (const h of range(c, revealRadius)) {
    const k = axialKey(h.q, h.r);
    const b = world?.owner?.get(k);
    if (b != null && world.interiors.get(b)?.has(k)) continue;   // compound interiors stay dark
    out.add(k);
  }
  return out;
}

// ── Breach / open-gate reveal ────────────────────────────────────────────────────────
// Jackson, asked how a breach should behave: "How about a ray cast from all possible angles, not
// just the player angle" — the UNION over every exterior viewpoint of what is visible through the
// gap. That union has a cheap exact form: an exterior observer can stand anywhere, so a hex is in
// the union iff it has an unobstructed line to some point IN THE OPENING itself. So we only sample
// the opening, not the (infinite) set of viewpoints. Sampling the two endpoints and the midpoint of
// each open span is enough at hex granularity.
//
// Cost: (#open spans) x (footprint hexes) x (a wall-crossing test). Tens x tens. And it is computed
// ONCE, when a span falls or a gate changes state — never on a timer, never per frame.
//
// `openings` — [{ x0, y0, x1, y1 }] world-space segments for every breached span and open gate of
// this base. `segmentBlocked(x0,y0,x1,y1)` — the caller's live wall test (standing spans only).
// `terrainAt(q,r)` — for hard cover inside the yard (a bunker shadows the hexes behind it).
export function breachRevealHexes(baseId, world, openings, opts = {}) {
  const { segmentBlocked = null, terrainAt = () => undefined, maxDepth = BREACH_MAX_DEPTH } = opts;
  const out = new Set();
  const fp = world?.footprints?.get(baseId);
  if (!fp || !openings?.length) return out;
  const samples = [];
  for (const o of openings) {
    samples.push({ x: o.x0, y: o.y0, hex: null }, { x: o.x1, y: o.y1, hex: null },
      { x: (o.x0 + o.x1) / 2, y: (o.y0 + o.y1) / 2, hex: null });
  }
  for (const k of fp) {
    const [q, r] = k.split(',').map(Number);
    const p = hexToPixel(q, r);
    for (const s of samples) {
      if (maxDepth != null) {
        // Penetration cap, in hexes from the opening. Off by default (see BREACH_MAX_DEPTH).
        const gap = pixelToHex(s.x, s.y);
        if (distance(gap, { q, r }) > maxDepth) continue;
      }
      if (segmentBlocked && segmentBlocked(s.x, s.y, p.x, p.y)) continue;
      if (!lineClearThroughTerrain(s.x, s.y, p.x, p.y, terrainAt)) continue;
      out.add(k);
      break;
    }
  }
  return out;
}

// Straight pixel line vs. HARD terrain cover, sampled at half-hex steps. Endpoints are exempt, the
// same #72 own-hex rule `hexLineClear` honours, so a structure never shadows itself.
function lineClearThroughTerrain(x0, y0, x1, y1, terrainAt) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / 24));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const h = pixelToHex(x, y);
    if (coverBlocksForRay(terrainAt(h.q, h.r), false)) return false;
  }
  return true;
}

// ── Softened edges ───────────────────────────────────────────────────────────────────
// #306's overlay was a hard stencil at 0.8 alpha. This ramps instead: a BFS outward from the lit
// set assigns each fogged hex a depth, and alpha climbs with depth over FOG_SOFT_STEPS rings. The
// result is a gradient a couple of hexes wide at every frontier, which is what "not quite so stark"
// asks for, and it is computed on the same infrequent cadence as the region set itself.
export function softFogDepths(visible, steps = FOG_SOFT_STEPS) {
  const depth = new Map();
  let frontier = [];
  for (const k of visible) {
    const [q, r] = k.split(',').map(Number);
    frontier.push({ q, r });
  }
  for (let d = 1; d <= steps; d++) {
    const next = [];
    for (const h of frontier) {
      for (const n of neighbors(h.q, h.r)) {
        const nk = axialKey(n.q, n.r);
        if (visible.has(nk) || depth.has(nk)) continue;
        depth.set(nk, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return depth;
}

// The alpha for one hex. Order matters: currently lit beats remembered beats never-seen, and the
// soft ramp only ever LIGHTENS (Math.min), so a hex near the frontier can't come out darker than
// its own tier.
export function fogAlphaFor(key, { visible, known, depths, steps = FOG_SOFT_STEPS } = {}) {
  if (visible?.has(key)) return 0;
  const ramp = depths?.has(key) ? FOG_ALPHA * (depths.get(key) / steps) : FOG_ALPHA;
  const base = known?.has(key) ? KNOWN_ALPHA : FOG_ALPHA;
  return Math.min(base, ramp);
}

// ── Entity visibility ────────────────────────────────────────────────────────────────
// Terrain persists for the run; ENEMIES DO NOT. Jackson: "Yes, but enemies still hide." So an
// enemy is drawn only when one of these holds RIGHT NOW:
//
//   1. It is AIRBORNE. "Hides enemies too except for airborn enemies that have launched into the
//      air." This is also why #327's z-order (flyers above the dim layer) stops being a wart and
//      becomes the intended rule.
//   2. It is a WALL TURRET — it sits ON the boundary, in both regions at once, per the outline rule
//      above.
//   3. Its hex is in the currently-lit region set (incl. anything a breach/open gate reveals).
//   4. SYMMETRY: it is awake and has a clear firing lane to the player. Jackson: "but if they can
//      shoot me, they can see me and I can see them, right?" Since #316 every unit needs LOS before
//      it opens fire, so `losClear && awake` is exactly "could shoot me" — fog conceals BEFORE an
//      engagement and never during it. Per-enemy, so it costs nothing.
export function enemyVisibleInFog(enemy, { visible, hexKeyOf, losClear = false, awake = false } = {}) {
  if (!enemy) return false;
  if (enemy.flying && enemy.airborne !== false) return true;       // 1
  if (enemy.spanKey != null) return true;                          // 2
  if (!visible) return true;                                       // no fog computed yet ⇒ no gate
  if (visible.has(hexKeyOf(enemy.x, enemy.y))) return true;        // 3
  return !!(losClear && awake);                                    // 4
}
