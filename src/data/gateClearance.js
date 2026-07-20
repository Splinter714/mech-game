// GATE OCCUPANCY (#369) — "is anything standing in this gate's mouth", and the last-resort nudge
// that gets a body out of one if it ever ends up inside a shut door anyway.
//
// WHY THIS EXISTS
// ---------------
// Playtest 2026-07-20, Jackson: "I just got stuck in a gate when it closed while I was in the
// middle." The doors write their own geometry — `_updateGates` flips the span back to solid the
// instant it enters GATE_CLOSING (gateCycle.js: there is deliberately no passable half-open frame)
// — and nothing ever asked whether something was standing in the opening.
//
// The issue offered two answers: push the trapped body clear, or refuse to close on it like a lift
// door. Jackson picked the second outright — "ooo, yeah let's do 'not closing while occupied', I
// actually like that a lot" — so THE PRIMARY BEHAVIOUR IS ELEVATOR DOORS, and it lives in
// `gateCycle.js` as an `occupied` input to `tickGate`. This module is the geometry that input is
// computed from, plus the fallback below.
//
// The known cost, which he accepted in choosing it: a player can park in a mouth and hold a gate
// open indefinitely, which cuts against #309's demand-driven just-in-time design. Deliberately NOT
// defended against — no anti-exploit timer, no force-close. The one genuinely broken case would be
// a gate held open forever by something that cannot leave, and that is closed off at the source:
// the caller feeds only LIVE, non-flying bodies, so a wreck never counts as an occupant.
//
// OCCUPANCY USES THE SAME GEOMETRY AS EVERYTHING ELSE
// ---------------------------------------------------
// A body is "in the mouth" exactly when the movement rule would call it inside the plate: its own
// wall collide radius (#320) against `spanCollideSegment`, which is the capsule `wallEdgeAt` tests.
// Not a bespoke box or a midpoint-distance check — so a gate holds open for precisely the bodies
// that closing it would have trapped, no more and no less.
//
// THE FALLBACK NUDGE
// ------------------
// Elevator doors make the trap unreachable through the front door, but not unreachable full stop: a
// body can be PLACED inside a shut span by something that never consults the gate (a respawn drop,
// a carrier drop, a shove). So `nudgeFromGateMouth` stays, demoted from the headline fix to a
// belt-and-braces sweep run when a gate finishes shutting. It is the same shape as the three other
// "push a body out of somewhere it should not be" rules the project already has — #348's leash
// clamp, #361's crowd separation, and `playerCollision.js` / `groundSeparation.js` — and like them
// it commits every push through the caller's own swept collision test, so it can never shove a body
// INTO geometry. No new physics: displacement only.
//
// The push goes along the span's NORMAL, to whichever side of the door line the body is already
// nearer. Chosen over "push along the last movement direction" because the nearer side is the
// shortest way out, is symmetric for attackers and defenders, and is a pure function of position —
// no velocity history, no per-body state, testable from geometry alone.

import { pointSegmentDistance } from './hexEdges.js';
import { spanCollideSegment, WALL_THICKNESS_PX } from './wallEdges.js';

// How far PAST clear the nudge puts a body. Without it the body lands exactly tangent to the
// plate's collision band, where the very next frame's floating-point wobble can read as inside
// again. Small enough to be invisible at a 48px hex edge, large enough to survive a frame of drift.
export const GATE_NUDGE_MARGIN_PX = 2;

// Is this body inside the span's plate — i.e. would closing this gate trap it?
//
// `radius` is the body's own WALL collide radius, the same number its locomotion passes to
// `_blockedAlongSegment` (scene: `wallCollideRadius` / `PLAYER_WALL_COLLIDE_RADIUS`). Measured
// against `spanCollideSegment`, the exact capsule `wallEdgeAt` uses at that radius, so this agrees
// with the movement rule about what "inside the plate" means — including the shortened-ends chamfer
// that keeps a breach and an open mouth drivable. A body past the ENDS of the span is beside the
// door, not in it, and correctly answers false.
export function bodyInGateMouth(body, edge, radius = 0) {
  if (!body || !edge) return false;
  const r = Math.max(0, radius);
  const s = spanCollideSegment(edge, r);
  if (!(Math.hypot(edge.x1 - edge.x0, edge.y1 - edge.y0) > 0)) return false;
  return pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, body.x, body.y) <= WALL_THICKNESS_PX / 2 + r;
}

// Is ANY of these bodies in the mouth? This is the `occupied` input `tickGate` takes (#369): while
// it is true the doors will not close, and a gate already closing reverses and re-opens.
//
// The caller passes only bodies that can actually be trapped and can actually leave — live,
// non-flying players and ground units. A wreck must never be in this list, or its gate would be
// held open for the rest of the sortie. Short-circuits on the first hit; a gate only needs to know
// THAT it is occupied, never by whom.
export function gateMouthOccupied(bodies, edge, radiusOf) {
  const list = bodies ?? [];
  if (!edge || list.length === 0) return false;
  for (const b of list) {
    if (b && bodyInGateMouth(b, edge, radiusOf?.(b) ?? 0)) return true;
  }
  return false;
}

// Push every body out of a gate's mouth. The FALLBACK path (see the header) — with elevator doors
// in place a gate does not close on an occupant, so this only ever fires on a body that was put
// inside a shut span by something that never asked the gate.
//
// `bodies`  — the live bodies to consider: BOTH players and ground enemies (a trapped tank is the
//             same bug — #361 fixed the adjacent one). Mutated in place, like every other per-frame
//             movement step in the arena. Flyers must be filtered out by the caller: they pass over
//             walls and were never in the mouth.
// `edge`    — the gate span, as `{ x0, y0, x1, y1 }`. Pure geometry; this module knows nothing
//             about the gate's phase, and the caller is responsible for only calling it on the tick
//             a gate commits to closing.
// `radiusOf(body)` — the body's own WALL collide radius, the same one its locomotion passes to
//             `_blockedAlongSegment` (scene: `wallCollideRadius` / `PLAYER_WALL_COLLIDE_RADIUS`).
//             Using the same radius is what makes "clear of the plate" mean the same thing here as
//             it does to the movement integrator.
// `canMove(body, x, y)` — optional. Asked before any push is committed, so the nudge can never
//             place a body inside a wall. A body whose nearer side is blocked is tried on the FAR
//             side before being given up on, which is the one fallback that matters at a gate: the
//             mouth's two sides are the inside and the outside of a compound, and if a unit is
//             wedged against something on the near side, through the door is still a real way out.
//
// Returns the number of bodies actually displaced, which is all a caller or test needs.
export function nudgeFromGateMouth(bodies, edge, { radiusOf, canMove = null, margin = GATE_NUDGE_MARGIN_PX } = {}) {
  const list = bodies ?? [];
  if (!edge || list.length === 0) return 0;
  const dx = edge.x1 - edge.x0, dy = edge.y1 - edge.y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return 0;
  // The door line's unit normal. Sign is arbitrary and fixed by the span's own vertex order, so the
  // "nearer side" decision below is deterministic for a given map — the same body in the same spot
  // always goes the same way, on every machine.
  const nx = -dy / len, ny = dx / len;

  let moved = 0;
  for (const b of list) {
    if (!b) continue;
    const r = Math.max(0, radiusOf?.(b) ?? 0);
    const half = WALL_THICKNESS_PX / 2 + r;
    // Trapped? The same occupancy test `gateMouthOccupied` asks, so the thing that decides a gate
    // will not close and the thing that decides a body needs pushing can never disagree.
    if (!bodyInGateMouth(b, edge, r)) continue;

    // How far the body sits off the door LINE, signed. Distance to the infinite line rather than to
    // the capsule, because the push travels along the normal: clearing the line's band by `half`
    // clears the capsule too (the capsule is a subset of that band), whereas a push sized from the
    // capsule distance could fall short near an end.
    const perp = (b.x - edge.x0) * nx + (b.y - edge.y0) * ny;
    // Dead centre in the mouth: no nearer side exists. Pick the +normal side — deterministic beats
    // random for the same reason `playerCollision`/`groundSeparation` split a co-located pair along
    // a fixed axis: a random tiebreak resolves differently per machine and is untestable.
    const sign = perp === 0 ? 1 : Math.sign(perp);
    const near = half + margin - Math.abs(perp);     // out the side it is already nearer
    const far = half + margin + Math.abs(perp);      // all the way through, out the other side

    if (push(b, nx * sign * near, ny * sign * near, canMove)
      || push(b, -nx * sign * far, -ny * sign * far, canMove)) moved += 1;
  }
  return moved;
}

// Commit a displacement, clipped against the world, then verify it actually left the mouth. Unlike
// the separation modules' `moveBy` there is NO per-axis slide fallback: a partial push here would
// leave the body still inside the plate while reporting success, and the caller would move on to
// the far-side attempt with the body already shifted. All or nothing, so each candidate side is a
// clean, independent test.
function push(b, dx, dy, canMove) {
  const nx2 = b.x + dx, ny2 = b.y + dy;
  if (canMove && !canMove(b, nx2, ny2)) return false;
  b.x = nx2; b.y = ny2;
  return true;
}
