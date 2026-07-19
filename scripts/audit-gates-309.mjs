// #309 — live verification of wall GATES in the REAL running game (Phaser in a real browser),
// not in a unit-test stub. Boots the game, deploys into the arena, finds a real generated base,
// wakes it, and measures four things that the unit tests can only argue about in the abstract:
//
//   1. Every base really got its sally ports, on real corridor terrain.
//   2. Waking a base actually opens a gate, on the real per-frame clock.
//   3. While that gate stands OPEN, the player's own movement query still refuses every one of a
//      full sweep of approach bearings — the seal, measured in the live world rather than a
//      synthetic ring.
//   4. A real garrison unit, driven by the real enemy movement integrator, gets OUT through it.
//
// Run: node scripts/audit-gates-309.mjs   (needs a dev server; set SMOKE_URL, default :5219)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5219/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL);
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 30000 });
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 30000 });
// Let the arena settle so world-gen, wall edges, and gate cycles all exist.
await page.waitForTimeout(1200);

const report = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = { steps: [] };
  const gates = [...a.wallEdges.edges.values()].filter((e) => e.role === 'gate');

  // 1. Gates exist on the real generated world.
  out.baseCount = (a.bases ?? []).length;
  out.gateCount = gates.length;
  out.gatesPerBase = (a.bases ?? []).map((b) => gates.filter((g) => g.baseId === b.id).length);
  out.gateStates = a._gateStates ? a._gateStates.size : 0;

  // All shut before anything is woken.
  out.openBeforeWake = gates.filter((g) => g.open).length;

  // 2. Wake a real base and let its gate cycle run on the real clock.
  const base = a.bases[0];
  a._wakeBase(base.id);
  const baseGates = gates.filter((g) => g.baseId === base.id);
  const t0 = performance.now();
  let opened = null;
  const frames = [];
  while (performance.now() - t0 < 9000) {
    await new Promise((r) => requestAnimationFrame(r));
    const live = baseGates.filter((g) => g.open);
    frames.push(baseGates.map((g) => Number(g.openFrac?.toFixed(2) ?? 0)));
    if (live.length && !opened) { opened = { atMs: Math.round(performance.now() - t0), gate: live[0] }; break; }
  }
  out.openedAtMs = opened?.atMs ?? null;
  // Proof the leaves genuinely animated rather than snapping: distinct partial positions seen.
  out.partialFramesSeen = new Set(frames.flat().filter((f) => f > 0 && f < 1)).size;

  if (!opened) { out.steps.push('NO GATE OPENED'); return out; }
  const g = opened.gate;
  const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;

  // 3. THE SEAL, live, with this gate open. Sweep 720 bearings around the base centre, driving a
  // segment inward past the wall, using the PLAYER'S OWN movement query.
  const { hexToPixel } = await import('/src/data/hexgrid.js');
  const c = hexToPixel(base.center.q, base.center.r);
  let leaks = 0;
  for (let i = 0; i < 720; i++) {
    const th = (i / 720) * Math.PI * 2;
    for (const d of [300, 450, 5000]) {
      const fx = c.x + Math.cos(th) * d, fy = c.y + Math.sin(th) * d;
      if (!a._blockedAlongSegment(fx, fy, c.x, c.y)) leaks++;   // inbound
      if (!a._blockedAlongSegment(c.x, c.y, fx, fy)) leaks++;   // outbound
    }
  }
  out.sealLeaksWithGateOpen = leaks;
  out.gateOpenDuringSeal = g.open;

  // The pointed case: dead-on into the open gate's mouth.
  const d0 = Math.hypot(mx - c.x, my - c.y) || 1;
  const ux = (mx - c.x) / d0, uy = (my - c.y) / d0;
  out.deadOnIntoGateBlocked = a._blockedAlongSegment(mx + ux * 400, my + uy * 400, c.x, c.y);
  out.playerBlockedAtGateMouth = a._blocked(mx, my);
  out.enemyPassesGateMouth = !a._blockedForEnemy(mx, my);

  // 4. A real garrison unit gets out. Drive the actual enemy collide-and-slide rule frame by
  // frame from the compound centre toward a point outside the gate.
  const target = { x: c.x + ux * 420, y: c.y + uy * 420 };
  let x = c.x, y = c.y, escaped = false;
  for (let f = 0; f < 500 && !escaped; f++) {
    const dd = Math.hypot(target.x - x, target.y - y) || 1;
    const vx = ((target.x - x) / dd) * 4, vy = ((target.y - y) / dd) * 4;
    let nx = x + vx, ny = y + vy;
    if (a._blockedForEnemy(nx, ny)) {
      if (!a._blockedForEnemy(x + vx, y)) ny = y;
      else if (!a._blockedForEnemy(x, y + vy)) nx = x;
      else { nx = x; ny = y; }
    }
    x = nx; y = ny;
    if (Math.hypot(x - c.x, y - c.y) > d0 + 30) escaped = true;
  }
  out.garrisonUnitEscaped = escaped;

  // And the same unit is trapped once the gate shuts.
  for (const gg of baseGates) gg.open = false;
  let x2 = c.x, y2 = c.y, escaped2 = false;
  for (let f = 0; f < 500 && !escaped2; f++) {
    const dd = Math.hypot(target.x - x2, target.y - y2) || 1;
    const vx = ((target.x - x2) / dd) * 4, vy = ((target.y - y2) / dd) * 4;
    let nx = x2 + vx, ny = y2 + vy;
    if (a._blockedForEnemy(nx, ny)) {
      if (!a._blockedForEnemy(x2 + vx, y2)) ny = y2;
      else if (!a._blockedForEnemy(x2, y2 + vy)) nx = x2;
      else { nx = x2; ny = y2; }
    }
    x2 = nx; y2 = ny;
    if (Math.hypot(x2 - c.x, y2 - c.y) > d0 + 30) escaped2 = true;
  }
  out.escapedWithGateShut = escaped2;
  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
