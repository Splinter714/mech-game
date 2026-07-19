// #306: paired within-session A/B for the raycast line-of-sight shadow overlay.
//
// ── Why not scripts/profile-fight.mjs ──
// That profiler picks a RANDOM world seed per run. Across runs the enemy count ranged 42-219 and
// mean step cost swung 2.4-4.7ms in BOTH arms, so a before/after comparison between two invocations
// is pure noise — the between-run variance is an order of magnitude larger than the effect being
// measured. #306's first pass discovered this the hard way.
//
// ── The method ──
// ONE page, ONE world, ONE continuous fight. The feature is toggled on and off every second and
// step samples are bucketed by which arm was live when they were taken. Everything that varies
// between runs — terrain, base layout, enemy roster, GC state, thermal throttling — is therefore
// held identical across the two arms by construction, and the arms are interleaved so any drift
// over the session hits both equally. What's left is the feature.
//
// The player is driven in a continuous arc the whole time, deliberately: the shadow polygon is
// recomputed on MOVEMENT, so a parked player would measure the feature's idle cost (zero) rather
// than its real one. This is the worst case — per-frame re-sweeps, never a cache hit.
//
// It also parks the fight next to a BASE, because that is where the segment count peaks: #288's
// sealed wall rings plus the structures inside them are the densest blocker geometry in the game,
// and #308 raised the world to five bases.
//
// Usage: start a dev server, then `SMOKE_URL=http://localhost:PORT node scripts/profile-los-306.mjs`.
// Optional: PROFILE_SECONDS=60 (default 60, i.e. 30 seconds per arm).
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 60);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => {
    const g = window.__game;
    return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
  }, { timeout: 20000 });
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

  const setup = await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // Put the player right up against a base's wall ring — the densest blocker geometry in the
    // world. Positioned off a real standing SPAN rather than off the base's hex, so this can't
    // silently no-op and measure open ground (which is exactly what a first attempt did).
    const spans = [...(a.wallEdges?.edges?.values() ?? [])].filter((e) => !e.destroyed);
    if (spans.length) {
      // Centroid of the ring this span belongs to, then stand a little way outside it.
      const ring = spans.filter((e) => e.baseId === spans[0].baseId);
      const cx = ring.reduce((s, e) => s + e.x0, 0) / ring.length;
      const cy = ring.reduce((s, e) => s + e.y0, 0) / ring.length;
      const far = Math.max(...ring.map((e) => Math.hypot(e.x0 - cx, e.y0 - cy)));
      a.px = cx + far + 90; a.py = cy;
      window.__ringSpans = ring.length;
      window.__anchor = { x: a.px, y: a.py };
    }

    // The A/B switch. When OFF, the sweep and its fills are skipped entirely and the overlay is
    // cleared once — i.e. the arm measures the game exactly as it was before this feature.
    window.__losOn = true;
    const realSweep = a._updateShadowPolygon.bind(a);
    a._updateShadowPolygon = (view, radius) => {
      if (window.__losOn) return realSweep(view, radius);
      if (!a.__losCleared) { a.fogFx?.clear(); a.__losCleared = true; }
      a._shadowX = null;                       // force a re-sweep when the arm flips back on
      return undefined;
    };

    // Instrumentation: full engine step (prestep → postrender), bucketed by the live arm.
    const P = (window.__prof = { on: [], off: [], t0: 0, segs: [], frames: 0 });
    g.events.on('prestep', () => { P.t0 = performance.now(); });
    g.events.on('postrender', () => {
      const dt = performance.now() - P.t0;
      (window.__losOn ? P.on : P.off).push(dt);
      P.frames++;
      if (window.__losOn && a._shadowSegs != null) P.segs.push(a._shadowSegs);
    });

    // A close pack so there is a real fight running underneath the measurement.
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      a._spawnEnemy(a.px + Math.cos(ang) * 280, a.py + Math.sin(ang) * 280,
        ['raider', 'skirmisher', 'sniper', 'artillery'][i % 4]);
    }

    // Drive continuously in an arc, firing everything, so the sweep never gets a free frame.
    const origRead = a.controls.read.bind(a.controls);
    a.controls.read = () => {
      const intent = origRead();
      // Drive a tight continuous circle, so the mech stays inside the dense wall geometry instead
      // of wandering into open ground and quietly measuring nothing. NOTE the intent shape is
      // `move: {x, y}` (a direction vector) — an earlier version of this script set a non-existent
      // `throttle`/`turn` pair, the mech never moved, and the whole A/B silently measured the
      // PARKED cost of a feature that only recomputes on movement.
      const th = performance.now() / 900;
      intent.move = { x: Math.cos(th), y: Math.sin(th) };
      let best = null, bd = Infinity;
      for (const e of a.enemies) {
        if (e.mech.isDestroyed()) continue;
        const d = Math.hypot(e.x - a.px, e.y - a.py);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) intent.aim = { mode: 'pointer', x: best.x, y: best.y };
      for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) intent.fire[loc] = true;
      return intent;
    };

    // Keep the session alive for the whole window: no run end, no death, steady reinforcements.
    a._updateRun = () => {};
    window.__profTimers = [
      setInterval(() => a.mech.repairAll(), 400),
      // Re-anchor beside the ring every few seconds. Both arms get this identically, so it cannot
      // bias the comparison — it just stops the sample window drifting into open ground.
      setInterval(() => { if (window.__anchor) { a.px = window.__anchor.x; a.py = window.__anchor.y; } }, 3000),
      setInterval(() => { if (a.scene.isActive()) a._spawnEnemyDebug(); }, 3000),
    ];
    return { bases: (a.bases ?? []).length, wallSpans: a.wallEdges?.edges?.size ?? 0, ringSpans: window.__ringSpans ?? 0 };
  });

  console.log(`world: ${setup.bases} bases, ${setup.wallSpans} wall spans total, ${setup.ringSpans} in the ring under test`);
  console.log(`toggling every 1s for ${SECONDS}s (${SECONDS / 2}s per arm)\n`);

  for (let s = 1; s <= SECONDS; s++) {
    await page.waitForTimeout(1000);
    const row = await page.evaluate(() => {
      const g = window.__game;
      const a = g.scene.getScene('ArenaScene');
      window.__losOn = !window.__losOn;                 // flip AFTER sampling the second
      if (window.__losOn) a.__losCleared = false;
      const P = window.__prof;
      return {
        arm: window.__losOn ? 'off→on' : 'on→off',
        fps: Math.round(g.loop.actualFps * 10) / 10,
        enemies: a.enemies.filter((e) => !e.mech.isDestroyed()).length,
        segs: a._shadowSegs,
      };
    });
    if (s % 10 === 0) console.log(`  t=${s}s  fps=${row.fps}  alive=${row.enemies}  segments=${row.segs}`);
  }

  const res = await page.evaluate(() => {
    window.__profTimers?.forEach(clearInterval);
    const P = window.__prof;
    const stat = (xs) => {
      if (!xs.length) return { n: 0 };
      const s = [...xs].sort((a, b) => a - b);
      return {
        n: xs.length,
        mean: xs.reduce((a, b) => a + b, 0) / xs.length,
        median: s[Math.floor(s.length / 2)],
        p95: s[Math.floor(s.length * 0.95)],
      };
    };
    const segs = P.segs.length ? [...P.segs].sort((a, b) => a - b) : [0];
    return {
      on: stat(P.on), off: stat(P.off), frames: P.frames,
      segMedian: segs[Math.floor(segs.length / 2)], segMax: segs[segs.length - 1],
    };
  });

  const r3 = (n) => Math.round(n * 1000) / 1000;
  console.log('\nPAIRED A/B — engine step cost (prestep → postrender), same page/world/fight');
  console.log(`  ON   n=${res.on.n}  mean=${r3(res.on.mean)}ms  median=${r3(res.on.median)}ms  p95=${r3(res.on.p95)}ms`);
  console.log(`  OFF  n=${res.off.n}  mean=${r3(res.off.mean)}ms  median=${r3(res.off.median)}ms  p95=${r3(res.off.p95)}ms`);
  console.log(`  DELTA  mean ${r3(res.on.mean - res.off.mean)}ms   median ${r3(res.on.median - res.off.median)}ms   p95 ${r3(res.on.p95 - res.off.p95)}ms`);
  console.log(`  blocker segments near the base: median ${res.segMedian}, max ${res.segMax}`);
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
