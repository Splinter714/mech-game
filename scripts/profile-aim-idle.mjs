// Idle-aiming profiler (#86). Playtest feedback claimed turret aiming "feels choppy... like
// the frame rate is too slow." This isolates aiming from combat entirely: NO enemies, NO
// firing — just continuous driving + a fast circular aim sweep — to see whether raw FPS/
// frame-pacing is actually degraded during ordinary aiming, separate from the combat-churn
// issues already fixed in #71/#76.
//
// Each frame the aim point is swept in a full circle around the player at a fast angular
// rate (one full revolution roughly every ~1.2s, faster than any real player sustains, to
// stress-test dt handling) while also holding a forward move vector. Samples once per
// second: FPS, per-frame engine step CPU cost (avg + p95), and delta (ms) jitter between
// frames (min/max/stdev) to catch frame-pacing hiccups independent of FPS.
//
// Usage: start a dev server, then `SMOKE_URL=http://localhost:PORT node scripts/profile-aim-idle.mjs`.
// Optional: PROFILE_SECONDS=15 (default 15).

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 15);

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

  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('GarageScene');
    const mech = window.__game.registry.get('allMechs').mech1;
    // #188: centerTorso is no longer mountable — the four weapon slots are the whole build.
    sc.deploy();
  });
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

  await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // Instrumentation: engine-step CPU time + raw per-frame delta (ms), no combat FX at all
    // (no enemies spawned, no firing) so any FPS/pacing hit is isolated to drive+aim.
    const P = (window.__prof = { steps: [], deltas: [], t0: 0, tLast: performance.now() });
    g.events.on('prestep', () => { P.t0 = performance.now(); });
    g.events.on('postrender', () => {
      const now = performance.now();
      P.steps.push(now - P.t0);
      P.deltas.push(now - P.tLast);
      P.tLast = now;
    });

    // No enemies. Just drive forward-ish and sweep the aim fast in a circle — the exact
    // "idle aiming" scenario the playtest complaint describes, isolated from combat.
    P.startT = performance.now();
    const origRead = a.controls.read.bind(a.controls);
    a.controls.read = () => {
      const intent = origRead();
      const t = (performance.now() - P.startT) / 1000;
      const REV_S = 1.2; // seconds per full revolution — fast, stresses dt handling
      const ang = (t / REV_S) * Math.PI * 2;
      intent.move = { x: Math.cos(t * 0.6), y: Math.sin(t * 0.4) };
      intent.aim = { mode: 'pointer', x: a.px + Math.cos(ang) * 400, y: a.py + Math.sin(ang) * 400 };
      for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) intent.fire[loc] = false;
      return intent;
    };
    a._updateRun = () => {}; // don't let the run loop end mid-profile
  });

  const samples = [];
  for (let s = 1; s <= SECONDS; s++) {
    await page.waitForTimeout(1000);
    const row = await page.evaluate(() => {
      const g = window.__game;
      const P = window.__prof;
      const steps = P.steps; P.steps = [];
      const deltas = P.deltas; P.deltas = [];
      const avg = (xs) => xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0;
      const sorted = [...steps].sort((x, y) => x - y);
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      const dAvg = avg(deltas);
      const variance = deltas.length ? avg(deltas.map((d) => (d - dAvg) ** 2)) : 0;
      return {
        fps: Math.round(g.loop.actualFps * 10) / 10,
        stepMs: Math.round(avg(steps) * 100) / 100,
        p95StepMs: Math.round(p95 * 100) / 100,
        deltaMinMs: deltas.length ? Math.round(Math.min(...deltas) * 100) / 100 : 0,
        deltaMaxMs: deltas.length ? Math.round(Math.max(...deltas) * 100) / 100 : 0,
        deltaStdMs: Math.round(Math.sqrt(variance) * 100) / 100,
        frameCount: deltas.length,
      };
    });
    samples.push({ t: s, ...row });
    console.log(JSON.stringify({ t: s, ...row }));
  }

  const mean = (rows, k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 100) / 100;
  console.log('\nSUMMARY (mean across the whole idle-aiming run)');
  for (const k of ['fps', 'stepMs', 'p95StepMs', 'deltaMinMs', 'deltaMaxMs', 'deltaStdMs']) {
    console.log(`  ${k.padEnd(12)} ${mean(samples, k)}`);
  }
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
