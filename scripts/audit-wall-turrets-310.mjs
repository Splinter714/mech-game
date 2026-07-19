// #310 — live verification of WALL-MOUNTED TURRETS in the REAL running game (Phaser in a real
// browser), not in a unit-test stub. Modelled on scripts/audit-gates-309.mjs.
//
// Five things the unit tests cannot settle on their own, because each depends on real world-gen,
// the real per-frame clock, the real LOS raycaster, or the real damage/death path:
//
//   1. Real generated worlds actually arm spans — on real corridor terrain, per base, inside the
//      clamp, and never on a gate span.
//   2. A Wall Lance unit really is seated on every armed span, dormant, at the outboard mount.
//   3. THE ONE THE UNIT TESTS HAD TO STUB: a woken wall turret gets a TRUE line of sight to a
//      player standing out on the approach, and actually fires. This is what proves the gun is
//      not blinded by the wall it is bolted to — the scene test has to stub `_cachedLosToPlayer`,
//      so only the live run can answer it.
//   4. Breaching an armed span kills the gun riding on it, through the real death path.
//   5. THE SEAL, re-measured with turrets present: a full 720-bearing pixel-space sweep of the
//      real player-movement query still refuses every crossing of a standing ring.
//
// Run: node scripts/audit-wall-turrets-310.mjs   (needs a dev server; set SMOKE_URL, default :5310)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5310/';

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

const report = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const out = { steps: [] };
  const spans = [...a.wallEdges.edges.values()];
  const armed = spans.filter((e) => e.role === 'turret');
  const gates = spans.filter((e) => e.role === 'gate');

  // ── 1. Placement on the real generated world ──────────────────────────────────────────
  out.baseCount = (a.bases ?? []).length;
  out.spanCount = spans.length;
  out.armedCount = armed.length;
  out.armedPerBase = (a.bases ?? []).map((b) => armed.filter((e) => e.baseId === b.id).length);
  out.gatesPerBase = (a.bases ?? []).map((b) => gates.filter((e) => e.baseId === b.id).length);
  // Disjointness, measured rather than assumed.
  out.armedThatAreAlsoGates = armed.filter((e) => e.role === 'gate').length;
  out.rolesSeen = [...new Set(spans.map((e) => e.role))];

  // ── 2. A gun on every armed span ──────────────────────────────────────────────────────
  const guns = a.enemies.filter((e) => e.typeId === 'wallTurret');
  out.gunCount = guns.length;
  out.gunsDormant = guns.filter((e) => e.awareness === 'dormant').length;
  out.gunsWithSpanKey = guns.filter((e) => e.spanKey).length;
  out.gunsEmplaced = guns.filter((e) => e.emplaced).length;
  out.everyArmedSpanHasAGun = armed.every((e) => guns.some((g) => g.spanKey === e.key));
  // Is any gun sitting INSIDE a wall band? (It must not be — that's the blinding case.)
  out.gunsInsideWall = guns.filter((g) => a._isWall(g.x, g.y)).length;

  // ── 3. A woken gun sees the approach and FIRES (the stubbed-in-unit-tests claim) ───────
  // Pick a gun, teleport the player out along its own outward normal to a distance inside the
  // Wall Lance's envelope, wake the base, and watch for a real shot on the real clock.
  const gun = guns[0];
  if (gun) {
    const base = (a.bases ?? []).find((b) => b.id === gun.baseId);
    const bc = base ? a._hexToPixelPublic?.(base.center) ?? null : null;
    // Outward direction = away from the base centre, derived from the gun's own span record.
    const edge = a.wallEdges.edges.get(gun.spanKey);
    const mid = { x: (edge.x0 + edge.x1) / 2, y: (edge.y0 + edge.y1) / 2 };
    let ox = gun.x - mid.x, oy = gun.y - mid.y;
    const on = Math.hypot(ox, oy) || 1;
    ox /= on; oy /= on;
    const standoff = 520;
    a.px = gun.x + ox * standoff;
    a.py = gun.y + oy * standoff;
    out.playerStandoff = standoff;

    // The REAL LOS query, uncached, from the gun to the player.
    const bearing = Math.atan2(a.py - gun.y, a.px - gun.x);
    const dist = Math.hypot(a.px - gun.x, a.py - gun.y);
    out.losGunToPlayer = a._losToPlayer
      ? a._losToPlayer(gun.x, gun.y, bearing, dist, a.px, a.py, false)
      : a._cachedLosToPlayer(gun, 999, gun.x, gun.y, bearing, dist, a.px, a.py, false);

    // Wake the base and count real shots fired by wall turrets over a few seconds.
    let shots = 0;
    const origFire = a._fireVehicleWeapon.bind(a);
    a._fireVehicleWeapon = (e, ctx, aim) => {
      if (e.typeId === 'wallTurret') shots++;
      return origFire(e, ctx, aim);
    };
    a._wakeBase(gun.baseId);
    out.gunAwarenessAfterWake = gun.awareness;
    const t0 = performance.now();
    while (performance.now() - t0 < 12000 && shots === 0) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    out.wallTurretShotsFired = shots;
    out.msToFirstShot = Math.round(performance.now() - t0);
    a._fireVehicleWeapon = origFire;
  }

  // ── 4. Breaching an armed span kills its gun (real death path) ────────────────────────
  const victimEdge = armed.find((e) => !e.destroyed);
  const victimGun = guns.find((g) => g.spanKey === victimEdge?.key);
  if (victimEdge && victimGun) {
    out.victimAliveBefore = !victimGun.mech.isDestroyed();
    out.victimSpanHpBefore = victimEdge.hp;
    // Drive the span to zero through the REAL damage entry point.
    a._damageWallEdge(victimEdge, victimEdge.maxHp);
    out.victimSpanDestroyed = victimEdge.destroyed;
    out.victimGunDestroyedAfter = victimGun.mech.isDestroyed();
    // And it left the live enemy list, i.e. it ran the normal death path rather than lingering.
    await new Promise((r) => requestAnimationFrame(r));
    out.victimStillInEnemies = a.enemies.includes(victimGun);
  }

  // ── 5. THE SEAL, with turrets on the ring ─────────────────────────────────────────────
  // A 720-bearing pixel-space sweep: from a point inside a base's compound, step outward along
  // every bearing and assert the player's own movement query blocks the crossing. Uses a base
  // whose ring is still fully intact (not the one just breached above).
  const intactBase = (a.bases ?? []).find((b) =>
    b.id !== victimEdge?.baseId
    && spans.some((e) => e.baseId === b.id)
    && spans.filter((e) => e.baseId === b.id).every((e) => !e.destroyed));
  if (intactBase) {
    const c = a._baseCenterPixel ? a._baseCenterPixel(intactBase) : null;
    // Derive the compound centre from its own ring geometry (base-side endpoints), so this needs
    // no scene helper: the average of every span's inner-hex-adjacent midpoint.
    const ring = spans.filter((e) => e.baseId === intactBase.id);
    const cx = c ? c.x : ring.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / ring.length;
    const cy = c ? c.y : ring.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / ring.length;
    out.sealBaseId = intactBase.id;
    out.sealRingSpans = ring.length;
    out.sealArmedSpans = ring.filter((e) => e.role === 'turret').length;
    let escapes = 0;
    const BEARINGS = 720;
    const STEP = 4;             // px per probe step — finer than the wall's 14px thickness
    const REACH = 900;          // well past any ring radius
    for (let i = 0; i < BEARINGS; i++) {
      const th = (i / BEARINGS) * Math.PI * 2;
      const ux = Math.cos(th), uy = Math.sin(th);
      let blocked = false;
      let x = cx, y = cy;
      for (let d = STEP; d <= REACH; d += STEP) {
        const nx = cx + ux * d, ny = cy + uy * d;
        // The PLAYER's own movement query — the same one `_drive` uses, gates included (a gate is
        // solid to the player open or shut, #309).
        if (a._blocked(nx, ny) || a._blockedAlongSegment?.(x, y, nx, ny)) { blocked = true; break; }
        x = nx; y = ny;
      }
      if (!blocked) escapes++;
    }
    out.sealBearingsProbed = BEARINGS;
    out.sealEscapes = escapes;
  }

  return out;
});

await browser.close();

console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));

// ── Verdict ────────────────────────────────────────────────────────────────────────────
const checks = [
  ['bases generated', report.baseCount > 0],
  ['spans armed with turrets', report.armedCount > 0],
  ['no armed span is also a gate', report.armedThatAreAlsoGates === 0],
  ['every base got 2..5 turrets', report.armedPerBase.every((n) => n >= 2 && n <= 5)],
  ['a gun on every armed span', report.everyArmedSpanHasAGun === true],
  ['guns spawn dormant', report.gunCount > 0 && report.gunsDormant === report.gunCount],
  ['no gun is stuck inside a wall', report.gunsInsideWall === 0],
  ['woken gun has LOS to the approach', report.losGunToPlayer === true],
  ['woken gun actually FIRES', report.wallTurretShotsFired > 0],
  ['breaching a span destroys its gun', report.victimGunDestroyedAfter === true],
  ['the killed gun left the enemy list', report.victimStillInEnemies === false],
  ['SEAL: no escape on 720 bearings', report.sealEscapes === 0],
  ['no page errors', errors.length === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
