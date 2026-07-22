// #288 (rebuilt): drawing the base approach walls — a THICKENED BOUNDARY LINE straddling the hex
// edges, not a hex texture. Every other piece of world art in the game is a per-hex generated
// texture (hexArt.js) stamped on a tile; a wall owns no tile, so it can't be one. It's stroked
// directly as vector geometry onto a single Graphics object instead, which also means a span's
// damage state is a redraw rather than a texture swap.
//
// Kept here in src/art/ (rather than inline in the scene) alongside the rest of the procedural art,
// and written against the minimal Graphics surface (`clear/fillStyle/fillPoints/fillCircle`) so it
// can be exercised with a plain recording stub in tests without Phaser.
import { WALL_THICKNESS_PX, GATE_RETRACT_FACTOR } from '../data/wallEdges.js';

// Steel-plate palette — deliberately the same dark, cold, man-made family the removed
// `wallSegment` tile used (0x34383e/0x212429), so the wall still reads as base infrastructure and
// not as terrain, just drawn as a line now.
const WALL_DARK = 0x212429;    // shadowed base / outer edge
const WALL_BODY = 0x34383e;    // main plate face
const WALL_LIT = 0x4a505a;     // top-lit highlight strip along the plate's crest
const WALL_POST = 0x3f454e;    // the pillar at each junction between spans

// A quad of half-width `hw` centred on the segment (x0,y0)→(x1,y1), as fillPoints-ready points.
function band(x0, y0, x1, y1, hw) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * hw, ny = dx / len * hw;
  return [
    { x: x0 + nx, y: y0 + ny }, { x: x1 + nx, y: y1 + ny },
    { x: x1 - nx, y: y1 - ny }, { x: x0 - nx, y: y0 - ny },
  ];
}

// Draw every STANDING span of a wall-edge set onto `g` (which is cleared first). Destroyed spans
// draw nothing at all — that's the breach: a literal hole in the line you can see through and
// drive through, with the rest of the wall still standing on either side.
//
// A damaged-but-standing span visibly degrades before it falls (the plate face narrows and its
// highlight fades as HP drops), so a player can tell which span they've been chewing on and how
// close it is to going down without reading a health bar.
// #309 GATE PALETTE. A gate must read as a different KIND of thing from the blank spans either
// side of it even at a glance and even while shut — otherwise the moment it opens is just a span
// vanishing, which is indistinguishable from the player having breached it.
// #427 (Jackson 2026-07-22): all warm brass/gold recolored to NEUTRAL cool steel-greys matching the
// wall palette (WALL_DARK/WALL_BODY/WALL_LIT/WALL_POST) — no yellow/amber anywhere on a gate. A gate
// still reads as a distinct machined moving part by its SHAPE (parting leaves, heavy jamb posts,
// squared meeting post), not by colour: its leaf sits a touch lighter/bluer than a plain wall's face
// so a shut gate is still legible against the blank spans beside it, just in steel not brass.
const GATE_LEAF = 0x454b55;     // cool steel door leaf: a touch lighter than a plain wall's plate face
const GATE_LEAF_LIT = 0x5b626d; // cool grey top-lit highlight (a shade brighter than WALL_LIT)
const GATE_FRAME = 0x353a42;    // the heavy jamb posts a gate hangs from — neutral grey, heavier/darker than a plain post
// #427 removed the open-gate TARGET PIP (was #412): an open gate is now solid to fire everywhere
// along its span (wallEdges.js `blocksShot`), so there is nothing to single out to "shoot here" —
// the player just aims at the door. The two parted leaves and their stubs ARE the target now.

// #309: the interpolated position of a gate's leaves, 0 = fully shut, 1 = fully open. The scene
// passes the gate's own live `openFrac` on the record; a gate with no such field is treated as
// shut, which is what every non-gate span and every unwired test stub gets.
function openFracOf(e) {
  return Math.max(0, Math.min(1, e.openFrac ?? (e.open ? 1 : 0)));
}

// Draw one gate span.
//
// #309's first pass had a BARRIER FIELD here — a bright amber curtain drawn across the open mouth,
// pulsing, the widest thing on the wall line. It existed for exactly one reason: the gate used to
// stay impassable to the PLAYER even while standing open, and "a visible opening my mech refuses to
// drive through" is the shape of a collision bug, so the thing stopping him had to be a visible
// object rather than an invisible rule.
//
// The playtest removed that rule ("player should be able to pass through the gate when it's open,
// it just shouldn't open FOR the player"), which removed the field's entire job. Keeping it would
// have been worse than useless: a big glowing screen across a doorway that everything now drives
// straight through reads as broken art, or as a hazard that has stopped working. So it is gone.
//
// #427 (Jackson 2026-07-21): the THRESHOLD GLOW that briefly replaced it — a soft warm amber spill
// on the ground between the retracted leaves — is ALSO gone ("the yellow is weird and
// unnecessary"). An open gate now reads purely from its two parted leaves and their posts: the
// opening is simply the gap between them, no coloured light needed to sell it.
function drawGate(g, e, hw, timeMs) {
  const f = openFracOf(e);
  const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
  // #427: ONE leaf per edge — a gate is TWO ADJACENT edges, each drawn here, and the double-door
  // look emerges from the two neighbouring leaves, NOT from one edge split into halves. The leaf
  // hangs from its outer POST (its `gateHingeEnd` endpoint) and its free (meeting) end retracts
  // TOWARD that post as the gate opens: full length shut, a short stub tucked into the jamb open.
  // Its partner leaf on the adjacent gate edge retracts toward ITS own post in the OPPOSITE
  // direction, so the two parting leaves leave a central passage at the vertex they share. The
  // whole leaf stays solid to fire open or shut (wallEdges.js `blocksShot`), so the retracted stub
  // is a real, targetable segment — not decoration.
  const hinge = (e.gateHingeEnd ?? 0) === 1
    ? { px: e.x1, py: e.y1, fx: e.x0, fy: e.y0 }
    : { px: e.x0, py: e.y0, fx: e.x1, fy: e.y1 };
  const dx = hinge.fx - hinge.px, dy = hinge.fy - hinge.py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // #427: the retract factor is shared with the shot-collision path (wallEdges.js `spanFireSegment`)
  // so the solid door material that's DRAWN is exactly what's solid to FIRE — no drift between the two.
  const leafLen = len * (1 - GATE_RETRACT_FACTOR * f);
  const ax = hinge.px, ay = hinge.py;                     // the anchored post end
  const bx = hinge.px + ux * leafLen, by = hinge.py + uy * leafLen;   // the free (retracting) lip
  // The leaf.
  g.fillStyle(0x000000, 0.3);
  g.fillPoints(band(ax, ay + 3, bx, by + 3, hw), true);
  g.fillStyle(WALL_DARK, 1);
  g.fillPoints(band(ax, ay, bx, by, hw), true);
  g.fillStyle(GATE_LEAF, 1);
  g.fillPoints(band(ax, ay, bx, by, hw * (0.36 + 0.44 * frac)), true);
  g.fillStyle(GATE_LEAF_LIT, 0.3 + 0.6 * frac);
  g.fillPoints(band(ax, ay - 1, bx, by - 1, hw * 0.24 * frac), true);
  // Heavy jamb post at the hinge end — visibly chunkier than a plain span's junction pillar, so a
  // shut gate is still identifiable as a gate from across the field.
  g.fillStyle(GATE_FRAME, 1);
  g.fillCircle(ax, ay, hw * 1.25);
  // #427 (Jackson 2026-07-22): the MEETING-POINT POST, now SQUARED. Each leaf caps its inner
  // (retracting) lip with a crisp rectangular pillar aligned to the wall line, so when the two leaves
  // are SHUT their caps coincide at the shared hex corner where the two leaves meet and read as one
  // clean, angular wall-junction post — and when OPEN each leaf carries its own square at its
  // retracted lip. (With the chord re-seat gone the meeting point is that natural hex corner rather
  // than a chord midpoint, but the cap logic is unchanged — it just reads each leaf's free lip.) This replaces the
  // earlier `fillCircle` cap: two coincident circular caps merged into a ROUNDED blob at the midpoint
  // that Jackson said "feels like a weird style, make it not rounded." A square of the same footprint
  // (side ≈ the old circle's diameter, hw * 1.84) drawn as a short band along the leaf axis reads as a
  // squared post matching a plain wall's angular junction rather than a soft dot.
  const cap = hw * 0.92;
  g.fillStyle(WALL_POST, 1);
  g.fillPoints(band(bx - ux * cap, by - uy * cap, bx + ux * cap, by + uy * cap, cap), true);
}

// #310/#413 TURRET-SPAN MARK. A turret span used to draw a widened armoured PLINTH; #310 dropped
// that so a turret span is geometrically identical to every other span (the gun is simply popped on
// top of the ordinary wall), and marked the difference only with a cold-cyan midpoint pip. #413
// removed the midpoint pips entirely, so an armed span now carries no wall-level mark at all — it is
// identified purely by the gun unit sitting on top of it.

export function drawWallEdges(g, edges, thickness = WALL_THICKNESS_PX, timeMs = 0) {
  g.clear();
  const hw = thickness / 2;
  // #309: gates are drawn by their own routine below — they have moving parts and a threshold
  // glow, neither of which the plain-span passes know how to express.
  const standing = edges.filter((e) => !e.destroyed);
  const gates = standing.filter((e) => e.role === 'gate');
  // #310: a turret span IS a plain span — it draws through every normal pass below and differs
  // only in the colour of its midpoint pip, which is exactly the point: it is a wall that happens
  // to carry a gun, not a different structure. (Contrast a gate, which has moving parts and must
  // draw itself entirely.)
  const live = standing.filter((e) => e.role !== 'gate');
  // Pass 1: a soft drop shadow under the whole line, so it reads as standing UP off the ground
  // rather than being painted on it.
  g.fillStyle(0x000000, 0.3);
  for (const e of live) g.fillPoints(band(e.x0, e.y0 + 3, e.x1, e.y1 + 3, hw), true);
  // Pass 2: the dark outer plate at full thickness.
  g.fillStyle(WALL_DARK, 1);
  for (const e of live) g.fillPoints(band(e.x0, e.y0, e.x1, e.y1, hw), true);
  // Pass 3: the plate face, inset — and narrowed by damage, so a battered span looks eaten away.
  for (const e of live) {
    const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    g.fillStyle(WALL_BODY, 1);
    g.fillPoints(band(e.x0, e.y0, e.x1, e.y1, hw * (0.36 + 0.44 * frac)), true);
    g.fillStyle(WALL_LIT, 0.25 + 0.55 * frac);
    g.fillPoints(band(e.x0, e.y0 - 1, e.x1, e.y1 - 1, hw * 0.22 * frac), true);
  }
  // Pass 4: a pillar at every junction where two standing spans meet, so the jagged chain of hex
  // edges reads as ONE continuous barrier rather than a row of disconnected sticks — and so the
  // outer corners are visually capped where a span dead-ends into a breach or the corridor edge.
  g.fillStyle(WALL_POST, 1);
  for (const e of live) {
    g.fillCircle(e.x0, e.y0, hw * 0.92);
    g.fillCircle(e.x1, e.y1, hw * 0.92);
  }
  // #413: the per-span midpoint pip is gone — the owner wanted the small dot marks off the tops of
  // the wall segments. The wall now reads from its body/plate/shadow and junction pillars alone.
  // Pass 6 (#309): the gates, last, so an open mouth's threshold glow reads over the wall line
  // beside it rather than being painted under the neighbouring spans.
  for (const e of gates) drawGate(g, e, hw, timeMs);
}
