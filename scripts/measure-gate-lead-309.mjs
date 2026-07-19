// #309 playtest 3 — THE LEAD TIME, measured on a freshly booted world.
//
// Jackson: "gates appear to be opening WAAAAAAY in advance of a ground unit needing to pass through
// it. like it opens when the pathing is decided, but it should open at the last moment when it
// needs to pass through instead."
//
// The number that settles that is: how long does a gate stand open before a ground unit actually
// goes through it? This is its own script rather than another phase of diagnose-gates-309.mjs
// because it has to run on an UNDISTURBED world. The diagnostic's earlier phases fight a 30-40s
// engagement, by the end of which every garrison has already streamed out of its compound and there
// is nobody left inside to walk through a door — which reports "no crossings" and means nothing.
//
// Run: node scripts/measure-gate-lead-309.mjs   (needs a dev server; set SMOKE_URL, default :5219)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5219/';
const WATCH_MS = Number(process.env.WATCH_MS || 45000);

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
await page.waitForTimeout(1200);

const report = await page.evaluate(async (watchMs) => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = {};
  const { pixelToHex, hexToPixel, axialKey } = await import('/src/data/hexgrid.js');
  const { isPassable } = await import('/src/data/terrain.js');
  const { remainingToGate } = await import('/src/data/gateDemand.js');

  const gates = [...a.wallEdges.edges.values()].filter((e) => e.role === 'gate' && !e.destroyed);

  // Pick the base with the most ground units still sitting inside its own walls, preferring tanks —
  // the reported case. Done FIRST, before anything has had a chance to leave.
  const insideRing = (b, e) => {
    const bc = hexToPixel(b.center.q, b.center.r);
    return Math.hypot(e.x - bc.x, e.y - bc.y) < 200;
  };
  const isGround = (e) => e.baseId != null && !e.flying && e.behavior !== 'turret'
    && !e.mech?.isDestroyed?.();
  const scored = a.bases.map((b) => {
    const inside = a.enemies.filter((e) => isGround(e) && e.baseId === b.id && insideRing(b, e));
    return { b, inside, tanks: inside.filter((e) => e.kind === 'tank').length };
  }).filter((s) => s.inside.length > 0 && gates.some((g) => g.baseId === s.b.id));
  scored.sort((x, y) => (y.tanks - x.tanks) || (y.inside.length - x.inside.length));
  const pick = scored[0];
  if (!pick) { out.error = 'no base has ground units inside its ring'; return out; }

  out.base = {
    insideCount: pick.inside.length, tanks: pick.tanks,
    kinds: pick.inside.reduce((m, e) => { m[e.kind ?? '?'] = (m[e.kind ?? '?'] ?? 0) + 1; return m; }, {}),
  };

  const bc = hexToPixel(pick.b.center.q, pick.b.center.r);
  const bGates = gates.filter((g) => g.baseId === pick.b.id);

  // Stand outside one of this base's own gates, on passable ground, so its garrison has a real
  // reason to come through that specific door.
  let ps = null;
  for (const g of bGates) {
    const gmx = (g.x0 + g.x1) / 2, gmy = (g.y0 + g.y1) / 2;
    const dd = Math.hypot(gmx - bc.x, gmy - bc.y) || 1;
    const nx = (gmx - bc.x) / dd, ny = (gmy - bc.y) / dd;
    for (let d = 70; d <= 400; d += 20) {
      const x = gmx + nx * d, y = gmy + ny * d;
      const h = pixelToHex(x, y);
      if (isPassable(a.terrain.get(axialKey(h.q, h.r)))) { ps = { x, y }; break; }
    }
    if (ps) break;
  }
  if (ps) { a.px = ps.x; a.py = ps.y; }
  a._wakeBase(pick.b.id);

  const tracked = pick.inside.slice();
  const sideOf = (g, e) => Math.sign((g.x1 - g.x0) * (e.y - g.y0) - (g.y1 - g.y0) * (e.x - g.x0));
  const openedAt = new Map();
  const lastSide = new Map();
  const minDist = new Map(bGates.map((g) => [g.key, Infinity]));
  for (const g of bGates) for (let i = 0; i < tracked.length; i++) lastSide.set(g.key + '|' + i, sideOf(g, tracked[i]));

  const crossings = [];
  const series = [];
  // THE PROXY METRIC. Crossings turn out to be rare in practice (a woken garrison largely holds
  // position rather than streaming out — see the report), so "lead time until a unit crosses" is
  // not reliably observable. This is: at the exact frame each gate finishes opening, how far is the
  // nearest unit that ASKED for it? That answers "is it opening way in advance" directly, and it is
  // observable on every run. Under the old behaviour a unit could be most of a compound away
  // (400px+) or on a long approach route; it should now be inside the near radius or a few seconds
  // of travel.
  const openEvents = [];
  const wasOpen = new Map(bGates.map((g) => [g.key, false]));
  // The BEFORE number, for an honest comparison. The old rule registered demand the instant a
  // unit's route crossed a gate, with no distance test at all — so the door would have started
  // opening at the first frame any unit held intent for it. Recording the nearest requester's
  // distance at that moment gives what the old behaviour would have produced on this same run.
  const firstIntentEvents = [];
  const sawIntent = new Map(bGates.map((g) => [g.key, false]));
  let nextSample = 0;
  // GAME time, not wall time, is the honest clock here. The gate's state machine advances on the
  // scene's own delta, and on a loaded machine headless Chromium can run the arena at a fraction of
  // real-time — which stretches every wall-clock reading by the same factor and makes correct
  // timings look broken. `a.time.now` is what the mechanism actually sees.
  // The gate subsystem's own clock (bases.js `_gateClockMs`): the clamped, accumulated `dt` that
  // both the doors AND unit movement advance on. Lead time is a question about those two relative
  // to each other, so this is the frame-rate-independent clock to measure it in — wall time on a
  // loaded machine stretches everything uniformly and tells you nothing about what a player sees.
  const gt0 = a._gateClockMs ?? 0;
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < watchMs) {
    await new Promise((r) => requestAnimationFrame(r));
    frames++;
    const now = (a._gateClockMs ?? 0) - gt0;
    for (const g of bGates) {
      if (g.open && !wasOpen.get(g.key)) {
        const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;
        let best = null;
        for (const e of tracked) {
          if (e.mech?.isDestroyed?.() || e._gateIntent?.key !== g.key) continue;
          const d = Math.hypot(e.x - mx, e.y - my);
          if (best === null || d < best.distPx) {
            const spd = ((e.kindDef?.move?.maxSpeed) ?? 50) * 0.85;
            best = { kind: e.kind ?? '?', distPx: Math.round(d), etaMs: Math.round((d / spd) * 1000) };
          }
        }
        openEvents.push({ t: Math.round(now), nearestRequester: best });
      }
      if (!sawIntent.get(g.key)) {
        const mx2 = (g.x0 + g.x1) / 2, my2 = (g.y0 + g.y1) / 2;
        let best2 = null;
        for (const e of tracked) {
          if (e.mech?.isDestroyed?.() || e._gateIntent?.key !== g.key) continue;
          const d2 = Math.hypot(e.x - mx2, e.y - my2);
          if (best2 === null || d2 < best2.distPx) {
            const spd2 = ((e.kindDef?.move?.maxSpeed) ?? 50) * 0.85;
            best2 = { kind: e.kind ?? '?', distPx: Math.round(d2), etaMs: Math.round((d2 / spd2) * 1000) };
          }
        }
        if (best2) { sawIntent.set(g.key, true); firstIntentEvents.push({ t: Math.round(now), nearestRequester: best2 }); }
      }
      wasOpen.set(g.key, !!g.open);
      if (g.open && !openedAt.has(g.key)) openedAt.set(g.key, now);
      if (!g.open) openedAt.delete(g.key);
      const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;
      const spanLen = Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
      for (let i = 0; i < tracked.length; i++) {
        const e = tracked[i];
        if (e.mech?.isDestroyed?.()) continue;
        const d = Math.hypot(e.x - mx, e.y - my);
        if (d < minDist.get(g.key)) minDist.set(g.key, d);
        const id = g.key + '|' + i;
        const side = sideOf(g, e);
        const prev = lastSide.get(id);
        lastSide.set(id, side);
        if (prev === undefined || side === 0 || prev === 0 || side === prev) continue;
        if (d > spanLen) continue;    // crossed the span's infinite line, but nowhere near the span
        crossings.push({
          kind: e.kind ?? '?',
          leadMs: openedAt.has(g.key) ? Math.round(now - openedAt.get(g.key)) : null,
          gateWasOpen: !!g.open,
        });
      }
    }
    // Time series of the whole demand -> open -> cross chain, so a zero-crossing run says WHICH
    // link broke rather than merely that it did.
    if (now >= nextSample) {
      nextSample = now + 500;
      const g0 = bGates[0];
      const mx0 = (g0.x0 + g0.x1) / 2, my0 = (g0.y0 + g0.y1) / 2;
      let intents = 0, minEta = Infinity, minD = Infinity;
      for (const e of tracked) {
        if (e.mech?.isDestroyed?.()) continue;
        const d = Math.hypot(e.x - mx0, e.y - my0);
        if (d < minD) minD = d;
        if (e._gateIntent?.key !== g0.key) continue;
        intents++;
        const rem = remainingToGate(e.x, e.y, e._gateIntent, mx0, my0);
        const spd = ((e.kindDef?.move?.maxSpeed) ?? 50) * 0.85;
        const eta = spd > 0 ? (rem / spd) * 1000 : Infinity;
        if (eta < minEta) minEta = eta;
      }
      series.push({
        t: Math.round(now),
        phase: a._gateStates.get(g0.key)?.phase ?? 'gone',
        open: !!g0.open,
        wanted: !!a._gateDemand.wanted(g0.key, a._gateClockMs ?? 0),
        intents,
        etaMs: minEta === Infinity ? null : Math.round(minEta),
        distPx: minD === Infinity ? null : Math.round(minD),
      });
    }
  }

  const withLead = crossings.filter((c) => c.leadMs != null);
  const leads = withLead.map((c) => c.leadMs).sort((x, y) => x - y);
  const tankLeads = withLead.filter((c) => c.kind === 'tank').map((c) => c.leadMs).sort((x, y) => x - y);
  const wallMs = performance.now() - t0;
  const gameMs = (a._gateClockMs ?? 0) - gt0;
  out.clock = {
    wallMs: Math.round(wallMs), gameMs: Math.round(gameMs),
    // <1 means the arena is running slower than real time (a loaded machine). Every duration below
    // is in GAME ms, so this only tells you how much to trust wall-clock intuition.
    // <1 means the arena's simulated time is running behind wall time (a loaded machine). Durations
    // below are in gate-clock ms, so this only calibrates wall-clock intuition.
    gateClockRatio: +(gameMs / wallMs).toFixed(2),
    fps: Math.round(frames / (wallMs / 1000)),
  };
  out.result = {
    crossings: crossings.length,
    crossingsWhileOpen: withLead.length,
    crossingsWhileShut: crossings.filter((c) => !c.gateWasOpen).length,
    leadMsMedian: leads.length ? leads[Math.floor(leads.length / 2)] : null,
    leadMsMin: leads.length ? leads[0] : null,
    leadMsMax: leads.length ? leads[leads.length - 1] : null,
    tankCrossings: tankLeads.length,
    tankLeadMs: tankLeads,
    closestApproachPx: [...minDist.values()].map((v) => (v === Infinity ? null : Math.round(v))),
    openEvents,
    firstIntentEvents,
    survivingTracked: tracked.filter((e) => !e.mech?.isDestroyed?.()).length,
    trackedTotal: tracked.length,
  };
  out.series = series;
  return out;
}, WATCH_MS);

console.log(JSON.stringify(report, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
