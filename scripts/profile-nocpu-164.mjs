// #164 follow-up: CDP Profiler.stop() reliably hangs forever in this environment as soon as
// the player fires all 4 weapon slots concurrently (confirmed via isolated repro — see PR/issue
// comment). This variant reuses the same staged scenario + in-page wrap() instrumentation as
// profile-cpu-164.mjs but skips the CDP CPU profiler entirely, relying only on the
// performance.now() timers already installed around each ArenaScene per-frame mixin method.
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 20);
const RAMP_SECONDS = Number(process.env.RAMP_SECONDS || 20);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const log = (m) => process.stderr.write(`[profile-nocpu-164] ${m}\n`);

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  log(`loaded ${URL}`);
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
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 60000 });
  log('arena active');
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    a._spawnEnemy(a.px + 420, a.py, 'swarm');
    a._spawnEnemy(a.px - 420, a.py, 'swarm');
    a._spawnEnemy(a.px, a.py - 420, 'infantryMob');
    a._spawnEnemy(a.px + 500, a.py - 200, 'carrier');
    a._spawnEnemy(a.px - 500, a.py - 200, 'carrier');
    a._spawnEnemy(a.px + 200, a.py + 500, 'carrier');
    a._spawnEnemy(a.px - 200, a.py + 500, 'carrier');
    a._spawnEnemy(a.px + 300, a.py + 300, 'raider');
    a._spawnEnemy(a.px - 300, a.py + 300, 'artillery');
    a._spawnEnemy(a.px + 300, a.py - 300, 'sniper');
    for (const e of a.enemies) e.awareness = 'aware';

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
      const t = performance.now();
      const ang = Math.sin(t / 650) * Math.PI * 2 + Math.cos(t / 400);
      intent.move = { x: Math.cos(ang), y: Math.sin(ang) };
      return intent;
    };

    a._updateRun = () => {};
    const reinforceKinds = ['raider', 'tank', 'skirmisher', 'helicopter', 'sniper', 'turretNest',
      'artillery', 'swarm', 'infantryMob', 'carrier', 'carrier'];
    let seq = 0;
    window.__profTimers = [
      setInterval(() => a.mech.repairAll(), 400),
      setInterval(() => {
        if (!a.scene.isActive()) return;
        const kind = reinforceKinds[seq++ % reinforceKinds.length];
        const p = a._offscreenSpawnPoint();
        const e = a._spawnEnemy(p.x, p.y, kind);
        if (e) e.awareness = 'aware';
      }, 1800),
    ];

    const M = (window.__mix = { frames: 0, total: {}, calls: {}, stepMs: 0, renderMs: 0, fpsSamples: [] });
    const wrap = (name) => {
      const fn = a[name].bind(a);
      M.total[name] = 0; M.calls[name] = 0;
      a[name] = (...args) => {
        const t0 = performance.now();
        const r = fn(...args);
        M.total[name] += performance.now() - t0;
        M.calls[name]++;
        return r;
      };
    };
    for (const name of [
      '_refreshBuffMods', '_drive', '_updateLock', '_stepGait', '_handleFiring',
      '_handleAbilities', '_updateEnemies', '_updateProjectiles', '_updateFirePatches',
      '_updateBeams', '_updatePowerups', '_updateSalvage', '_updateMission', '_drawAimLine',
      '_blockedAlongSegment', '_wallDistance', '_blockedByGroundEnemy', '_crushTargetAt',
    ]) wrap(name);
    let t0 = 0, tr = 0;
    g.events.on('prestep', () => { t0 = performance.now(); M.frames++; });
    g.events.on('prerender', () => { tr = performance.now(); });
    g.events.on('postrender', () => {
      const t1 = performance.now();
      M.stepMs += t1 - t0; M.renderMs += t1 - tr;
      M.fpsSamples.push(g.loop.actualFps);
    });
  });

  log(`fight staged; ramping ${RAMP_SECONDS}s`);
  const rampMs = RAMP_SECONDS * 1000;
  const rampStep = 2000;
  for (let waited = 0; waited < rampMs; waited += rampStep) {
    await page.waitForTimeout(Math.min(rampStep, rampMs - waited));
    const n = await page.evaluate(() => window.__game.scene.getScene('ArenaScene').enemies.length);
    log(`  ramp t+${Math.round((waited + rampStep) / 1000)}s: ${n} live enemies`);
  }

  log(`measuring ${SECONDS}s (instrumentation-only, no CDP CPU profiler)`);
  await page.evaluate(() => {
    const M = window.__mix;
    M.frames = 0; M.stepMs = 0; M.renderMs = 0; M.fpsSamples = [];
    for (const k of Object.keys(M.total)) { M.total[k] = 0; M.calls[k] = 0; }
  });
  await page.waitForTimeout(SECONDS * 1000);

  const state = await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');
    window.__profTimers?.forEach(clearInterval);
    const byKind = {};
    for (const e of a.enemies) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return {
      mix: window.__mix,
      fps: Math.round(g.loop.actualFps * 10) / 10,
      children: a.children.list.length,
      enemies: a.enemies.length,
      byKind,
      projectiles: a.projectiles.length,
      firePatches: a.firePatches.length,
      tweens: a.tweens.getTweens().length,
      textures: Object.keys(g.textures.list).length,
      targetFps: g.loop.targetFps ?? null,
      configFps: g.config?.fps ?? null,
    };
  });

  console.log(`\nMeasured ${SECONDS}s of HEAVY swarm combat (after ${RAMP_SECONDS}s ramp) @ ${URL}`);
  console.log(`End state: fps=${state.fps} targetFps=${state.targetFps} configFps=${JSON.stringify(state.configFps)} ` +
    `enemies=${state.enemies} projectiles=${state.projectiles} firePatches=${state.firePatches} ` +
    `displayListChildren=${state.children} tweens=${state.tweens} textures=${state.textures}`);
  console.log(`Enemies by kind: ${JSON.stringify(state.byKind)}`);
  const M = state.mix;
  const minFps = Math.min(...M.fpsSamples);
  const maxFps = Math.max(...M.fpsSamples);
  const avgFps = M.fpsSamples.reduce((a, b) => a + b, 0) / M.fpsSamples.length;
  console.log(`\nFPS during measurement window: avg=${avgFps.toFixed(1)} min=${minFps.toFixed(1)} max=${maxFps.toFixed(1)}`);
  console.log(`\nEngine step avg ${(M.stepMs / M.frames).toFixed(2)}ms/frame — of which render ` +
    `${(M.renderMs / M.frames).toFixed(2)}ms, game logic ${((M.stepMs - M.renderMs) / M.frames).toFixed(2)}ms (${M.frames} frames)`);
  console.log('\nPer-mixin wall time (ms/frame) + calls/frame, ranked:');
  const mixRows = Object.entries(M.total).sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of mixRows) {
    const calls = M.calls[name] || 0;
    console.log(`  ${name.padEnd(24)} ${(ms / M.frames).toFixed(3)} ms/frame  (${(calls / M.frames).toFixed(2)} calls/frame)`);
  }
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
