// Headless CPU profiler (#148). Boots the real game like scripts/smoke.mjs, deploys into
// the arena, stages a HEAVY swarm-scale fight (the default squad + a drone swarm + an
// infantry mob + extra mechs, with the player's fire buttons held), then captures a real
// V8 CPU profile via CDP (Chrome DevTools Protocol) for PROFILE_SECONDS. Alongside the
// sampled profile it wraps every per-frame mixin entry point with performance.now()
// accumulators, so the two views (sampled hot functions vs. per-mixin wall time) can be
// reconciled.
//
// Usage: start a dev server, then
//   SMOKE_URL=http://localhost:PORT node scripts/profile-cpu.mjs
// Optional env: PROFILE_SECONDS=15, PROFILE_RAW=out.cpuprofile (dump the raw profile).
//
// Caveat: headless Chromium renders WebGL through SwiftShader (software), so GPU-side
// costs are exaggerated vs. real hardware. The default run therefore uses the same
// `?canvas` renderer the smoke test uses; JS-side game logic costs are renderer-agnostic.

import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 15);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const log = (m) => process.stderr.write(`[profile-cpu] ${m}\n`);

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  log(`loaded ${URL}`);
  await page.waitForFunction(() => {
    const g = window.__game;
    return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
  }, { timeout: 20000 });

  // Complete the build if needed, then deploy into the arena.
  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('GarageScene');
    const mech = window.__game.registry.get('allMechs').mech1;
    if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
    sc.deploy();
  });
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 60000 });
  log('arena active');
  await page.waitForTimeout(500);

  // Stage the fight + install per-mixin instrumentation.
  await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // Swarm-scale opposition, close enough that everything engages at once: the default squad
    // already spawned in create(); add a drone swarm (~18), an infantry mob (~40), a couple of
    // extra mechs and a broodwalker so per-enemy costs dominate.
    a._spawnEnemy(a.px + 420, a.py, 'swarm');
    a._spawnEnemy(a.px - 420, a.py, 'infantryMob');
    a._spawnEnemy(a.px, a.py - 420, 'quadruped');
    a._spawnEnemy(a.px + 300, a.py + 300, 'raider');
    a._spawnEnemy(a.px - 300, a.py + 300, 'artillery');
    // Wake everyone up so the full AI path runs (not the idle path).
    for (const e of a.enemies) e.awareness = 'aware';

    // Hold four fire buttons and aim at the nearest living enemy, every frame.
    const origRead = a.controls.read.bind(a.controls);
    a.controls.read = () => {
      const intent = origRead();
      let best = null, bd = Infinity;
      for (const e of a.enemies) {
        if (e.mech.isDestroyed()) continue;
        const d = Math.hypot(e.x - a.px, e.y - a.py);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) intent.aim = { mode: 'pointer', x: best.x, y: best.y };
      for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) intent.fire[loc] = true;
      intent.move = { x: Math.sin(performance.now() / 900), y: Math.cos(performance.now() / 1300) };
      return intent;
    };

    // Keep the fight alive for the whole window: no run end, periodic repair, reinforcements.
    a._updateRun = () => {};
    window.__profTimers = [
      setInterval(() => a.mech.repairAll(), 400),
      setInterval(() => { if (a.scene.isActive()) a._spawnEnemyDebug(); }, 2500),
    ];

    // Per-mixin wall-time accumulators (ms) + engine-step / render split.
    const M = (window.__mix = { frames: 0, total: {}, stepMs: 0, renderMs: 0 });
    const wrap = (name) => {
      const fn = a[name].bind(a);
      M.total[name] = 0;
      a[name] = (...args) => {
        const t0 = performance.now();
        const r = fn(...args);
        M.total[name] += performance.now() - t0;
        return r;
      };
    };
    for (const name of [
      '_refreshBuffMods', '_drive', '_updateLock', '_stepGait', '_handleFiring',
      '_handleAbilities', '_updateEnemies', '_updateProjectiles', '_updateFirePatches',
      '_updateBeams', '_updatePowerups', '_updateSalvage', '_updateMission', '_drawAimLine',
    ]) wrap(name);
    let t0 = 0, tr = 0;
    g.events.on('prestep', () => { t0 = performance.now(); M.frames++; });
    g.events.on('prerender', () => { tr = performance.now(); });
    g.events.on('postrender', () => {
      const t1 = performance.now();
      M.stepMs += t1 - t0; M.renderMs += t1 - tr;
    });
  });

  log('fight staged');
  // Let the fight spin up, then capture the CPU profile.
  await page.waitForTimeout(1500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await page.evaluate(() => {
    const M = window.__mix;
    M.frames = 0; M.stepMs = 0; M.renderMs = 0;
    for (const k of Object.keys(M.total)) M.total[k] = 0;
  });
  await cdp.send('Profiler.start');
  log('profiler started');
  await page.waitForTimeout(SECONDS * 1000);
  log('stopping profiler');
  const { profile } = await cdp.send('Profiler.stop');
  log(`profiler stopped (${profile.samples.length} samples)`);

  const state = await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');
    window.__profTimers?.forEach(clearInterval);
    return {
      mix: window.__mix,
      fps: Math.round(g.loop.actualFps * 10) / 10,
      children: a.children.list.length,
      enemies: a.enemies.length,
      projectiles: a.projectiles.length,
      tweens: a.tweens.getTweens().length,
      textures: Object.keys(g.textures.list).length,
    };
  });

  if (process.env.PROFILE_RAW) writeFileSync(process.env.PROFILE_RAW, JSON.stringify(profile));

  // ── Analyze: self time per function, grouped by function+file. ──
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfMicros = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    selfMicros.set(id, (selfMicros.get(id) || 0) + profile.timeDeltas[i]);
  }
  const rows = [];
  for (const [id, us] of selfMicros) {
    const n = nodes.get(id);
    if (!n) continue;
    const f = n.callFrame;
    const file = (f.url || '').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
    rows.push({ fn: f.functionName || '(anonymous)', file, ms: us / 1000 });
  }
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.fn} @ ${r.file}`;
    byKey.set(key, (byKey.get(key) || 0) + r.ms);
  }
  const totalMs = [...byKey.values()].reduce((a, b) => a + b, 0);
  const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

  console.log(`\nProfiled ${SECONDS}s of swarm combat @ ${URL}`);
  console.log(`End state: fps=${state.fps} enemies=${state.enemies} projectiles=${state.projectiles} ` +
    `displayListChildren=${state.children} tweens=${state.tweens} textures=${state.textures}`);
  const M = state.mix;
  console.log(`\nEngine step avg ${(M.stepMs / M.frames).toFixed(2)}ms/frame — of which render ` +
    `${(M.renderMs / M.frames).toFixed(2)}ms, game logic ${((M.stepMs - M.renderMs) / M.frames).toFixed(2)}ms (${M.frames} frames)`);
  console.log('\nPer-mixin wall time (ms/frame):');
  const mixRows = Object.entries(M.total).sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of mixRows) {
    console.log(`  ${name.padEnd(22)} ${(ms / M.frames).toFixed(3)}`);
  }
  console.log(`\nTop functions by SELF time (sampled ${Math.round(totalMs)}ms total):`);
  for (const [key, ms] of top) {
    const pct = ((ms / totalMs) * 100).toFixed(1).padStart(5);
    console.log(`  ${pct}%  ${Math.round(ms).toString().padStart(6)}ms  ${key}`);
  }
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
