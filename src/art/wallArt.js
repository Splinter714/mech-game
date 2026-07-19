// #288 (rebuilt): drawing the base approach walls — a THICKENED BOUNDARY LINE straddling the hex
// edges, not a hex texture. Every other piece of world art in the game is a per-hex generated
// texture (hexArt.js) stamped on a tile; a wall owns no tile, so it can't be one. It's stroked
// directly as vector geometry onto a single Graphics object instead, which also means a span's
// damage state is a redraw rather than a texture swap.
//
// Kept here in src/art/ (rather than inline in the scene) alongside the rest of the procedural art,
// and written against the minimal Graphics surface (`clear/fillStyle/fillPoints/fillCircle`) so it
// can be exercised with a plain recording stub in tests without Phaser.
import { WALL_THICKNESS_PX, spanTurretMount } from '../data/wallEdges.js';

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
const GATE_FIELD = 0xffc65a;    // the barrier curtain across an OPEN gate
const GATE_FRAME = 0x6a5a3a;    // the heavy jamb posts a gate hangs from

// #309: the interpolated position of a gate's leaves, 0 = fully shut, 1 = fully open. The scene
// passes the gate's own live `openFrac` on the record; a gate with no such field is treated as
// shut, which is what every non-gate span and every unwired test stub gets.
function openFracOf(e) {
  return Math.max(0, Math.min(1, e.openFrac ?? (e.open ? 1 : 0)));
}

// Draw one gate span. THE LEGIBILITY PROBLEM this solves: #309 requires the gate to keep blocking
// the PLAYER even while it stands open, and "a visible opening my mech refuses to drive through"
// is exactly the shape of a collision bug. The answer is to make the thing that stops him a
// visible object in its own right rather than an invisible rule:
//
//   - The two LEAVES slide apart into their jamb posts, so the doors are unmistakably open and the
//     opening is a real opening — you can see through it, shoot through it, and units walk out of
//     it (world.js routes sight and fire through an open gate for exactly this reason).
//   - Across that opening sits a BARRIER FIELD — a bright amber curtain, pulsing, drawn only while
//     the gate is open and only across the span between the retracted leaves. It is the widest,
//     brightest thing on the wall line when lit. It reads as an active emitter, and an active
//     emitter that stops vehicles is a familiar idea that needs no explanation.
//   - The player driving into it gets a spark ripple off the field (bases.js `_gateFieldFx`),
//     which is the confirming beat: he is not stuck on nothing, he is pushing on something that
//     pushes back. A unit coming the other way passes through it untouched, which is the visual
//     statement that the field is THEIRS and keyed to them.
//
// So the fiction is complete and self-consistent: the gate is open, and the base's own screen is
// what he cannot cross. Nothing about it is a silent rule.
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
  // The barrier field first, so the leaves sit on top of it where they overlap.
  if (f > 0.02) {
    // Pulse: a slow breathing brightness, so the field reads as powered rather than as a static
    // painted stripe. Deterministic in `timeMs` — no per-frame random, nothing to desync.
    const pulse = 0.5 + 0.5 * Math.sin(timeMs / 190);
    const gapA = { x: e.x0 + ux * leaf, y: e.y0 + uy * leaf };
    const gapB = { x: e.x1 - ux * leaf, y: e.y1 - uy * leaf };
    // Wider than the wall itself — the field bulges out of the doorway, which is what makes it
    // read as a projected screen rather than as a thin painted line in the gap.
    g.fillStyle(GATE_FIELD, (0.16 + 0.12 * pulse) * f);
    g.fillPoints(band(gapA.x, gapA.y, gapB.x, gapB.y, hw * 1.5), true);
    g.fillStyle(GATE_FIELD, (0.34 + 0.26 * pulse) * f);
    g.fillPoints(band(gapA.x, gapA.y, gapB.x, gapB.y, hw * 0.8), true);
    // Emitter nodes at the field's two anchor points, brightest of all — where the power comes from.
    g.fillStyle(GATE_FIELD, 0.6 + 0.4 * pulse);
    g.fillCircle(gapA.x, gapA.y, hw * 0.42);
    g.fillCircle(gapB.x, gapB.y, hw * 0.42);
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

// #310 TURRET-SPAN PALETTE + PLINTH. A turret span must read as reinforced even with the gun
// itself unrendered, for two reasons. First, the gun is a separate unit drawn on the units layer
// and it DIES — once the player kills the gun but not the span, a plain span would be all that's
// left, erasing any evidence there was ever an emplacement there. Second, the span's existing
// damage art (the plate face narrowing as HP drops) is drawn along the span's centreline, and a
// gun sitting on top of it needs something to sit ON or it reads as hovering.
//
// So a turret span gets a PLINTH: a widened armoured block at its midpoint, straddling the wall
// line, which is what the gun's pintle mount (art/vehicles/wallTurret.js) visually bolts through.
// It is drawn OUTBOARD-biased to meet the gun where it actually sits (data/wallEdges.js
// TURRET_MOUNT_OFFSET_PX seats the unit clear of the wall's outer face), so mount and plinth line
// up rather than the gun floating beside its own base.
const TURRET_PLINTH = 0x3d444e;      // a heavier, lighter-toned block than the plate face
const TURRET_PLINTH_LIT = 0x59616e;
const TURRET_MARK = 0x5ac8e0;        // cold cyan, matching the Wall Lance's own themeColor

// Draw the parapet plinth on one turret span. The outboard direction is taken from
// `spanTurretMount` — the SAME function the scene uses to seat the actual gun — rather than being
// recomputed here, so the block and the gun can never disagree about which way is out. A record
// with no `a`/`b` hexes (a bare test stub) degrades to an unbiased block on the centreline.
function drawTurretPlinth(g, e, hw) {
  const mx = (e.x0 + e.x1) / 2, my = (e.y0 + e.y1) / 2;
  const mount = spanTurretMount(e);
  const on = mount ? Math.hypot(mount.x - mx, mount.y - my) || 1 : 1;
  const ox = mount ? (mount.x - mx) / on : 0;
  const oy = mount ? (mount.y - my) / on : 0;
  const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
  // The block spans the middle ~44% of the span's length and is ~2.2x the wall's thickness,
  // centred a little outboard. Wider than the wall on BOTH sides so it reads as a bastion
  // thickening the line, not as a lump stuck to one face.
  const halfLen = len * 0.22;
  const cx = mx + ox * hw * 0.5, cy = my + oy * hw * 0.5;
  const a = { x: cx - ux * halfLen, y: cy - uy * halfLen };
  const b = { x: cx + ux * halfLen, y: cy + uy * halfLen };
  g.fillStyle(0x000000, 0.34);
  g.fillPoints(band(a.x, a.y + 3, b.x, b.y + 3, hw * 2.2), true);
  g.fillStyle(WALL_DARK, 1);
  g.fillPoints(band(a.x, a.y, b.x, b.y, hw * 2.2), true);
  g.fillStyle(TURRET_PLINTH, 1);
  g.fillPoints(band(a.x, a.y, b.x, b.y, hw * (0.9 + 0.8 * frac)), true);
  g.fillStyle(TURRET_PLINTH_LIT, 0.3 + 0.5 * frac);
  g.fillPoints(band(a.x, a.y - 1.5, b.x, b.y - 1.5, hw * 0.5 * frac), true);
  // Corner posts at the plinth's two ends, so it caps cleanly into the plain wall either side.
  g.fillStyle(WALL_POST, 1);
  g.fillCircle(a.x, a.y, hw * 1.05);
  g.fillCircle(b.x, b.y, hw * 1.05);
  // A cyan emplacement mark at the centre — replacing the plain span's amber hazard pip, so the
  // player can pick out which spans are armed from across the field before anything opens fire.
  g.fillStyle(TURRET_MARK, 0.5 + 0.45 * frac);
  g.fillCircle(cx, cy, hw * 0.44);
}

export function drawWallEdges(g, edges, thickness = WALL_THICKNESS_PX, timeMs = 0) {
  g.clear();
  const hw = thickness / 2;
  // #309: gates are drawn by their own routine below — they have moving parts and a barrier field,
  // none of which the plain-span passes know how to express.
  const standing = edges.filter((e) => !e.destroyed);
  const gates = standing.filter((e) => e.role === 'gate');
  // #310: a turret span IS a plain span — it draws through every normal pass below and only gains
  // a plinth on top, which is exactly the point: it is a wall that happens to carry a gun, not a
  // different structure. (Contrast a gate, which has moving parts and must draw itself entirely.)
  const live = standing.filter((e) => e.role !== 'gate');
  const turretSpans = standing.filter((e) => e.role === 'turret');
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
  // Pass 5: an amber hazard pip at each standing span's midpoint — small, but it's what makes the
  // line read from a distance as a defended gate rather than a rock formation.
  for (const e of live) {
    const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    g.fillStyle(HAZARD, 0.35 + 0.5 * frac);
    g.fillCircle((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, hw * 0.3);
  }
  // Pass 6 (#310): the turret plinths, over the plain wall passes they sit on (and over the pass-5
  // hazard pip, which the emplacement mark replaces).
  for (const e of turretSpans) drawTurretPlinth(g, e, hw);
  // Pass 7 (#309): the gates, last, so a lit barrier field reads over the wall line beside it.
  for (const e of gates) drawGate(g, e, hw, timeMs);
}
