// #169 — dump an actual generated corridor as ASCII so the snaking single-path shape can be eyeballed.
// Run: `node scripts/corridor-ascii.mjs [seed]`
import { mulberry32, generateSpine, corridorHexSet, boundaryRingKeys, safeZoneKeys, CORRIDOR_HALF_WIDTH_PX } from '../src/data/worldgen.js';
import { hexToPixel, axialKey } from '../src/data/hexgrid.js';

const seed = Number(process.argv[2] ?? 7);
const shapeRng = mulberry32(seed);
const startAngle = shapeRng() * Math.PI * 2;
const spine = generateSpine(shapeRng, { startAngle });
const included = corridorHexSet(spine.points, CORRIDOR_HALF_WIDTH_PX, safeZoneKeys({ q: 0, r: 0 }, 3));
const ring = boundaryRingKeys(null, { insideKeys: included, ringWidth: 1 });   // 1-deep ring just for the outline

// Rasterize by pixel position into a coarse character grid.
const spineKeys = new Set(spine.points.map((p) => {
  // nearest hex to each spine sample (pointy-top axial rounding, inline)
  const q = (Math.sqrt(3) / 3 * p.x - 1 / 3 * p.y) / 48;
  const r = (2 / 3 * p.y) / 48;
  // cube round
  let x = Math.round(q), z = Math.round(r), y = Math.round(-q - r);
  const dx = Math.abs(x - q), dy = Math.abs(y - (-q - r)), dz = Math.abs(z - r);
  if (dx > dy && dx > dz) x = -y - z; else if (dy > dz) y = -x - z; else z = -x - y;
  return axialKey(x, z);
}));

const cells = [];
const push = (key, ch, x, y) => cells.push({ ch, x, y });
for (const k of ring) { const [q, r] = k.split(',').map(Number); const p = hexToPixel(q, r); push(k, '#', p.x, p.y); }
for (const k of included) { const [q, r] = k.split(',').map(Number); const p = hexToPixel(q, r); push(k, spineKeys.has(k) ? '+' : '.', p.x, p.y); }
push('spawn', 'S', 0, 0);

const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const COLS = 120;
const scale = COLS / (maxX - minX);
const ROWS = Math.max(1, Math.round((maxY - minY) * scale * 0.5));   // 0.5 for char aspect ratio
const grid = Array.from({ length: ROWS + 1 }, () => Array(COLS + 1).fill(' '));
const prio = { '#': 1, '.': 2, '+': 3, S: 4 };
const at = Array.from({ length: ROWS + 1 }, () => Array(COLS + 1).fill(0));
for (const c of cells) {
  const cx = Math.round((c.x - minX) * scale);
  const cy = Math.round((c.y - minY) * scale * 0.5);
  if (cy < 0 || cy > ROWS || cx < 0 || cx > COLS) continue;
  if (prio[c.ch] >= at[cy][cx]) { grid[cy][cx] = c.ch; at[cy][cx] = prio[c.ch]; }
}
console.log(`seed=${seed} startAngle=${(startAngle * 180 / Math.PI).toFixed(0)}° includedHexes=${included.size}`);
console.log("legend: S=spawn  +=spine  .=corridor floor  #=boundary ring\n");
console.log(grid.map((row) => row.join('')).join('\n'));
