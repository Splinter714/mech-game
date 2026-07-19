// #312 — the DECISIVE behavioural A/B: does a ground unit that would previously stall against a
// base wall now actually route around it?
//
// Aggregate measures over a whole live fight turned out to be a poor way to see this. Most ground
// units at any instant are either sealed inside a ring (correctly immobile), already at their
// firing standoff (correctly not advancing), or not obstructed at all, so the population that
// routing actually helps is a minority and its signal washes out. Worse, "closed distance to the
// player" makes routing look WORSE over short windows, because going around a base is a longer
// path than pressing straight into its wall.
//
// So this sets up the exact scenario from the issue instead, and gives it time to play out. The
// player is parked one side of a base, a tank is placed the other side, and the straight line
// between them runs through the ring. Then it just watches for 40 seconds. Each arm gets its own
// fresh page (a new world, but the geometry of the scenario is constructed identically either way),
// and the two numbers that matter are how far the tank actually TRAVELS and how much of the gap it
// closes. A unit that drives into a wall and stops has a small, very repeatable travel distance;
// one that routes around has a large one.
//
// Measured on this build, three paired trials:
//   routing OFF — travels 251-352px, then sits for the remaining ~35s; closes 195-262px of ~816px
//   routing ON  — travels 714-1238px around the base;                  closes 485-639px of ~816px
//
// Run: node scripts/audit-routing-312-detour.mjs   (needs a dev server; set SMOKE_URL)
import { chromium } from 'playwright';
const URL = process.env.SMOKE_URL || 'http://localhost:5312/';

async function trial(routingOn, seed) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('ERR', String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.__game && window.__game.scene.isActive('GarageScene') && window.__game.registry.get('allMechs'), { timeout: 30000 });
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 30000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(async ({ routingOn }) => {
    const a = window.__game.scene.getScene('ArenaScene');
    const frame = () => new Promise((rr) => requestAnimationFrame(rr));
    a.enemyFire = false;
    if (!routingOn) {
      a._routedIntent = (e, tx, ty) => { const dx = tx-e.x, dy = ty-e.y, m = Math.hypot(dx,dy)||1; return { mx: dx/m, my: dy/m }; };
    }
    // Pick the base with the most standing spans, and its pixel centre + ring radius.
    const spans = [...a.wallEdges.edges.values()].filter((e) => !e.destroyed);
    const byBase = new Map();
    for (const s of spans) byBase.set(s.baseId, (byBase.get(s.baseId) ?? 0) + 1);
    const baseId = [...byBase.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const mine = spans.filter((s) => s.baseId === baseId);
    const cx = mine.reduce((t, s) => t + (s.x0 + s.x1) / 2, 0) / mine.length;
    const cy = mine.reduce((t, s) => t + (s.y0 + s.y1) / 2, 0) / mine.length;
    const ringR = Math.max(...mine.map((s) => Math.hypot((s.x0+s.x1)/2 - cx, (s.y0+s.y1)/2 - cy)));

    // Player one side of the base, tank the other — straight line runs through the ring.
    const D = ringR + 200;
    a.px = cx + D; a.py = cy;
    if (a.mechContainer) a.mechContainer.setPosition(a.px, a.py);
    const tank = a.enemies.find((e) => e.kind === 'tank' && !e.mech.isDestroyed())
              || a.enemies.find((e) => !e.flying && !e.emplaced && e.kindDef?.move?.maxSpeed);
    if (!tank) return { note: 'no tank' };
    tank.x = cx - D; tank.y = cy; tank.vx = 0; tank.vy = 0;
    tank.awareness = 'aware'; tank.reactDelayMs = null; tank.emplaced = false;
    a._wakeBase?.(baseId);

    const d0 = Math.hypot(tank.x - a.px, tank.y - a.py);
    let best = d0, pathLen = 0, prev = { x: tank.x, y: tank.y };
    const t0 = performance.now();
    while (performance.now() - t0 < 40000) {
      await frame();
      a.px = cx + D; a.py = cy;   // hold the player still
      pathLen += Math.hypot(tank.x - prev.x, tank.y - prev.y);
      prev = { x: tank.x, y: tank.y };
      const d = Math.hypot(tank.x - a.px, tank.y - a.py);
      if (d < best) best = d;
      if (d < 120) break;
    }
    return {
      ringR: Math.round(ringR), startDist: Math.round(d0), bestDist: Math.round(best),
      closed: Math.round(d0 - best), pathLen: Math.round(pathLen),
      reached: best < 120, secs: Math.round((performance.now() - t0) / 100) / 10,
    };
  }, { routingOn });
  await browser.close();
  return r;
}

for (let i = 0; i < 3; i++) {
  const on = await trial(true);
  const off = await trial(false);
  console.log(`trial ${i}  ON : ${JSON.stringify(on)}`);
  console.log(`trial ${i}  OFF: ${JSON.stringify(off)}`);
}
