// #310 — MEASURING the difficulty added to a base approach, rather than guessing at it. The issue
// asked for a read on whether base assaults are becoming overloaded (#316 having just removed the
// flying-cover exemptions), so this walks a real player position in from far out toward a real
// generated base and, at each range band, counts how many wall turrets ACTUALLY have a firing
// solution — in range AND with a true line of sight from the live raycaster.
//
// The number that matters is not "how many guns are on the ring" (21 across five bases) but "how
// many can shoot me at once", which the guns' own walls limit sharply.
//
// Run: node scripts/audit-wall-turret-difficulty-310.mjs   (dev server; SMOKE_URL, default :5310)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5310/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
  const guns = a.enemies.filter((e) => e.typeId === 'wallTurret');
  const fireRange = guns[0]?.kindDef?.fireRange ?? 900;
  const out = { fireRange, totalGuns: guns.length, bands: [] };

  // Wake everything, so this measures the worst case (a fully alerted map).
  for (const b of a.bases ?? []) a._wakeBase(b.id);

  const canEngage = (g, px, py) => {
    if (g.mech.isDestroyed()) return false;
    const dist = Math.hypot(px - g.x, py - g.y);
    if (dist >= fireRange) return false;
    const bearing = Math.atan2(py - g.y, px - g.x);
    // The exact, UNCACHED primitive `_cachedLosToPlayer` is built on — a clear lane means the
    // wall raycast found no blocker before the target. #310 (2026-07-19): `g.spanKey` is what the
    // live cached path now passes, so the audit must pass it too or it measures the OLD outboard
    // behaviour (the gun blinded by the span it is bolted to) rather than what ships.
    return a._wallDistanceLos(g.x, g.y, bearing, dist, px, py, false, g.spanKey ?? null) === Infinity;
  };

  // Approach a real base along many bearings, sampling range bands. For each (bearing, band) we
  // count guns that can engage; we report the worst case and the average across bearings, which
  // together say how punishing a typical vs. an unlucky approach is.
  const base = (a.bases ?? [])[0];
  const ring = [...a.wallEdges.edges.values()].filter((e) => e.baseId === base.id);
  const cx = ring.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / ring.length;
  const cy = ring.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / ring.length;

  // #310 (2026-07-19, centred mounts): the inner bands are the point of the change. The ring's
  // own radius is ~120-160px, so 100/60/0 are positions INSIDE the compound — where the old
  // outboard mounts left the player with zero guns bearing, a genuine reprieve the owner removed.
  for (const band of [800, 650, 500, 350, 220, 120, 100, 60, 0]) {
    const counts = [];
    for (let i = 0; i < 72; i++) {
      const th = (i / 72) * Math.PI * 2;
      const px = band === 0 ? cx : cx + Math.cos(th) * band;
      const py = band === 0 ? cy : cy + Math.sin(th) * band;
      if (a._blocked(px, py)) continue;          // don't sample inside terrain/walls
      counts.push(guns.filter((g) => canEngage(g, px, py)).length);
      if (band === 0) break;                     // one sample is the whole story at the centre
    }
    if (!counts.length) continue;
    counts.sort((x, y) => x - y);
    out.bands.push({
      rangeFromCentre: band,
      samples: counts.length,
      worst: counts[counts.length - 1],
      median: counts[Math.floor(counts.length / 2)],
      mean: +(counts.reduce((s, n) => s + n, 0) / counts.length).toFixed(2),
      zeroGunHeadings: counts.filter((n) => n === 0).length,
    });
  }
  // ── Can the player still SHOOT a wall gun directly? ─────────────────────────────────────
  // The consequence of centring that nothing asked for: the gun now sits on the span's centreline,
  // and both the projectile path and the hitscan path test the wall BEFORE the target. If the wall
  // always wins, the only way to silence a gun is to grind its 200hp span down — a 4x jump in what
  // a gun costs to remove. Measured, not reasoned about, because the answer turns on hit radii and
  // per-step ordering. Fires the REAL player fire path at a real gun from both sides.
  // Fire the REAL player hitscan path at real wall guns from both sides, close in, and see
  // whether the gun's own HP actually moves. `_fireHitscan` is called TWICE per position: the
  // first call of a synthetic burst primes `_liveEnemiesForTrace`'s per-frame cache, which has not
  // been rebuilt since the scene last ticked, so a single cold shot reports a false negative.
  const beam = a.mech.readyWeapons().find((x) => x.weapon.delivery.hit === 'hitscan')
    ?? a.mech.readyWeapons()[0];
  out.directFire = { weapon: beam?.weapon?.id ?? null, probes: [] };
  for (const gun of guns.slice(0, 4)) {
    if (gun.mech.isDestroyed() || !beam) continue;
    const span = a.wallEdges.edges.get(gun.spanKey);
    const ring = [...a.wallEdges.edges.values()].filter((e) => e.baseId === gun.baseId);
    const rx = ring.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / ring.length;
    const ry = ring.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / ring.length;
    const sx = (span.x0 + span.x1) / 2, sy = (span.y0 + span.y1) / 2;
    const ux = sx - rx, uy = sy - ry, ul = Math.hypot(ux, uy) || 1;
    for (const [label, sign] of [['from INSIDE the compound', -1], ['from OUTSIDE the ring', 1]]) {
      if (gun.mech.isDestroyed()) continue;
      const fx = sx + (ux / ul) * 40 * sign, fy = sy + (uy / ul) * 40 * sign;
      const ang = Math.atan2(gun.y - fy, gun.x - fx);
      const hpBefore = gun.mech.hp, spanBefore = span.hp;
      for (let i = 0; i < 2; i++) {
        a._fireHitscan({ weapon: beam.weapon, location: 'rightArm', index: 0 }, fx, fy, ang, 'player', 'player', false, {});
      }
      out.directFire.probes.push({
        span: gun.spanKey, label, hpBefore, hpAfter: gun.mech.hp,
        gunDamaged: gun.mech.hp < hpBefore, spanUntouched: span.hp === spanBefore,
      });
    }
  }

  // #287: no interior turret bunkers anywhere on the map, and no stale terrain id.
  out.interiorTurretHexes = [...a.terrain.values()].filter((id) => id === 'turretEmplacement' || id === 'turretRubble').length;
  out.interiorTurretUnits = a.enemies.filter((e) => e.typeId === 'turret' && e.baseId).length;

  return out;
});

await browser.close();
console.log(JSON.stringify(report, null, 2));

// Per-gun DPS is damage / cycleTime; the ring's pressure is that times "guns that can bear".
const worst = Math.max(...report.bands.map((b) => b.worst));
const meanPeak = Math.max(...report.bands.map((b) => b.mean));
console.log(`\nWorst-case guns bearing at once: ${worst}`);
console.log(`Highest mean guns bearing (any band): ${meanPeak}`);
console.log(`Rail lance 52.8 dmg / 5.2s = ~10.2 dps per gun`);
console.log(`=> worst-case sustained ~${(worst * 10.15).toFixed(0)} dps, typical ~${(meanPeak * 10.15).toFixed(0)} dps (player toughness ~600)`);

// #310 (2026-07-19) — the two claims the centring rests on, stated as pass/fail rather than left
// for a reader to infer from the band table.
const inner = report.bands.filter((b) => b.rangeFromCentre <= 120);
console.log(`\nInside the compound (<=120px from centre): mean ${Math.min(...inner.map((b) => b.mean))}-${Math.max(...inner.map((b) => b.mean))} guns bear`);
console.log(`  (before centring this was ZERO — a breaching player was safe from every wall gun)`);
const dmg = report.directFire?.probes ?? [];
console.log(`Gun still directly shootable: ${dmg.filter((p) => p.gunDamaged).length}/${dmg.length} probes, span untouched in ${dmg.filter((p) => p.spanUntouched).length}`);
console.log(`Interior turret hexes / units remaining (#287): ${report.interiorTurretHexes} / ${report.interiorTurretUnits}`);
