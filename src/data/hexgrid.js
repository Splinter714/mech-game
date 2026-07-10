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

// Pixel → nearest axial hex (pointy-top), via fractional cube + cube rounding.
export function pixelToHex(x, y, size = HEX_SIZE) {
  const q = (SQRT3 / 3 * x - 1 / 3 * y) / size;
  const r = (2 / 3 * y) / size;
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
