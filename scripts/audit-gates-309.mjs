// #309 — live verification of wall GATES in the REAL running game (Phaser in a real browser),
// not in a unit-test stub. Boots the game, deploys into the arena, finds a real generated base,
// wakes it, and measures four things that the unit tests can only argue about in the abstract:
//
//   1. Every base really got its sally ports, on real corridor terrain.
//   2. THE 2026-07-19 PLAYTEST FIX: a woken base whose garrison does not need the door leaves it
//      SHUT — no clock — while a woken base with a live garrison and the player in reach opens it
//      because units want out. These are the two measurements that distinguish demand from a timer,
//      and they are run back to back on the same real base.
//   3. With the gates SHUT, the player's own movement query refuses every one of a full sweep of
//      approach bearings — the seal, measured in the live world rather than a synthetic ring. (This
//      is the seal's post-playtest meaning: sealed while closed. An OPEN gate is now a legitimate
//      opening for everyone, which is measured separately below.)
//   4. A real garrison unit, driven by the real enemy movement integrator, gets OUT through an open
//      gate — and the player can get IN through the same one.
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

  // 2a. THE REGRESSION MEASUREMENT — no clock. Wake a real base, but first take its garrison out
  //     of the picture (kill the units that could ask for a door) and park the player far away.
  //     Under the old timer this gate opened ~2.2s after wake regardless; under demand it must sit
  //     shut indefinitely.
  const base = a.bases[0];
  const baseGates = gates.filter((g) => g.baseId === base.id);
  const { hexToPixel } = await import('/src/data/hexgrid.js');
  const c = hexToPixel(base.center.q, base.center.r);

  const parkedPx = a.px, parkedPy = a.py;
  const garrison = a.enemies.filter((e) => e.baseId === base.id);
  out.garrisonSize = garrison.length;
  a.enemies = a.enemies.filter((e) => e.baseId !== base.id);   // nobody left who needs the door
  a.px = c.x + 100000; a.py = c.y + 100000;                    // and the player is nowhere near
  a._wakeBase(base.id);
  out.baseAwake = a._wokenBases.has(base.id);

  const tIdle = performance.now();
  let openedWhileIdle = false;
  while (performance.now() - tIdle < 20000) {
    await new Promise((r) => requestAnimationFrame(r));
    if (baseGates.some((g) => g.open)) { openedWhileIdle = true; break; }
  }
  // THE HEADLINE NUMBER: false means the clock is genuinely gone.
  out.openedWithNoDemand_20s = openedWhileIdle;

  // 2b. Now give it a reason. Put the garrison back and the player somewhere a garrison unit can
  //     genuinely ROUTE to, and measure how long until a gate opens BECAUSE units want out.
  //
  //     Where the player stands matters, and a blind offset from the compound centre is not good
  //     enough: the world is a narrow winding corridor ringed by impassable boundary terrain, so an
  //     arbitrary point 260px east of a base can easily be off-corridor. A unit would then have no
  //     complete route to him, correctly register no demand, and the audit would report a failure
  //     that is really just a badly chosen probe. So walk OUTWARD along a gate's own normal and
  //     take the first genuinely passable spot — the direction a sortie would actually head.
  const { pixelToHex, axialKey: axKey } = await import('/src/data/hexgrid.js');
  const { isPassable } = await import('/src/data/terrain.js');
  const passableAt = (x, y) => {
    const h = pixelToHex(x, y);
    return isPassable(a.terrain.get(axKey(h.q, h.r)));
  };
  function playerSpotFor(gate) {
    const gmx = (gate.x0 + gate.x1) / 2, gmy = (gate.y0 + gate.y1) / 2;
    const dd = Math.hypot(gmx - c.x, gmy - c.y) || 1;
    const nx = (gmx - c.x) / dd, ny = (gmy - c.y) / dd;
    for (let d = 60; d <= 400; d += 20) {
      const x = gmx + nx * d, y = gmy + ny * d;
      if (passableAt(x, y)) return { x, y, d };
    }
    return null;
  }
  let spot = null;
  for (const gg of baseGates) { spot = playerSpotFor(gg); if (spot) break; }
  out.playerProbeSpot = spot ? { d: spot.d } : null;

  a.enemies = a.enemies.concat(garrison);
  for (const e of garrison) { e.awareness = 'aware'; }
  if (spot) { a.px = spot.x; a.py = spot.y; } else { a.px = c.x + 260; a.py = c.y; }
  const t0 = performance.now();
  let opened = null;
  const frames = [];
  while (performance.now() - t0 < 15000) {
    await new Promise((r) => requestAnimationFrame(r));
    const live = baseGates.filter((g) => g.open);
    frames.push(baseGates.map((g) => Number(g.openFrac?.toFixed(2) ?? 0)));
    if (live.length && !opened) { opened = { atMs: Math.round(performance.now() - t0), gate: live[0] }; break; }
  }
  out.openedOnDemandAtMs = opened?.atMs ?? null;
  // Diagnostics for the case where nothing opened, so a null above is interpretable rather than a
  // mystery: how many garrison units are actually eligible to ask, and does the demand ledger hold
  // a live request for any of this base's gates?
  if (!opened) {
    out.eligibleDemandUnits = a.enemies.filter((e) => a._isGateDemandUnit(e) && e.baseId === base.id).length;
    out.demandLedgerSize = a._gateDemand?.size ?? null;
    out.demandAgesMs = baseGates.map((gg) => Math.round(a._gateDemand.ageMs(gg.key, a.time.now)));
  }
  // Proof the leaves genuinely animated rather than snapping: distinct partial positions seen.
  out.partialFramesSeen = new Set(frames.flat().filter((f) => f > 0 && f < 1)).size;
  // What the demand ledger itself says about the gate that opened.
  if (opened) out.demandAgeMsAtOpen = Math.round(a._gateDemand.ageMs(opened.gate.key, a.time.now));
  a.px = parkedPx; a.py = parkedPy;

  if (!opened) { out.steps.push('NO GATE OPENED'); return out; }
  const g = opened.gate;
  const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;

  // 3. THE PLAYER CAN NOW GET IN through an open gate — the playtest's other change, measured on
  //    the real span before we shut it again for the seal sweep.
  out.playerBlockedAtOpenGateMouth = a._blocked(mx, my);        // expect false
  const dIn = Math.hypot(mx - c.x, my - c.y) || 1;
  const uxIn = (mx - c.x) / dIn, uyIn = (my - c.y) / dIn;
  out.playerCanDriveThroughOpenGate =
    !a._blockedAlongSegment(mx + uxIn * 30, my + uyIn * 30, mx - uxIn * 30, my - uyIn * 30);

  // 4. THE SEAL, live, with every gate SHUT. Sweep 720 bearings around the base centre, driving a
  // segment inward past the wall, using the PLAYER'S OWN movement query. This is the seal's
  // post-playtest meaning: a closed ring is impassable at every bearing, inbound and outbound.
  for (const gg of gates) if (!gg.destroyed) gg.open = false;
  let leaks = 0;
  for (let i = 0; i < 720; i++) {
    const th = (i / 720) * Math.PI * 2;
    for (const d of [300, 450, 5000]) {
      const fx = c.x + Math.cos(th) * d, fy = c.y + Math.sin(th) * d;
      if (!a._blockedAlongSegment(fx, fy, c.x, c.y)) leaks++;   // inbound
      if (!a._blockedAlongSegment(c.x, c.y, fx, fy)) leaks++;   // outbound
    }
  }
  out.sealLeaksWithGatesShut = leaks;
  out.anyGateOpenDuringSeal = gates.some((gg) => gg.open && !gg.destroyed);   // expect false

  // The pointed case: dead-on into the SHUT gate's mouth.
  const d0 = Math.hypot(mx - c.x, my - c.y) || 1;
  const ux = (mx - c.x) / d0, uy = (my - c.y) / d0;
  out.deadOnIntoShutGateBlocked = a._blockedAlongSegment(mx + ux * 400, my + uy * 400, c.x, c.y);
  out.playerBlockedAtShutGateMouth = a._blocked(mx, my);

  // 5. A real garrison unit gets out through an OPEN gate. Drive the actual collide-and-slide rule
  // frame by frame from the compound centre toward a point outside the gate.
  g.open = true;
  const target = { x: c.x + ux * 420, y: c.y + uy * 420 };
  let x = c.x, y = c.y, escaped = false;
  for (let f = 0; f < 500 && !escaped; f++) {
    const dd = Math.hypot(target.x - x, target.y - y) || 1;
    const vx = ((target.x - x) / dd) * 4, vy = ((target.y - y) / dd) * 4;
    let nx = x + vx, ny = y + vy;
    if (a._blocked(nx, ny)) {
      if (!a._blocked(x + vx, y)) ny = y;
      else if (!a._blocked(x, y + vy)) nx = x;
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
    if (a._blocked(nx, ny)) {
      if (!a._blocked(x2 + vx, y2)) ny = y2;
      else if (!a._blocked(x2, y2 + vy)) nx = x2;
      else { nx = x2; ny = y2; }
    }
    x2 = nx; y2 = ny;
    if (Math.hypot(x2 - c.x, y2 - c.y) > d0 + 30) escaped2 = true;
  }
  out.escapedWithGateShut = escaped2;

  // 6. ANTI-FLICKER, live. Restore the world to a normal fighting state — garrison alive, player
  // just outside the compound, gates driven entirely by real demand — and watch every gate on this
  // base for 30 real seconds, counting how many times each one changes state. A demand signal that
  // churns as units re-plan would show up here as a door hunting open/shut repeatedly; the grace
  // window, the reaction threshold, the minimum-open floor, and the re-open lockout should hold it
  // to a small handful of deliberate transitions.
  for (const gg of gates) if (!gg.destroyed) gg.open = false;
  a.px = c.x + 260; a.py = c.y;
  const prev = new Map(baseGates.map((gg) => [gg.key, gg.open]));
  const flips = new Map(baseGates.map((gg) => [gg.key, 0]));
  const tF = performance.now();
  while (performance.now() - tF < 30000) {
    await new Promise((r) => requestAnimationFrame(r));
    for (const gg of baseGates) {
      if (gg.open !== prev.get(gg.key)) { flips.set(gg.key, flips.get(gg.key) + 1); prev.set(gg.key, gg.open); }
    }
  }
  out.stateChangesPerGate_30s = [...flips.values()];
  out.maxStateChanges_30s = Math.max(0, ...flips.values());

  // ── 7. THE TANK CASE (playtest 2) ─────────────────────────────────────────────────────
  // Jackson: "I don't see the gates actually opening for the tanks when they seem to be wanting
  // it." Tanks are the population that matters most (most of a world's ground movers), and the
  // cause was that a demand search sharing the movement router's 400-node cap came back
  // `complete: false` for exactly these longer routes and silently registered nothing.
  //
  // So this measures the reported case head-on: find a base whose garrison actually contains
  // TANKS, stand where those tanks can reach, and confirm both that they register demand and that
  // their base's gate opens.
  const { isPassable: passable2 } = await import('/src/data/terrain.js');
  const tankBase = a.bases.find((b) => a.enemies.some(
    (e) => e.baseId === b.id && e.kind === 'tank' && a._isGateDemandUnit(e),
  ));
  out.foundBaseWithTankGarrison = !!tankBase;
  if (tankBase) {
    // Full reset of the gate subsystem, not just the `open` flags: clearing the flags alone leaves
    // each state machine still in its GATE_OPEN phase, so the next tick re-asserts `open` and the
    // episode measures 0ms every time. `_initGates` rebuilds the states, the demand ledger, and the
    // span flags together, which is the only clean starting line.
    a._initGates();
    a._wakeBase(tankBase.id);
    await new Promise((r) => requestAnimationFrame(r));
    const tc = hexToPixel(tankBase.center.q, tankBase.center.r);
    const tGates = gates.filter((g) => g.baseId === tankBase.id && !g.destroyed);
    out.tankGarrisonSize = a.enemies.filter(
      (e) => e.baseId === tankBase.id && e.kind === 'tank' && a._isGateDemandUnit(e),
    ).length;

    // Stand outside one of this base's own gates, on genuinely passable ground.
    let tSpot = null;
    for (const g of tGates) {
      const gmx = (g.x0 + g.x1) / 2, gmy = (g.y0 + g.y1) / 2;
      const dd = Math.hypot(gmx - tc.x, gmy - tc.y) || 1;
      const nx = (gmx - tc.x) / dd, ny = (gmy - tc.y) / dd;
      for (let d = 60; d <= 400; d += 20) {
        const x = gmx + nx * d, y = gmy + ny * d;
        const h = pixelToHex(x, y);
        if (passable2(a.terrain.get(axKey(h.q, h.r)))) { tSpot = { x, y }; break; }
      }
      if (tSpot) break;
    }
    if (tSpot) { a.px = tSpot.x; a.py = tSpot.y; }

    // Reset the scan counters so what we measure is this episode only.
    a._gateDemandStats = { scans: 0, searches: 0, complete: 0, incomplete: 0, noted: 0,
      nullGate: 0, eligible: 0, expandedTotal: 0, expandedMax: 0, byKind: {} };
    const tT0 = performance.now();
    let tankGateOpenedAt = null;
    while (performance.now() - tT0 < 15000 && tankGateOpenedAt === null) {
      await new Promise((r) => requestAnimationFrame(r));
      if (tGates.some((g) => g.open)) tankGateOpenedAt = Math.round(performance.now() - tT0);
    }
    out.tankGateOpenedAtMs = tankGateOpenedAt;
    const ts = a._gateDemandStats;
    out.tankDemandStats = ts.byKind.tank ?? null;
    // The specific failure mode being regression-tested: demand searches that fall short of the
    // goal. Under the 400-node cap this was ~25% of all searches; it should now be ~0.
    out.demandIncompleteRate = ts.searches ? +(ts.incomplete / ts.searches).toFixed(3) : null;
    out.demandExpandedPerSec = Math.round(ts.expandedTotal / ((performance.now() - tT0) / 1000));
  }
  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
