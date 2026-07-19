// #320 — live verification, in the REAL running game, that wall collision now respects a unit's
// BODY radius and that a muzzle can no longer poke through a span to shoot over it.
//
// The unit tests argue geometry; this measures the actual arena — real generated bases, real wall
// rings, the real player movement integrator (`_drive`), the real muzzle math, the real router.
// It checks the fix AND the three things the fix could plausibly have broken:
//
//   1. Driving head-on into a wall face leaves NO visible overlap — the body stops against the
//      plate instead of burying ~21px of itself in it.
//   2. From as close as the game now allows, no weapon's muzzle sits on the far side of a span;
//      and if one ever did, `_muzzleWallBlocked` catches it.
//   3. A BREACHED span is still drivable through at the player's full body radius (#288).
//   4. An OPEN gate mouth (#309) still admits a full-radius body.
//   5. The seal holds: a 720-bearing sweep out of a base finds no crossing of an intact ring, and
//      every ring VERTEX — where two spans meet at 120° and the corner chamfer applies — is solid.
//   6. Routing agreement (#312): the waypoint the router hands each ground unit is physically
//      reachable at that unit's own radius, so nothing jams against geometry routing thinks is open.
//
// Run: node scripts/audit-wall-hitbox-320.mjs   (needs a dev server; set SMOKE_URL)
//
// TWO TRAPS, both paid for once already — please keep them in mind if you extend this:
//   • Keep every page.evaluate probe SYNCHRONOUS. An `await` inside one yields to the browser and
//     lets the scene's update() move the player between the lines that set a position and the
//     lines that measure it, silently corrupting the measurement.
//   • `_drive`'s intent.aim is a TAGGED UNION — `{ mode: 'pointer', x, y }` or
//     `{ mode: 'angle', angle }` (input/Controls.js). A bare `{ x, y }` takes the 'angle' branch,
//     reads `undefined`, and turns `turretAngle` into NaN, which silently freezes the mech one
//     frame in and makes every distance below meaningless.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5341/';

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

const report = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = { notes: [] };
  const R = 20;                                   // PLAYER_WALL_COLLIDE_RADIUS (shared.js)
  const HALF = 7;                                 // WALL_THICKNESS_PX / 2
  const STOP = R + HALF;                          // where a full-radius centre must halt
  const spans = [...a.wallEdges.edges.values()];
  const standing = () => spans.filter((e) => !e.destroyed);
  out.baseCount = (a.bases ?? []).length;
  out.spanCount = spans.length;

  const geom = (e) => {
    const ex = e.x1 - e.x0, ey = e.y1 - e.y0, L = Math.hypot(ex, ey);
    return { mx: (e.x0 + e.x1) / 2, my: (e.y0 + e.y1) / 2, nx: -ey / L, ny: ex / L, ax: ex / L, ay: ey / L };
  };
  const distToSpan = (e, x, y) => {
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - e.x0) * dx + (y - e.y0) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (e.x0 + dx * t), y - (e.y0 + dy * t));
  };
  const nearestStandingDist = (x, y) => {
    let m = Infinity;
    for (const e of standing()) m = Math.min(m, distToSpan(e, x, y));
    return m;
  };
  // Drive the REAL integrator toward a point, from a start, for up to `frames`.
  const driveToward = (sx, sy, dirx, diry, frames) => {
    a.px = sx; a.py = sy; a.vx = 0; a.vy = 0;
    a.turretAngle = Math.atan2(diry, dirx);
    const intent = {
      move: { x: dirx, y: diry },
      aim: { mode: 'angle', angle: Math.atan2(diry, dirx) },   // tagged union — see header
      fire: {}, slots: {}, mode: 'pad', dashPressed: false,
    };
    for (let i = 0; i < frames; i++) a._drive(intent, 1 / 60);
    return { x: a.px, y: a.py };
  };

  // ── 1. Head-on into a wall FACE.
  // Pick a span whose approach corridor is clear TERRAIN, so whatever stops the mech is
  // unambiguously the wall. Many spans back onto impassable base interior or water.
  let face = null;
  for (const e of standing()) {
    if (e.role === 'gate') continue;
    const g = geom(e);
    // Terrain must be passable from the launch point right up to the plate, on this side.
    let clean = true;
    for (let d = STOP - 2; d <= 150; d += 4) {
      if (!a._blocked(g.mx + g.nx * d, g.my + g.ny * d)) continue;
      // A block this close in must be the WALL itself, not terrain — check the terrain alone.
      const t = a._terrainAt(g.mx + g.nx * d, g.my + g.ny * d);
      if (d > HALF + 2) { clean = false; break; }
      void t;
    }
    if (clean) { face = { e, g }; break; }
  }
  if (!face) { out.notes.push('no span with a clean approach corridor found'); }
  else {
    const { e, g } = face;
    const end = driveToward(g.mx + g.nx * 150, g.my + g.ny * 150, -g.nx, -g.ny, 400);
    const d = distToSpan(e, end.x, end.y);
    out.headOn = {
      stopDist: +d.toFixed(2), need: STOP,
      moved: +Math.hypot(end.x - (g.mx + g.nx * 150), end.y - (g.my + g.ny * 150)).toFixed(1),
    };
    // Must have actually travelled (a frozen mech would "pass" trivially) and stopped clear.
    out.noVisibleOverlap = out.headOn.moved > 60 && d >= STOP - 1.5;
    out.oldOverlapPx = +(R - HALF).toFixed(1);

    // ── 2. From that stopped position, aim at the wall and check every muzzle.
    a.turretAngle = Math.atan2(-g.ny, -g.nx);
    const sideOf = (x, y) => Math.sign((x - g.mx) * g.nx + (y - g.my) * g.ny);
    const mechSide = sideOf(a.px, a.py);
    // The property that actually matters to the player is not "did the tip cross a line" but
    // "can a round get PAST the wall". A tip can sit beyond a span's infinite line yet be around
    // the END of that finite span, in open air — legitimately not blocked. So each muzzle is
    // judged two ways: the guard, and whether the outgoing ray is stopped by a standing span
    // anyway. A shot escapes only if NEITHER holds.
    const aimAng = Math.atan2(-g.ny, -g.nx);
    out.muzzles = a.mech.readyWeapons().map((w) => {
      const m = a._muzzle(w.location);
      const guard = !!a._muzzleWallBlocked(a.px, a.py, m.x, m.y);
      const far = { x: m.x + Math.cos(aimAng) * 400, y: m.y + Math.sin(aimAng) * 400 };
      const rayHit = a._wallEdgeHit ? a._wallEdgeHit(m.x, m.y, far.x, far.y) : null;
      return {
        loc: w.location,
        reach: +Math.hypot(m.x - a.px, m.y - a.py).toFixed(1),
        clearance: +distToSpan(e, m.x, m.y).toFixed(1),
        pastLine: sideOf(m.x, m.y) !== mechSide,
        guardBlocks: guard,
        rayStoppedByWall: !!rayHit,
        escapes: !guard && !rayHit,
      };
    });
    out.noShotEscapes = out.muzzles.every((m) => !m.escapes);
    out.anyMuzzlePastLine = out.muzzles.some((m) => m.pastLine);
    // Belt-and-braces: force the muzzle across by teleporting the centre onto the plate's face,
    // and confirm the guard fires. This is the case radius alone would not catch.
    a.px = g.mx + g.nx * 2; a.py = g.my + g.ny * 2;
    out.forcedGuard = a.mech.readyWeapons().map((w) => {
      const m = a._muzzle(w.location);
      return { loc: w.location, crossed: sideOf(m.x, m.y) !== 1, blocked: !!a._muzzleWallBlocked(a.px, a.py, m.x, m.y) };
    });
    out.forcedGuardHolds = out.forcedGuard.every((m) => !m.crossed || m.blocked);
  }

  // ── 5. The seal, on the real ring, BEFORE anything is breached.
  const base = a.bases[0];
  const bc = { x: base.x ?? 0, y: base.y ?? 0 };
  const ringSpans = standing().filter((e) => e.baseId === base.id);
  let escapes = 0;
  if (ringSpans.length) {
    let cx = 0, cy = 0;
    for (const e of ringSpans) { const g = geom(e); cx += g.mx; cy += g.my; }
    cx /= ringSpans.length; cy /= ringSpans.length;
    for (let i = 0; i < 720; i++) {
      const th = (i / 720) * Math.PI * 2;
      const ux = Math.cos(th), uy = Math.sin(th);
      let x = cx, y = cy, blocked = false;
      for (let d = 0; d < 300; d += 3) {
        const px = cx + ux * d, py = cy + uy * d;
        if (a._blockedAlongSegment(x, y, px, py, R)) { blocked = true; break; }
        x = px; y = py;
      }
      if (!blocked) escapes++;
    }
    void bc;
  }
  out.sealBearings = 720;
  out.sealEscapes = escapes;
  out.ringSpanCount = ringSpans.length;

  let vertexLeaks = 0;
  for (const e of standing()) {
    for (const [vx, vy] of [[e.x0, e.y0], [e.x1, e.y1]]) if (!a._blocked(vx, vy, R)) vertexLeaks++;
  }
  out.vertexLeaks = vertexLeaks;

  // ── 3+4, as WALL GEOMETRY over the WHOLE map rather than one sampled span.
  //
  // Why aggregate: the arena is randomly generated per run, and individual spans back onto docks,
  // turret emplacements and other impassable base interior. Sampling one span makes the result a
  // coin flip on map layout rather than a statement about the collision model. What #320 must
  // guarantee is the WALL half — that inflation never seals a hole — so this measures exactly
  // that, for every span on the map, with terrain deliberately out of scope (terrain behind a wall
  // was equally impassable before this change).
  //
  // The collision segment is reimplemented here rather than imported, so the probe is checking the
  // shipped geometry from the outside instead of trusting the same helper twice.
  const collideSeg = (e, radius) => {
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0, L = Math.hypot(dx, dy);
    const cut = Math.min(radius, L / 2);
    return { x0: e.x0 + (dx / L) * cut, y0: e.y0 + (dy / L) * cut, x1: e.x1 - (dx / L) * cut, y1: e.y1 - (dy / L) * cut };
  };
  const distToSeg = (s, x, y) => {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - s.x0) * dx + (y - s.y0) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (s.x0 + dx * t), y - (s.y0 + dy * t));
  };
  // Minimum wall clearance at a point, over every standing span except `skip`.
  const wallClearance = (x, y, radius, skip) => {
    let m = Infinity;
    for (const e of spans) {
      if (e === skip || e.destroyed) continue;
      if (e.role === 'gate' && e.open) continue;          // an open gate is a real opening
      m = Math.min(m, distToSeg(collideSeg(e, radius), x, y));
    }
    return m;
  };

  // 3. Breach EVERY span in turn and ask whether its hole admits a full-radius body.
  let breachTested = 0, breachSealed = 0, worstBreach = Infinity;
  const breachClearances = [];
  const breachFailures = [];
  for (const e of spans) {
    if (e.destroyed || e.role === 'gate') continue;
    const g = geom(e);
    breachTested++;
    // Sample straight through the hole; the pinch is at the midpoint but check either side too.
    let minC = Infinity;
    for (let d = -20; d <= 20; d += 2) minC = Math.min(minC, wallClearance(g.mx + g.nx * d, g.my + g.ny * d, R, e));
    worstBreach = Math.min(worstBreach, minC);
    breachClearances.push(minC);
    if (minC <= STOP) { breachSealed++; if (breachFailures.length < 5) breachFailures.push({ key: e.key, clearance: +minC.toFixed(1) }); }
  }
  breachClearances.sort((x, y) => x - y);
  const pct = (q) => +breachClearances[Math.min(breachClearances.length - 1, Math.floor(q * breachClearances.length))].toFixed(1);
  out.breachClearanceSpread = { min: pct(0), p10: pct(0.1), median: pct(0.5), p90: pct(0.9) };
  out.breachTested = breachTested;
  out.breachSealed = breachSealed;
  out.breachWorstClearance = +worstBreach.toFixed(1);
  out.breachNeeds = STOP;
  // For the report: the same number under NAIVE inflation (no corner chamfer), to show what the
  // chamfer is buying.
  let naiveWorst = Infinity, naiveSealed = 0;
  for (const e of spans) {
    if (e.destroyed || e.role === 'gate') continue;
    const g = geom(e);
    let minC = Infinity;
    for (const other of spans) {
      if (other === e || other.destroyed) continue;
      minC = Math.min(minC, distToSeg({ x0: other.x0, y0: other.y0, x1: other.x1, y1: other.y1 }, g.mx, g.my));
    }
    naiveWorst = Math.min(naiveWorst, minC);
    if (minC <= STOP) naiveSealed++;
  }
  out.naiveWouldSeal = naiveSealed;
  out.naiveWorstClearance = +naiveWorst.toFixed(1);

  // 4. Every GATE, opened, must admit a full-radius body through its mouth.
  const gates = spans.filter((e) => e.role === 'gate' && !e.destroyed);
  let gatesTested = 0, gatesTooTight = 0, worstGate = Infinity;
  for (const gt of gates) {
    const wasOpen = gt.open;
    gt.open = true;
    const g = geom(gt);
    gatesTested++;
    let minC = Infinity;
    for (let d = -20; d <= 20; d += 2) minC = Math.min(minC, wallClearance(g.mx + g.nx * d, g.my + g.ny * d, R, gt));
    worstGate = Math.min(worstGate, minC);
    if (minC <= STOP) gatesTooTight++;
    gt.open = wasOpen;
  }
  out.gates = { tested: gatesTested, tooTight: gatesTooTight, worstClearance: +worstGate.toFixed(1) };

  // ── 3b. And then actually DRIVE through one, with the real integrator, to prove the geometry
  // above corresponds to something a player can do. Pick a span whose hole is geometrically clear
  // AND whose terrain is passable on both sides, so a failure means the wall and not the map.
  let victim = null;
  for (const e of spans) {
    if (e.destroyed || e.role === 'gate') continue;
    const g = geom(e);
    if (a._blocked(g.mx - g.nx * 70, g.my - g.ny * 70) || a._blocked(g.mx + g.nx * 70, g.my + g.ny * 70)) continue;
    if (a._blocked(g.mx - g.nx * 40, g.my - g.ny * 40) || a._blocked(g.mx + g.nx * 40, g.my + g.ny * 40)) continue;
    victim = { e, g }; break;
  }
  if (!victim) out.notes.push('no span with clean terrain both sides — real drive-through not attempted on this map');
  else {
    const { e, g } = victim;
    e.hp = 0; e.destroyed = true;
    a._redrawWallEdges?.(); a._invalidateVisibility?.(); a._invalidateRoutes?.();
    out.breachMidpointFree = !a._blocked(g.mx, g.my, R);
    // The garrison is temporarily emptied so this measures the WALL and not a tank parked in the
    // gap — there are dozens of ground units on this map.
    const saved = a.enemies;
    a.enemies = [];
    const start = { x: g.mx + g.nx * 120, y: g.my + g.ny * 120 };
    const startSide = Math.sign((start.x - g.mx) * g.nx + (start.y - g.my) * g.ny);
    const end = driveToward(start.x, start.y, -g.nx, -g.ny, 600);
    a.enemies = saved;
    const endSide = Math.sign((end.x - g.mx) * g.nx + (end.y - g.my) * g.ny);
    out.breachDrive = {
      through: endSide !== startSide && Math.hypot(end.x - g.mx, end.y - g.my) > 30,
      finalOffset: +((end.x - g.mx) * g.nx + (end.y - g.my) * g.ny).toFixed(1),
      moved: +Math.hypot(end.x - start.x, end.y - start.y).toFixed(1),
    };
    // How FIDDLY is it? The straight-line clearance metric above is a conservative lower bound;
    // what the owner will actually feel is whether he can drive at the hole off-centre and at an
    // angle and still get through. Sweep both.
    // Run the sweep TWICE: once as shipped, once with the wall radius forced back to 0 (the old
    // point model) by intercepting the one query that carries it. Without that baseline a raw
    // success count is uninterpretable — some approach lines are obstructed by base terrain and
    // always were, and the only question #320 has to answer is whether inflation made it WORSE.
    const realBlocked = a._blockedAlongSegment.bind(a);
    const sweep = (forceRadius) => {
      a._blockedAlongSegment = (x0, y0, x1, y1, r = 0) =>
        realBlocked(x0, y0, x1, y1, forceRadius === null ? r : forceRadius);
      const res = [];
      for (const angDeg of [-30, -20, -10, 0, 10, 20, 30]) {
        for (const lateral of [-12, -6, 0, 6, 12]) {
          const th = (angDeg * Math.PI) / 180;
          const dx = g.nx * Math.cos(th) - g.ny * Math.sin(th);
          const dy = g.nx * Math.sin(th) + g.ny * Math.cos(th);
          const sx = g.mx + dx * 120 + g.ax * lateral, sy = g.my + dy * 120 + g.ay * lateral;
          const ss = Math.sign((sx - g.mx) * g.nx + (sy - g.my) * g.ny);
          const en = driveToward(sx, sy, -dx, -dy, 600);
          const es = Math.sign((en.x - g.mx) * g.nx + (en.y - g.my) * g.ny);
          res.push({ angDeg, lateral, through: es !== ss && Math.hypot(en.x - g.mx, en.y - g.my) > 30 });
        }
      }
      a._blockedAlongSegment = realBlocked;
      return res;
    };
    a.enemies = [];
    const shipped = sweep(null);
    const baseline = sweep(0);
    out.radiusSweep = [];
    for (const rr of [8, 12, 16, 18, 20, 22, 24, 28]) {
      const res = sweep(rr);
      out.radiusSweep.push({ r: rr, through: res.filter((t) => t.through).length, of: res.length });
    }
    a.enemies = saved;
    out.breachSweep = {
      total: shipped.length,
      shippedThrough: shipped.filter((t) => t.through).length,
      baselineThrough: baseline.filter((t) => t.through).length,
      lostVsBaseline: shipped.filter((t, i) => !t.through && baseline[i].through).map((t) => `${t.angDeg}deg/${t.lateral}px`),
    };
    const trials = [];
    a.enemies = [];
    for (const angDeg of [-30, -20, -10, 0, 10, 20, 30]) {
      for (const lateral of [-12, -6, 0, 6, 12]) {
        const th = (angDeg * Math.PI) / 180;
        const dx = g.nx * Math.cos(th) - g.ny * Math.sin(th);
        const dy = g.nx * Math.sin(th) + g.ny * Math.cos(th);
        const sx = g.mx + dx * 120 + g.ax * lateral, sy = g.my + dy * 120 + g.ay * lateral;
        const ss = Math.sign((sx - g.mx) * g.nx + (sy - g.my) * g.ny);
        const en = driveToward(sx, sy, -dx, -dy, 600);
        const es = Math.sign((en.x - g.mx) * g.nx + (en.y - g.my) * g.ny);
        trials.push({ angDeg, lateral, through: es !== ss && Math.hypot(en.x - g.mx, en.y - g.my) > 30 });
      }
    }
    a.enemies = saved;
    out.breachTrials = { total: trials.length, through: trials.filter((t) => t.through).length,
      failed: trials.filter((t) => !t.through).map((t) => `${t.angDeg}deg/${t.lateral}px`) };
  }

  // ── 6. Routing agreement (#312). Ask the real router for each ground unit's next waypoint and
  // check it is reachable at that unit's own radius.
  let checked = 0, unreachable = 0;
  const ground = (a.enemies ?? []).filter((e) => !e.flying && !e.mech.isDestroyed());
  for (const e of ground) {
    let wp = null;
    try {
      wp = a._router().follow(e, e.x, e.y, { x: a.px, y: a.py }, a.time?.now ?? 0, a._routeCtx());
    } catch (err) { void err; continue; }
    if (!wp) continue;
    checked++;
    const r = Math.min(20, e.kind === 'mech' || e.kind === undefined ? 28 : 24 * (e.kindDef?.scale ?? 1));
    if (a._blocked(wp.x, wp.y, r)) unreachable++;
  }
  out.routeWaypointsChecked = checked;
  out.routeWaypointsUnreachable = unreachable;
  out.groundUnits = ground.length;

  return out;
});

await browser.close();

const ok = [], bad = [], warn = [];
const chk = (cond, msg) => (cond ? ok : bad).push(msg);

console.log('\n#320 — wall hitbox, live in the real game\n' + '='.repeat(72));
console.log(`bases: ${report.baseCount}   wall spans: ${report.spanCount}   ground units: ${report.groundUnits}`);
for (const n of report.notes) warn.push(n);

console.log('\n1. BODY RADIUS AT A WALL FACE');
if (report.headOn) {
  console.log(`  drove ${report.headOn.moved}px and stopped ${report.headOn.stopDist}px from the centreline (need >= ${report.headOn.need})`);
  console.log(`  under the old point model the body buried ${report.oldOverlapPx}px of itself in the plate`);
  chk(report.noVisibleOverlap, 'a mech driven head-on stops with its body against the plate, not inside it');
} else warn.push('head-on probe skipped');

console.log('\n2. MUZZLE / SHOT ORIGIN');
for (const m of report.muzzles ?? []) console.log(`  ${m.loc.padEnd(11)} reach ${String(m.reach).padStart(5)}px  clearance ${String(m.clearance).padStart(5)}px  pastLine=${m.pastLine}  guard=${m.guardBlocks}  rayHitsWall=${m.rayStoppedByWall}  ESCAPES=${m.escapes}`);
console.log(`  any muzzle past the span's line at the closest legal stance: ${report.anyMuzzlePastLine}`);
console.log(`  forced-across guard check: ${JSON.stringify(report.forcedGuard)}`);
chk(report.noShotEscapes !== false, 'no shot can get past a standing span from point-blank range');
chk(report.forcedGuardHolds !== false, 'the guard catches a muzzle forced across a plate');

console.log('\n3. BREACH — does a hole stay open at full body radius? (#288 must not regress)');
console.log(`  spans breach-tested: ${report.breachTested}   holes too tight for a full-radius body: ${report.breachSealed}`);
console.log(`  worst hole clearance: ${report.breachWorstClearance}px  (a full-radius body needs > ${report.breachNeeds}px)`);
console.log(`  hole clearance spread across all spans: ${JSON.stringify(report.breachClearanceSpread)}`);
console.log(`  for contrast, NAIVE inflation with no corner chamfer would seal ${report.naiveWouldSeal}/${report.breachTested} of them (worst ${report.naiveWorstClearance}px)`);
chk(report.breachSealed === 0, 'every breachable span leaves a hole a full-radius body fits through');
if (report.breachDrive) {
  console.log(`  real drive-through: ${JSON.stringify(report.breachDrive)}   hole midpoint free: ${report.breachMidpointFree}`);
  chk(report.breachDrive.through, 'the player actually drove through a real breach, full radius');
  const sw = report.breachSweep;
  console.log(`  approach sweep (7 angles x 5 lateral offsets), as shipped: ${sw.shippedThrough}/${sw.total} through`);
  console.log(`  same sweep with the OLD point model:                      ${sw.baselineThrough}/${sw.total} through`);
  console.log(`  approaches lost purely to inflation: ${sw.lostVsBaseline.length ? sw.lostVsBaseline.join(', ') : 'none'}`);
  if (report.radiusSweep) console.log(`  through-rate by wall radius: ${report.radiusSweep.map((x) => `R${x.r}=${x.through}/${x.of}`).join('  ')}`);
  // DIAGNOSTIC, not a pass/fail. A wall that stops your body instead of your centre must cost
  // SOMETHING at a 48px hole, and how much depends heavily on what the randomly-generated map put
  // NEXT to the breached span — measured across runs this sits at 31/35 on an ordinary stretch of
  // ring and drops to ~17/35 where the span backs onto other structures (whose own baseline is
  // already degraded, 31/35 rather than 35/35). The stable invariant is the geometric one checked
  // above: no span's hole is ever too tight for a full-radius body. This number is the feel, and
  // the dial for it is shared.js `WALL_COLLIDE_RADIUS_MAX`, which carries the measured table.
  warn.push(`breach approach feel: ${sw.shippedThrough}/${sw.total} shipped vs ${sw.baselineThrough}/${sw.total} under the old point model (map-dependent — diagnostic only)`);
} else warn.push('real drive-through not attempted (no span with clean terrain both sides on this map)');

console.log('\n4. OPEN GATE MOUTHS (#309)');
console.log(`  gates tested: ${report.gates.tested}   too tight for a full-radius body: ${report.gates.tooTight}   worst clearance ${report.gates.worstClearance}px`);
chk(report.gates.tooTight === 0, 'every open gate mouth admits a full-radius body');

console.log('\n5. THE SEAL');
console.log(`  ring spans: ${report.ringSpanCount}   bearings: ${report.sealBearings}   escapes: ${report.sealEscapes}`);
console.log(`  ring vertices unsealed: ${report.vertexLeaks}`);
chk(report.sealEscapes === 0, 'no bearing crosses an intact ring at full body radius');
chk(report.vertexLeaks === 0, 'every ring vertex is still solid');

console.log('\n6. ROUTING AGREEMENT (#312)');
console.log(`  router waypoints checked: ${report.routeWaypointsChecked}   unreachable at own radius: ${report.routeWaypointsUnreachable}`);
chk(report.routeWaypointsUnreachable === 0, 'no routed waypoint is untraversable at the unit\'s own radius');

console.log('\n' + '='.repeat(72));
for (const m of ok) console.log(`  PASS  ${m}`);
for (const m of warn) console.log(`  NOTE  ${m}`);
for (const m of bad) console.log(`  FAIL  ${m}`);
if (errors.length) { console.log('\npage errors:'); for (const e of errors.slice(0, 10)) console.log('  ' + e); }
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(bad.length || errors.length ? 1 : 0);
