// Headless CPU profiler — #164 follow-up to #148/#155. Same harness/approach as
// scripts/profile-cpu.mjs (boot the real game, deploy, stage combat, capture a real V8 CPU
// profile via CDP), but the staged scenario is deliberately HEAVIER and reflects the CURRENT
// state of `main` (post #159 collision-sweep + higher chassis speeds, post #162's 5x
// Broodwalker spawn-frequency bump):
//
//   - Several Broodwalkers ('quadruped') spawn concurrently and are left to run their FULL
//     deploy cycle (deployEveryMs=4000, batches of 5-8 drones, cap 24 each) — #162 makes this
//     common in a real session, not a rare event, so a realistic profile needs several of them
//     actually completing their bursts, not just existing.
//   - A steady drip of additional reinforcements (mixed kinds, including MORE quadrupeds) during
//     the whole window, approximating a real ~5-10 minute session's accumulating enemy count
//     rather than a single fixed squad.
//   - The player moves continuously at full stick deflection with frequent direction reversals
//     (to actually cross hex boundaries at the new ~2x chassis speeds and exercise
//     `_blockedAlongSegment`/`hexesAlongSegment`, not just sit still) and holds all four
//     arm/torso fire buttons the whole time.
//
// It additionally wraps world.js's `_blockedAlongSegment`/`_wallDistance`/`_blockedByGroundEnemy`/
// `_crushTargetAt` (call count + wall time), since those are the #159/#148 hypotheses under test,
// on top of the same per-mixin wall-time split profile-cpu.mjs already does.
//
// Usage: start a dev server, then
//   SMOKE_URL=http://localhost:PORT node scripts/profile-cpu-164.mjs
// Optional env: PROFILE_SECONDS=20, RAMP_SECONDS=20, PROFILE_RAW=out.cpuprofile

import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 20);
const RAMP_SECONDS = Number(process.env.RAMP_SECONDS || 20);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const log = (m) => process.stderr.write(`[profile-cpu-164] ${m}\n`);

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
    if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
    sc.deploy();
  });
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 60000 });
  log('arena active');
  await page.waitForTimeout(500);

  // Stage a heavy, realistic-to-heavy combat scenario + install instrumentation.
  await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // The default opening squad already spawned in create(). Add a swarm-scale baseline PLUS
    // several Broodwalkers up front so their deploy bursts are running well before profiling
    // starts (each hits its 24-drone cap over ~16-20s of being aware).
    a._spawnEnemy(a.px + 420, a.py, 'swarm');
    a._spawnEnemy(a.px - 420, a.py, 'swarm');
    a._spawnEnemy(a.px, a.py - 420, 'infantryMob');
    a._spawnEnemy(a.px + 500, a.py - 200, 'quadruped');
    a._spawnEnemy(a.px - 500, a.py - 200, 'quadruped');
    a._spawnEnemy(a.px + 200, a.py + 500, 'quadruped');
    a._spawnEnemy(a.px - 200, a.py + 500, 'quadruped');
    a._spawnEnemy(a.px + 300, a.py + 300, 'raider');
    a._spawnEnemy(a.px - 300, a.py + 300, 'artillery');
    a._spawnEnemy(a.px + 300, a.py - 300, 'sniper');
    for (const e of a.enemies) e.awareness = 'aware';

    // Hold all four arm/torso fire buttons, aim at nearest living enemy, and move at FULL
    // deflection with frequent direction reversals (so the player actually crosses hex
    // boundaries continuously at the new ~2x chassis speeds, exercising the #159 collision
    // sweep every frame — sitting still or drifting slowly would under-exercise it).
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
      // Faster direction-reversal period than profile-cpu.mjs's, and normalized so the stick
      // is at full deflection (magnitude 1) rather than a Lissajous curve that spends time near
      // the deadzone.
      const t = performance.now();
      const ang = Math.sin(t / 650) * Math.PI * 2 + Math.cos(t / 400);
      intent.move = { x: Math.cos(ang), y: Math.sin(ang) };
      return intent;
    };

    // Keep the fight alive for the whole window: no run end, periodic repair so the player
    // survives, and a steady drip of reinforcements (mixed kinds incl. quadruped) approximating
    // a real session's accumulating enemy count under #162's boosted late-pool draw rate.
    a._updateRun = () => {};
    const reinforceKinds = ['raider', 'tank', 'skirmisher', 'helicopter', 'sniper', 'turretNest',
      'artillery', 'swarm', 'infantryMob', 'quadruped', 'quadruped'];
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

    // Per-mixin wall time (ms) + call counts, PLUS the #159/#148-hypothesis world.js functions
    // specifically (not part of the ArenaScene per-frame mixin list, called from inside _drive/
    // enemy AI instead) — wrap these directly so we get their own totals + call counts.
    const M = (window.__mix = { frames: 0, total: {}, calls: {}, stepMs: 0, renderMs: 0 });
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
    });
  });

  log(`fight staged; ramping ${RAMP_SECONDS}s so Broodwalker deploy bursts + reinforcement waves ` +
    'run their course before profiling starts');
  const rampMs = RAMP_SECONDS * 1000;
  const rampStep = 2000;
  for (let waited = 0; waited < rampMs; waited += rampStep) {
    await page.waitForTimeout(Math.min(rampStep, rampMs - waited));
    const n = await page.evaluate(() => window.__game.scene.getScene('ArenaScene').enemies.length);
    log(`  ramp t+${Math.round((waited + rampStep) / 1000)}s: ${n} live enemies`);
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await page.evaluate(() => {
    const M = window.__mix;
    M.frames = 0; M.stepMs = 0; M.renderMs = 0;
    for (const k of Object.keys(M.total)) { M.total[k] = 0; M.calls[k] = 0; }
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
  const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);

  console.log(`\nProfiled ${SECONDS}s of HEAVY swarm combat (after ${RAMP_SECONDS}s ramp) @ ${URL}`);
  console.log(`End state: fps=${state.fps} enemies=${state.enemies} projectiles=${state.projectiles} ` +
    `firePatches=${state.firePatches} displayListChildren=${state.children} tweens=${state.tweens} textures=${state.textures}`);
  console.log(`Enemies by kind: ${JSON.stringify(state.byKind)}`);
  const M = state.mix;
  console.log(`\nEngine step avg ${(M.stepMs / M.frames).toFixed(2)}ms/frame — of which render ` +
    `${(M.renderMs / M.frames).toFixed(2)}ms, game logic ${((M.stepMs - M.renderMs) / M.frames).toFixed(2)}ms (${M.frames} frames)`);
  console.log('\nPer-mixin wall time (ms/frame) + calls/frame:');
  const mixRows = Object.entries(M.total).sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of mixRows) {
    const calls = M.calls[name] || 0;
    console.log(`  ${name.padEnd(24)} ${(ms / M.frames).toFixed(3)} ms/frame  (${(calls / M.frames).toFixed(2)} calls/frame)`);
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
