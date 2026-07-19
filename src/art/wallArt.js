// #288 (rebuilt): drawing the base approach walls — a THICKENED BOUNDARY LINE straddling the hex
// edges, not a hex texture. Every other piece of world art in the game is a per-hex generated
// texture (hexArt.js) stamped on a tile; a wall owns no tile, so it can't be one. It's stroked
// directly as vector geometry onto a single Graphics object instead, which also means a span's
// damage state is a redraw rather than a texture swap.
//
// Kept here in src/art/ (rather than inline in the scene) alongside the rest of the procedural art,
// and written against the minimal Graphics surface (`clear/fillStyle/fillPoints/fillCircle`) so it
// can be exercised with a plain recording stub in tests without Phaser.
import { WALL_THICKNESS_PX } from '../data/wallEdges.js';

// Steel-plate palette — deliberately the same dark, cold, man-made family the removed
// `wallSegment` tile used (0x34383e/0x212429), so the wall still reads as base infrastructure and
// not as terrain, just drawn as a line now.
const WALL_DARK = 0x212429;    // shadowed base / outer edge
const WALL_BODY = 0x34383e;    // main plate face
const WALL_LIT = 0x4a505a;     // top-lit highlight strip along the plate's crest
const WALL_POST = 0x3f454e;    // the pillar at each junction between spans
const HAZARD = 0xc99a2c;       // amber hazard flash, so the gate reads as "defended", not scenery

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
const GATE_LEAF = 0x4b4030;     // brass-toned door leaf: warm, machined, obviously a moving part
const GATE_LEAF_LIT = 0x8a7645;
const GATE_GLOW = 0xffc65a;     // warm threshold light spilling from an OPEN gate's mouth
const GATE_FRAME = 0x6a5a3a;    // the heavy jamb posts a gate hangs from

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
// In its place the open mouth gets a THRESHOLD GLOW — a soft warm spill of light on the ground
// between the retracted leaves, dim and wide rather than bright and flat. It is an invitation, not
// a barrier, and that is precisely the new meaning: this is a way in, for anyone who can reach it
// before it shuts. The leaves themselves do the rest of the work — they slide apart into their jamb
// posts, so the opening is unmistakably an opening you can see through, shoot through, and drive
// through.
function drawGate(g, e, hw, timeMs) {
  const f = openFracOf(e);
  const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
  // Each leaf spans from its own end toward the centre. Shut: they meet exactly at the midpoint
  // (0.5 each) and the span is a solid door. Open: they retract to a stub tucked against the jamb.
  const leaf = len * (0.5 - 0.38 * f);
  const leaves = [
    [e.x0, e.y0, e.x0 + ux * leaf, e.y0 + uy * leaf],
    [e.x1, e.y1, e.x1 - ux * leaf, e.y1 - uy * leaf],
  ];
  // The threshold glow first, so the leaves sit on top of it where they overlap. Two wide, faint
  // bands rather than one bright one: the light falls off away from the opening, which reads as
  // spill rather than as a painted stripe, and at these alphas it can never be mistaken for a
  // solid object in the gap. No pulse — a steady light is a doorway, a pulsing one is a hazard.
  if (f > 0.02) {
    const gapA = { x: e.x0 + ux * leaf, y: e.y0 + uy * leaf };
    const gapB = { x: e.x1 - ux * leaf, y: e.y1 - uy * leaf };
    g.fillStyle(GATE_GLOW, 0.10 * f);
    g.fillPoints(band(gapA.x, gapA.y, gapB.x, gapB.y, hw * 1.9), true);
    g.fillStyle(GATE_GLOW, 0.16 * f);
    g.fillPoints(band(gapA.x, gapA.y, gapB.x, gapB.y, hw * 0.9), true);
    // A small lamp at each jamb where the leaf has retracted to — the doorway's own edge lighting,
    // and the cue that picks an open mouth out at distance now that the curtain is gone.
    g.fillStyle(GATE_GLOW, 0.55 * f);
    g.fillCircle(gapA.x, gapA.y, hw * 0.3);
    g.fillCircle(gapB.x, gapB.y, hw * 0.3);
  }
  // The leaves.
  for (const [ax, ay, bx, by] of leaves) {
    g.fillStyle(0x000000, 0.3);
    g.fillPoints(band(ax, ay + 3, bx, by + 3, hw), true);
    g.fillStyle(WALL_DARK, 1);
    g.fillPoints(band(ax, ay, bx, by, hw), true);
    g.fillStyle(GATE_LEAF, 1);
    g.fillPoints(band(ax, ay, bx, by, hw * (0.36 + 0.44 * frac)), true);
    g.fillStyle(GATE_LEAF_LIT, 0.3 + 0.6 * frac);
    g.fillPoints(band(ax, ay - 1, bx, by - 1, hw * 0.24 * frac), true);
  }
  // Heavy jamb posts — visibly chunkier than a plain span's junction pillar, so a shut gate is
  // still identifiable as a gate from across the field.
  g.fillStyle(GATE_FRAME, 1);
  g.fillCircle(e.x0, e.y0, hw * 1.25);
  g.fillCircle(e.x1, e.y1, hw * 1.25);
  // Amber warning pip on each leaf (rather than one at the midpoint, which the opening would
  // swallow) — the paired lamps are the "this is a door" tell while it is shut.
  g.fillStyle(HAZARD, 0.45 + 0.45 * frac);
  for (const [ax, ay, bx, by] of leaves) g.fillCircle((ax + bx) / 2, (ay + by) / 2, hw * 0.3);
}

// #310 TURRET-SPAN MARK. The owner (playtest 2026-07-19): wall turrets "don't need a whole
// separate wall-type-piece visually, they can just be popped on the main wall section." So the
// PLINTH this file used to draw — a widened armoured block at the span's midpoint, ~2.2x the wall's
// thickness, with its own palette and corner posts — is gone. A turret span is now geometrically
// identical to every other span: the gun is simply popped on top of the ordinary wall.
//
// What the plinth was for, and what replaces it: a turret span had to stay readable after its gun
// died, since the gun is a separate unit on the units layer and a plain span would erase any
// evidence an emplacement was ever there. That is kept, but as a PALETTE/DETAIL touch instead of
// geometry — the span's normal amber hazard pip is swapped for a cold cyan emplacement mark (the
// Wall Lance's own themeColor), same size and same position as the pip it replaces. Armed spans
// are still pickable out of the line from across the field, and a span whose gun is dead still
// carries the mark, with no bespoke shape anywhere.
const TURRET_MARK = 0x5ac8e0;        // cold cyan, matching the Wall Lance's own themeColor

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
  // Pass 5: a pip at each standing span's midpoint — small, but it's what makes the line read from
  // a distance as a defended perimeter rather than a rock formation. #310: a TURRET span's pip is
  // cold cyan instead of amber (and marginally larger), which is the entire visual difference
  // between an armed span and a plain one — no separate geometry, per the owner's 2026-07-19 call.
  for (const e of live) {
    const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    const armed = e.role === 'turret';
    g.fillStyle(armed ? TURRET_MARK : HAZARD, armed ? 0.5 + 0.45 * frac : 0.35 + 0.5 * frac);
    g.fillCircle((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, hw * (armed ? 0.38 : 0.3));
  }
  // Pass 6 (#309): the gates, last, so an open mouth's threshold glow reads over the wall line
  // beside it rather than being painted under the neighbouring spans.
  for (const e of gates) drawGate(g, e, hw, timeMs);
}
