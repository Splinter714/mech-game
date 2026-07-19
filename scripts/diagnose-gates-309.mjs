// #309 playtest 2 — DIAGNOSTIC, not a pass/fail audit. Jackson: "the pathing is about right, but I
// don't see the gates actually opening for the tanks when they seem to be wanting it."
//
// Runs the real game and tests each ranked candidate cause against evidence, rather than guessing:
//   A. Do tanks carry a `baseId` on a woken base, and does `_isGateDemandUnit` accept them?
//   B. What fraction of real demand searches come back `complete: false`, split by unit kind, and
//      how does that vary with the node cap and with player distance?
//   C. Round-robin coverage: eligible units vs. scan rate vs. the 1500ms grace window.
//   D. Does `firstGateOnRoute` return null on complete routes (wrong span / already in the mouth)?
//
// Run: node scripts/diagnose-gates-309.mjs   (needs a dev server; set SMOKE_URL, default :5219)
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
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = {};
  const { pixelToHex, hexToPixel, axialKey } = await import('/src/data/hexgrid.js');
  const { isPassable } = await import('/src/data/terrain.js');
  const { findHexPath } = await import('/src/data/hexRoute.js');
  const { firstGateOnRoute } = await import('/src/data/gateDemand.js');

  const gates = [...a.wallEdges.edges.values()].filter((e) => e.role === 'gate');

  // ── A. Population: who is even eligible, and do tanks carry a baseId? ─────────────────
  const census = {};
  for (const e of a.enemies) {
    const k = e.kind ?? 'unknown';
    const c = (census[k] ??= { total: 0, withBaseId: 0, flying: 0, turretBehavior: 0, eligible: 0 });
    c.total++;
    if (e.baseId != null) c.withBaseId++;
    if (e.flying) c.flying++;
    if (e.behavior === 'turret') c.turretBehavior++;
  }
  out.censusBeforeWake = census;

  // Wake EVERY base, so nothing is gated on discovery, and mark units aware.
  for (const b of a.bases) a._wakeBase(b.id);
  await new Promise((r) => setTimeout(r, 300));
  for (const e of a.enemies) if (e.awareness === 'dormant') e.awareness = 'aware';

  for (const e of a.enemies) {
    const k = e.kind ?? 'unknown';
    if (a._isGateDemandUnit(e) && a._wokenBases.has(e.baseId)) census[k].eligible++;
  }
  out.censusAfterWake = census;
  out.eligibleTotal = a.enemies.filter((e) => a._isGateDemandUnit(e) && a._wokenBases.has(e.baseId)).length;

  // ── B. THE NODE CAP. Re-run the demand search for EVERY eligible unit at several caps, from
  //      where they actually stand, to the player where he actually is. This is the measurement
  //      that decides whether `complete: false` is what is swallowing tank demand.
  const canStep = (x, y, k) => a._canEnemyStepGatesOpen(x, y, k);
  const goal = pixelToHex(a.px, a.py);
  const eligible = a.enemies.filter((e) => a._isGateDemandUnit(e) && a._wokenBases.has(e.baseId));

  function sweep(cap, goalHex) {
    const r = { cap, searches: 0, complete: 0, nullGate: 0, noted: 0, expandedMax: 0, byKind: {} };
    for (const e of eligible) {
      const from = pixelToHex(e.x, e.y);
      const res = findHexPath(from, goalHex, canStep, cap);
      const k = e.kind ?? 'unknown';
      const bk = (r.byKind[k] ??= { searches: 0, complete: 0, noted: 0 });
      r.searches++; bk.searches++;
      if (res.expanded > r.expandedMax) r.expandedMax = res.expanded;
      if (!res.complete) continue;
      r.complete++; bk.complete++;
      const key = firstGateOnRoute(from, res.path, a.wallEdges.byHex);
      if (key == null) r.nullGate++; else { r.noted++; bk.noted++; }
    }
    return r;
  }

  out.capSweep_playerWhereHeIs = [400, 800, 1600, 4000].map((c) => sweep(c, goal));
  out.playerDistFromNearestBase = Math.round(Math.min(...a.bases.map((b) => {
    const c = hexToPixel(b.center.q, b.center.r);
    return Math.hypot(c.x - a.px, c.y - a.py);
  })));

  // ── B2. …and with the player standing right outside a base, which is the reported situation
  //        ("tanks that seem to be wanting it"). Same sweep, player teleported next to base 0.
  const b0 = a.bases[0];
  const c0 = hexToPixel(b0.center.q, b0.center.r);
  let spot = null;
  for (const g of gates.filter((g) => g.baseId === b0.id)) {
    const gmx = (g.x0 + g.x1) / 2, gmy = (g.y0 + g.y1) / 2;
    const d = Math.hypot(gmx - c0.x, gmy - c0.y) || 1;
    const nx = (gmx - c0.x) / d, ny = (gmy - c0.y) / d;
    for (let dd = 60; dd <= 400; dd += 20) {
      const x = gmx + nx * dd, y = gmy + ny * dd;
      const h = pixelToHex(x, y);
      if (isPassable(a.terrain.get(axialKey(h.q, h.r)))) { spot = { x, y }; break; }
    }
    if (spot) break;
  }
  if (spot) {
    const nearGoal = pixelToHex(spot.x, spot.y);
    out.capSweep_playerAtBase0 = [400, 800, 1600, 4000].map((c) => sweep(c, nearGoal));
    // Restricted to base 0's OWN garrison — the units whose door it is.
    const own = eligible.filter((e) => e.baseId === b0.id);
    out.base0GarrisonSize = own.length;
    out.base0ByKind = own.reduce((m, e) => { m[e.kind ?? '?'] = (m[e.kind ?? '?'] ?? 0) + 1; return m; }, {});
    const ownSweep = (cap) => {
      let complete = 0, noted = 0;
      for (const e of own) {
        const from = pixelToHex(e.x, e.y);
        const res = findHexPath(from, nearGoal, canStep, cap);
        if (!res.complete) continue;
        complete++;
        if (firstGateOnRoute(from, res.path, a.wallEdges.byHex) != null) noted++;
      }
      return { cap, of: own.length, complete, noted };
    };
    out.base0OwnGarrison = [400, 800, 1600, 4000].map(ownSweep);
  }

  // ── C. Round-robin coverage arithmetic, from the live numbers.
  out.roundRobin = {
    eligible: out.eligibleTotal,
    unitsPerSec: (1000 / 250) * 6,
    secondsForFullCycle: +(out.eligibleTotal / ((1000 / 250) * 6)).toFixed(2),
    graceMs: 3000,
  };

  // ── D. LONGITUDINAL, WITH TANKS. The reported case, played out on the real clock: put the
  //      player where a garrison can reach him, let the real scan run, and watch what the real
  //      gates do. Reports per-kind demand contribution and the live cost of the scan.
  if (spot) {
    a.px = spot.x; a.py = spot.y;
    a._gateDemandStats = { scans: 0, searches: 0, complete: 0, incomplete: 0, noted: 0,
      nullGate: 0, eligible: 0, expandedTotal: 0, expandedMax: 0, byKind: {} };
    const watched = gates.filter((g) => !g.destroyed);
    const opened = new Set();
    const prev = new Map(watched.map((g) => [g.key, g.open]));
    const flips = new Map(watched.map((g) => [g.key, 0]));
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) {
      await new Promise((r) => requestAnimationFrame(r));
      for (const g of watched) {
        if (g.open) opened.add(g.key);
        if (g.open !== prev.get(g.key)) { flips.set(g.key, flips.get(g.key) + 1); prev.set(g.key, g.open); }
      }
    }
    const elapsedS = (performance.now() - t0) / 1000;
    const st = a._gateDemandStats;
    out.longitudinal = {
      seconds: Math.round(elapsedS),
      gatesThatOpened: opened.size,
      gatesWatched: watched.length,
      maxStateChanges: Math.max(0, ...flips.values()),
      scanStats: JSON.parse(JSON.stringify(st)),
      completeRate: st.searches ? +(st.complete / st.searches).toFixed(3) : null,
      // Load-independent cost proxy: A* nodes expanded per second by the demand scan. Preferred
      // over wall-clock, which is meaningless on a loaded machine.
      expandedPerSec: Math.round(st.expandedTotal / elapsedS),
      searchesPerSec: +(st.searches / elapsedS).toFixed(1),
    };
    // Which kinds actually contributed demand — the reported case is specifically TANKS.
    out.longitudinal.tankContribution = st.byKind.tank ?? null;
  }
  // ── E. PLAYTEST 3: THE LEAD TIME, measured live with TANKS ───────────────────────────
  // "gates appear to be opening WAAAAAAY in advance of a ground unit needing to pass through it."
  // The number that settles it: how long does a gate stand open before the first ground unit
  // actually crosses it? Under the old behaviour this was the unit's whole walk across the
  // compound; it should now be a beat.
  //
  // Deliberately self-contained: earlier phases teleport the player, delete and restore garrisons
  // and re-init the gate subsystem, so this resets to a clean state and picks a base that actually
  // has a live ground garrison INSIDE its ring. A probe that measures a base whose units already
  // left reports "no crossings" and tells you nothing.
  {
    a._initGates();
    for (const b of a.bases) a._wakeBase(b.id);
    for (const e of a.enemies) if (e.awareness === 'dormant') e.awareness = 'aware';

    const insideRing = (b, e) => {
      const bc = hexToPixel(b.center.q, b.center.r);
      return Math.hypot(e.x - bc.x, e.y - bc.y) < 170;    // inside a radius-2 compound
    };
    // Prefer a base with ground units still inside its walls; prefer one with tanks.
    const scored = a.bases.map((b) => {
      const inside = a.enemies.filter((e) => a._isGateDemandUnit(e) && e.baseId === b.id && insideRing(b, e));
      return { b, inside, tanks: inside.filter((e) => e.kind === 'tank').length };
    }).filter((s) => s.inside.length > 0 && gates.some((g) => g.baseId === s.b.id && !g.destroyed));
    scored.sort((x, y) => (y.tanks - x.tanks) || (y.inside.length - x.inside.length));
    const pick = scored[0] ?? null;
    out.leadProbeBase = pick
      ? { insideCount: pick.inside.length, tanks: pick.tanks,
          kinds: pick.inside.reduce((m, e) => { m[e.kind ?? '?'] = (m[e.kind ?? '?'] ?? 0) + 1; return m; }, {}) }
      : null;

    if (pick) {
      const bc = hexToPixel(pick.b.center.q, pick.b.center.r);
      const bGates = gates.filter((g) => g.baseId === pick.b.id && !g.destroyed);
      // Stand outside one of this base's own gates so its garrison has a reason to come through.
      let ps = null;
      for (const g of bGates) {
        const gmx = (g.x0 + g.x1) / 2, gmy = (g.y0 + g.y1) / 2;
        const dd = Math.hypot(gmx - bc.x, gmy - bc.y) || 1;
        const nx = (gmx - bc.x) / dd, ny = (gmy - bc.y) / dd;
        for (let d = 60; d <= 400; d += 20) {
          const x = gmx + nx * d, y = gmy + ny * d;
          const h = pixelToHex(x, y);
          if (isPassable(a.terrain.get(axialKey(h.q, h.r)))) { ps = { x, y }; break; }
        }
        if (ps) break;
      }
      if (ps) { a.px = ps.x; a.py = ps.y; }

      const openedAt = new Map();
      const crossings = [];
      const sideOf = (g, e) => Math.sign((g.x1 - g.x0) * (e.y - g.y0) - (g.y1 - g.y0) * (e.x - g.x0));
      const tracked = pick.inside.slice();
      const lastSide = new Map();
      const minDist = new Map();     // closest any intent-holder got to each gate's mouth
      for (const g of bGates) {
        for (let i = 0; i < tracked.length; i++) lastSide.set(g.key + '|' + i, sideOf(g, tracked[i]));
        minDist.set(g.key, Infinity);
      }

      // Time series of the whole demand->open->cross chain, so a zero-crossing run says WHICH link
      // broke rather than just that it did.
      const { remainingToGate } = await import('/src/data/gateDemand.js');
      const series = [];
      let nextSample = 0;

      const t0 = performance.now();
      while (performance.now() - t0 < 40000) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now() - t0;
        if (now >= nextSample) {
          nextSample = now + 500;
          const g0 = bGates[0];
          const mx0 = (g0.x0 + g0.x1) / 2, my0 = (g0.y0 + g0.y1) / 2;
          let intents = 0, minEta = Infinity, minDistNow = Infinity;
          for (const e of tracked) {
            if (e.mech?.isDestroyed?.()) continue;
            const d = Math.hypot(e.x - mx0, e.y - my0);
            if (d < minDistNow) minDistNow = d;
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
            wanted: !!a._gateDemand.wanted(g0.key, a.time.now),
            intents,
            minEtaMs: minEta === Infinity ? null : Math.round(minEta),
            minDistPx: minDistNow === Infinity ? null : Math.round(minDistNow),
          });
        }
        for (const g of bGates) {
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
            if (d > spanLen) continue;    // flipped the span's line, but nowhere near the span
            crossings.push({
              gate: g.key, kind: e.kind ?? '?',
              leadMs: openedAt.has(g.key) ? Math.round(now - openedAt.get(g.key)) : null,
              gateWasOpen: !!g.open,
            });
          }
        }
      }
      const withLead = crossings.filter((c) => c.leadMs != null);
      const tankCrossings = withLead.filter((c) => c.kind === 'tank');
      const leads = withLead.map((c) => c.leadMs).sort((x, y) => x - y);
      out.leadTime = {
        crossings: crossings.length,
        crossingsWhileOpen: withLead.length,
        crossingsWhileShut: crossings.filter((c) => !c.gateWasOpen).length,
        tankCrossings: tankCrossings.length,
        // THE HEADLINE: ms between a gate opening and a unit actually going through it.
        leadMsMedian: leads.length ? leads[Math.floor(leads.length / 2)] : null,
        leadMsMin: leads.length ? leads[0] : null,
        leadMsMax: leads.length ? leads[leads.length - 1] : null,
        tankLeadMs: tankCrossings.map((c) => c.leadMs).sort((x, y) => x - y),
        // Diagnostics for a zero-crossing run: did anyone even get near a door?
        closestApproachPx: [...minDist.values()].map((v) => (v === Infinity ? null : Math.round(v))),
        survivingTracked: tracked.filter((e) => !e.mech?.isDestroyed?.()).length,
        trackedTotal: tracked.length,
        series,
      };
    }
  }
  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
