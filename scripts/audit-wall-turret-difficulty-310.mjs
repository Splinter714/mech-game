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
    // wall raycast found no blocker before the target.
    return a._wallDistanceLos(g.x, g.y, bearing, dist, px, py, false) === Infinity;
  };

  // Approach a real base along many bearings, sampling range bands. For each (bearing, band) we
  // count guns that can engage; we report the worst case and the average across bearings, which
  // together say how punishing a typical vs. an unlucky approach is.
  const base = (a.bases ?? [])[0];
  const ring = [...a.wallEdges.edges.values()].filter((e) => e.baseId === base.id);
  const cx = ring.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / ring.length;
  const cy = ring.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / ring.length;

  for (const band of [800, 650, 500, 350, 220, 120]) {
    const counts = [];
    for (let i = 0; i < 72; i++) {
      const th = (i / 72) * Math.PI * 2;
      const px = cx + Math.cos(th) * band, py = cy + Math.sin(th) * band;
      if (a._blocked(px, py)) continue;          // don't sample inside terrain/walls
      counts.push(guns.filter((g) => canEngage(g, px, py)).length);
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
