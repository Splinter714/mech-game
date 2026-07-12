// Isolated hex-grid math (the ONLY file in the codebase that knows hexes exist).
// Pointy-top hexes addressed with axial coordinates {q, r} — no offset-parity mess.
// Adapted from the canonical reference: https://www.redblobgames.com/grids/hexagons/
//
// The rest of the game treats this as a black box: the mech moves with free
// continuous physics on top of the grid, so collision/line-of-sight are normal
// physics raycasts, not hex algorithms. Everything here is pure and unit-tested
// (hexgrid.test.js), so if hexes ever feel wrong, swapping to squares is a
// one-module change.

// Pixel radius of a hex (centre to corner). The arena reads this to size the world.
export const HEX_SIZE = 48;

const SQRT3 = Math.sqrt(3);

// The 6 axial neighbour directions, in clockwise order starting from "east".
const DIRECTIONS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

// A stable string key for an axial hex — handy for Set/Map membership.
export function axialKey(q, r) {
  return `${q},${r}`;
}

// Axial → pixel centre (pointy-top).
export function hexToPixel(q, r, size = HEX_SIZE) {
  return {
    x: size * SQRT3 * (q + r / 2),
    y: size * (3 / 2) * r,
  };
}

// Pixel → fractional axial coord (pointy-top), no rounding. Shared by pixelToHex (which
// rounds it to a concrete hex) and hexesAlongSegment (which needs to interpolate between
// two *fractional* positions before rounding each sample — rounding first and interpolating
// integer hexes would miss which hexes a path between them actually passes through).
function pixelToAxialFrac(x, y, size) {
  return { q: (SQRT3 / 3 * x - 1 / 3 * y) / size, r: (2 / 3 * y) / size };
}

// Pixel → nearest axial hex (pointy-top), via fractional cube + cube rounding.
export function pixelToHex(x, y, size = HEX_SIZE) {
  const { q, r } = pixelToAxialFrac(x, y, size);
  return cubeRound(q, r);
}

// Round a fractional axial coord to the nearest integer hex. Works in cube space
// (x + y + z = 0) and corrects the component with the largest rounding error so the
// constraint holds — the standard hex-rounding trick.
export function cubeRound(qf, rf) {
  const xf = qf, zf = rf, yf = -qf - rf;
  let x = Math.round(xf), y = Math.round(yf), z = Math.round(zf);
  const dx = Math.abs(x - xf), dy = Math.abs(y - yf), dz = Math.abs(z - zf);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;
  return { q: x, r: z };
}

// The 6 hexes adjacent to {q, r}.
export function neighbors(q, r) {
  return DIRECTIONS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

// Grid distance (in hexes) between two axial coords.
export function distance(a, b) {
  return (
    Math.abs(a.q - b.q) +
    Math.abs(a.q + a.r - b.q - b.r) +
    Math.abs(a.r - b.r)
  ) / 2;
}

// Every hex within `n` steps of `center` (a filled disc, includes the centre).
export function range(center, n) {
  const out = [];
  for (let dq = -n; dq <= n; dq++) {
    const lo = Math.max(-n, -dq - n);
    const hi = Math.min(n, -dq + n);
    for (let dr = lo; dr <= hi; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

// Every hex exactly `n` steps from `center` (a hollow ring). n <= 0 → just the centre.
export function ring(center, n) {
  if (n <= 0) return [{ q: center.q, r: center.r }];
  const out = [];
  // Start at the hex `n` steps in direction 4, then walk the 6 sides of the ring.
  let hex = { q: center.q + DIRECTIONS[4].q * n, r: center.r + DIRECTIONS[4].r * n };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < n; step++) {
      out.push({ q: hex.q, r: hex.r });
      hex = { q: hex.q + DIRECTIONS[side].q, r: hex.r + DIRECTIONS[side].r };
    }
  }
  return out;
}

// Nearest hex to `start` (searched outward ring-by-ring) that satisfies the predicate
// `ok(q, r)`. Returns the start hex itself when it already passes (distance 0), so an
// already-valid spot is returned unchanged. Searches up to `maxSteps` rings outward and
// returns the first passing hex on the innermost ring that has one; returns null if
// nothing within range passes (the caller supplies a guaranteed fallback). Pure — the
// predicate carries all the world knowledge (in-disc + passable), so this stays testable.
export function nearestHex(start, ok, maxSteps = 40) {
  for (let n = 0; n <= maxSteps; n++) {
    for (const h of ring(start, n)) {
      if (ok(h.q, h.r)) return { q: h.q, r: h.r };
    }
  }
  return null;
}

// Every hex a pixel-space circle at (x, y) with radius `r` meaningfully overlaps: the hex
// containing the centre point, plus any hex whose CENTRE lies within `r`. Used by burning
// ground patches (#72) to find which soft-cover hexes a fire is cooking. Deliberately
// centre-based (not exact hex-circle intersection) so a patch mostly burns the hex it sits
// on and only spreads to a neighbour it substantially covers.
export function hexesWithinPixelRadius(x, y, r, size = HEX_SIZE) {
  const centre = pixelToHex(x, y, size);
  const rings = Math.max(0, Math.ceil(r / (size * 1.5)));
  const out = [];
  for (const h of range(centre, rings)) {
    if (h.q === centre.q && h.r === centre.r) { out.push(h); continue; }
    const p = hexToPixel(h.q, h.r, size);
    if (Math.hypot(p.x - x, p.y - y) <= r) out.push(h);
  }
  return out;
}

// #159: every hex a straight PIXEL-SPACE segment from (x0,y0) to (x1,y1) passes through, in
// order. The standard cube-line-draw algorithm (redblobgames.com/grids/hexagons/#line-drawing):
// interpolate the two endpoints' FRACTIONAL axial coords (not the rounded hexes — rounding
// first would already lose which hexes a diagonal path grazes) at one sample per hex-step of
// distance, cube-rounding each sample. This is what makes swept collision exact regardless of
// approach angle or step size — a fixed-size position substep can still skip clean over a hex
// whose cross-section, at a shallow/grazing angle, is much narrower than the substep length
// (confirmed empirically: forcing a wall hex and driving a fast, INSTANT_VELOCITY-toggled mech
// into it from a broad continuous-angle sweep tunneled through in the majority of angles even
// at an 8px substep). Enumerating the actual hexes crossed has no such gap — PROVIDED its
// endpoints agree with plain `pixelToHex` (what `_blocked`/collision callers use to classify
// those exact same points): an earlier version nudged BOTH endpoints by a fixed epsilon (the
// textbook fix for a line running exactly along a hex edge/vertex tie) and, empirically, that
// nudge could flip an ENDPOINT's own rounding to a different hex than plain `pixelToHex(x1,y1)`
// would give it — a real, reproducible case, not just theoretical (straight-up/-down keyboard
// movement, whose x stays exactly 0, hit a hex-vertex tie where nudging the endpoint picked the
// wrong neighbour, letting a substep land inside a wall the swept check had just failed to
// flag). So the nudge is now confined to INTERIOR samples only — the first and last hexes in
// the result are always the exact, un-nudged `cubeRound` of the segment's own endpoints,
// guaranteeing this always agrees with a plain point-check of those same coordinates.
export function hexesAlongSegment(x0, y0, x1, y1, size = HEX_SIZE) {
  const a = pixelToAxialFrac(x0, y0, size);
  const b = pixelToAxialFrac(x1, y1, size);
  const startHex = cubeRound(a.q, a.r);
  const endHex = cubeRound(b.q, b.r);
  const n = distance(startHex, endHex);
  if (n === 0) return [startHex];
  const EPS = 1e-6;
  const out = [startHex];
  let lastKey = axialKey(startHex.q, startHex.r);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const h = cubeRound(a.q + (b.q - a.q) * t + EPS, a.r + (b.r - a.r) * t + EPS);
    const key = axialKey(h.q, h.r);
    if (key !== lastKey) { out.push(h); lastKey = key; }
  }
  const endKey = axialKey(endHex.q, endHex.r);
  if (endKey !== lastKey) out.push(endHex);
  return out;
}

// #88: nudge a drop's "ideal" spawn point (x, y) a small random distance away so two drops
// that would otherwise land on the exact same spot (e.g. a powerup + salvage from the same
// kill, or two kills close together) visually separate instead of stacking. Uniform over the
// disc of radius `maxR` (sqrt-distributed so points don't cluster at the centre), full 360°
// angle. `rand` is injectable (defaults to Math.random) so callers/tests can make it
// deterministic. Pure — callers are expected to run the result through a reachable-ground
// snap (e.g. arena/powerups.js `_reachableDropPos`, #73) so a scatter never lands somewhere
// unreachable; this function only does the scatter math, not passability.
export function scatterOffset(x, y, maxR = 30, rand = Math.random) {
  const angle = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * maxR;
  return { x: x + Math.cos(angle) * r, y: y + Math.sin(angle) * r };
}

// The six corner points (pixel offsets from a hex centre) for drawing a pointy-top
// hex. Corners are at 30° + 60°·i so the flat sides face left/right.
export function hexCorners(size = HEX_SIZE) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 90); // -90 → first corner points up
    pts.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return pts;
}
