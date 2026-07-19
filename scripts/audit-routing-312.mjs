// #312 — live verification of enemy PATHFINDING in the REAL running game (Phaser in a real
// browser), plus an honest performance A/B. The unit tests prove the graph search is correct on
// synthetic rings; this proves it does the right thing on real generated worlds, and measures what
// it costs.
//
// Part A — behaviour, on the real world:
//   1. Routing is actually engaged (units have real cached routes on the live map).
//   2. A unit that would previously stall against a wall makes real progress toward its goal —
//      measured by driving the REAL enemy movement integrator, not a stub.
//   3. Sealed-in garrisons don't thrash: bounded search count over a long window.
//   4. A gate opening / a span being breached invalidates routes and opens a real way through.
//
// Part B — performance. Reported two ways, because they disagree in an instructive way:
//   * DIRECT ATTRIBUTION — wrap `_routedIntent` and total its own wall-clock against the engine
//     step's. This is the trustworthy number: it is stable to within 0.03ms across runs and it
//     cannot be polluted by GC or background load the way an arm-difference can.
//   * PAIRED ARM A/B, WITHIN ONE SESSION. profile-fight.mjs randomizes the world seed per run, so
//     enemy counts swing 42-219 between runs and a naive before/after A/B is pure noise. This
//     instead holds the page, world and fight fixed and toggles routing every second, bucketing
//     engine-step times by arm. Kept because it measures the WHOLE-frame effect rather than just
//     the routing call — but it is noticeably noisier (observed +0.5% to +20% across runs on the
//     same build, against a direct attribution that never left 3.2-3.3%), so read it as a sanity
//     check on the direct number, not as the headline.
//
// The toggle swaps `_routedIntent` for a straight-line version at runtime, so nothing in the
// shipped source exists merely to support measurement.
//
// For the BEHAVIOURAL A/B — "does a unit that used to stall now go around" — see the companion
// script audit-routing-312-detour.mjs, which is the decisive one.
//
// Run: node scripts/audit-routing-312.mjs   (needs a dev server; set SMOKE_URL, default :5312)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5312/';

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
await page.waitForTimeout(1500);

// ── Part A: behaviour ───────────────────────────────────────────────────────────────────
const behaviour = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = {};
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  out.baseCount = (a.bases ?? []).length;
  out.spanCount = a.wallEdges ? a.wallEdges.edges.size : 0;
  out.gateCount = a.wallEdges ? [...a.wallEdges.edges.values()].filter((e) => e.role === 'gate').length : 0;

  // Wake every base so the garrisons are live and actually trying to go somewhere.
  for (const b of a.bases ?? []) a._wakeBase(b.id);
  for (let i = 0; i < 120; i++) await frame();

  out.enemyCount = a.enemies.length;
  const router = a._enemyRouter;
  out.routerExists = !!router;
  if (!router) return out;

  // 1. Routing is engaged on the real map: how many live units hold a cached route right now,
  //    and how many of those are complete vs. best-effort (sealed in).
  const snapshot = () => {
    let routed = 0, complete = 0, partial = 0, none = 0;
    for (const e of a.enemies) {
      const s = router.routeFor(e);
      if (!s) { none++; continue; }
      if (s.path.length > 0) { routed++; if (s.complete) complete++; else partial++; } else none++;
    }
    return { routed, complete, partial, none };
  };
  out.routes = snapshot();

  // 2. Real progress: pick ground units whose straight line to the player is BLOCKED (exactly the
  //    population that used to stall), and measure how much closer they get over 4 seconds while
  //    the real integrator drives them.
  const blockedUnits = a.enemies.filter((e) => (
    !e.flying && !e.mech.isDestroyed() && !a._enemyLineClear(e.x, e.y, a.px, a.py)
  ));
  const before = blockedUnits.map((e) => ({ e, d: Math.hypot(e.x - a.px, e.y - a.py), x: e.x, y: e.y }));
  for (let i = 0; i < 240; i++) await frame();
  const moved = before.map((b) => ({
    closed: b.d - Math.hypot(b.e.x - a.px, b.e.y - a.py),
    travelled: Math.hypot(b.e.x - b.x, b.e.y - b.y),
  }));
  out.blockedUnitCount = before.length;
  out.movedAtAll = moved.filter((m) => m.travelled > 12).length;
  out.gotCloser = moved.filter((m) => m.closed > 12).length;
  out.medianTravelPx = moved.length
    ? Math.round(moved.map((m) => m.travelled).sort((x, y) => x - y)[Math.floor(moved.length / 2)])
    : 0;

  // 3. No thrashing: count actual A* searches over a 5s window with everything awake. Wrapped so
  //    we count real calls rather than inferring from timers.
  const realFollow = router.follow.bind(router);
  let searches = 0, follows = 0;
  const seen = new WeakMap();
  router.follow = (unit, x, y, goal, now, ctx) => {
    follows++;
    const before2 = seen.get(unit);
    const r = realFollow(unit, x, y, goal, now, ctx);
    const st = router.routeFor(unit);
    if (st && st.planAt !== before2) { searches++; seen.set(unit, st.planAt); }
    return r;
  };
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < 5000) { await frame(); frames++; }
  router.follow = realFollow;
  out.window = {
    ms: Math.round(performance.now() - t0), frames,
    followCalls: follows, searches,
    searchesPerFrame: Math.round((searches / Math.max(1, frames)) * 100) / 100,
    followsPerFrame: Math.round((follows / Math.max(1, frames)) * 100) / 100,
  };

  // 4. Invalidation is real: breach a standing span and confirm the epoch moves and routes replan.
  const standing = [...a.wallEdges.edges.values()].find((e) => !e.destroyed);
  if (standing) {
    const epochBefore = router.epoch;
    a._damageWallEdge(standing, 99999);
    out.breach = { destroyed: standing.destroyed, epochBefore, epochAfter: router.epoch };
    for (let i = 0; i < 30; i++) await frame();
    out.routesAfterBreach = snapshot();
  }
  return out;
});

// ── Part B: paired within-session A/B ───────────────────────────────────────────────────
const perf = await page.evaluate(async () => {
  const g = window.__game;
  const a = g.scene.getScene('ArenaScene');
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  // The straight-line stand-in for the OFF arm: exactly what the code did before #312.
  const routed = a._routedIntent.bind(a);
  const straight = (e, tx, ty) => {
    const dx = tx - e.x, dy = ty - e.y, m = Math.hypot(dx, dy) || 1;
    return { mx: dx / m, my: dy / m };
  };

  // Direct attribution first: total `_routedIntent`'s own wall-clock against the engine step's,
  // over a plain 10s of ordinary play with every base awake. This is the number to trust.
  const direct = await (async () => {
    a.enemyFire = false;
    let routeMs = 0, calls = 0, stepMs = 0, steps = 0, t0 = 0;
    const real = a._routedIntent.bind(a);
    a._routedIntent = (e, tx, ty) => {
      const t = performance.now(); const r = real(e, tx, ty); routeMs += performance.now() - t; calls++; return r;
    };
    const on1 = () => { t0 = performance.now(); };
    const on2 = () => { stepMs += performance.now() - t0; steps++; };
    g.events.on('prestep', on1); g.events.on('postrender', on2);
    const s0 = performance.now();
    while (performance.now() - s0 < 10000) await frame();
    g.events.off('prestep', on1); g.events.off('postrender', on2);
    a._routedIntent = real;
    a.enemyFire = true;
    const ground = a.enemies.filter((e) => !e.flying && !e.emplaced && e.kindDef?.move?.maxSpeed && !e.mech.isDestroyed());
    return {
      groundMovers: ground.length, frames: steps,
      avgStepMs: Math.round((stepMs / steps) * 1000) / 1000,
      routeCallsPerFrame: Math.round((calls / steps) * 10) / 10,
      routeMsPerFrame: Math.round((routeMs / steps) * 1000) / 1000,
      routeShareOfStepPct: Math.round((routeMs / stepMs) * 1000) / 10,
    };
  })();

  const P = { t0: 0, cur: null, on: [], off: [] };
  g.events.on('prestep', () => { P.t0 = performance.now(); });
  g.events.on('postrender', () => { if (P.cur) P.cur.push(performance.now() - P.t0); });

  // Alternate arms every second for 24s (12 seconds per arm, interleaved), so any slow drift in
  // the fight itself — units dying, a base waking — lands on both arms equally.
  const ROUNDS = 24;
  for (let i = 0; i < ROUNDS; i++) {
    const on = i % 2 === 0;
    a._routedIntent = on ? routed : straight;
    P.cur = null;
    // Discard the first ~150ms of each arm: the switch itself perturbs caches.
    const s0 = performance.now();
    while (performance.now() - s0 < 150) await frame();
    P.cur = on ? P.on : P.off;
    const s1 = performance.now();
    while (performance.now() - s1 < 850) await frame();
    P.cur = null;
  }
  a._routedIntent = routed;

  const stat = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return {
      n: s.length,
      avg: Math.round((s.reduce((x, y) => x + y, 0) / s.length) * 1000) / 1000,
      median: Math.round(s[Math.floor(s.length / 2)] * 1000) / 1000,
      p95: Math.round(s[Math.floor(s.length * 0.95)] * 1000) / 1000,
      p99: Math.round(s[Math.floor(s.length * 0.99)] * 1000) / 1000,
    };
  };
  return {
    enemies: a.enemies.length,
    fps: Math.round(g.loop.actualFps * 10) / 10,
    direct,
    routingOn: stat(P.on),
    routingOff: stat(P.off),
  };
});

console.log('\n=== #312 routing — behaviour on the real world ===');
console.log(JSON.stringify(behaviour, null, 2));
console.log('\n=== #312 routing — paired A/B (same page, same world, same fight) ===');
console.log(JSON.stringify(perf, null, 2));
if (perf.routingOn && perf.routingOff) {
  const d = perf.routingOn.avg - perf.routingOff.avg;
  const pct = (d / perf.routingOff.avg) * 100;
  console.log(`\nstep cost delta: ${d >= 0 ? '+' : ''}${d.toFixed(3)}ms (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  console.log(`p95 delta:       ${(perf.routingOn.p95 - perf.routingOff.p95).toFixed(3)}ms`);
}
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));

await browser.close();
