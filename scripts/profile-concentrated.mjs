// Concentrated-fire profiler (#76). Unlike profile-fight.mjs (a spread pack), this stages the
// exact pathological case from the #76 playtest report: the player mounts FOUR rapid stream
// weapons (Repeaters) and pours ALL of them into ONE heavy mech sitting at point-blank range,
// which is kept alive (repaired every tick) so the fire never stops landing on a single target
// at essentially one point. That maximises the per-HIT churn the issue is about — a float Text +
// 2-3 impact circles + a WebAudio impact trigger PER hit, many hits per frame at the same spot.
//
// Samples once per second (same schema as profile-fight.mjs) plus:
//   soundTriggers — cumulative Audio.impact() calls that actually fired a sound (post-throttle)
//   impactCalls   — cumulative _impactFx() invocations (hits that reached the FX path)
//   floatsMade    — cumulative add.text() calls on the damage-number path (float churn)
//
// Usage: start a dev server, then `SMOKE_URL=http://localhost:PORT node scripts/profile-concentrated.mjs`.
// Optional: PROFILE_SECONDS=20 (default 20).

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 20);

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
    if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
    sc.deploy();
  });
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

  await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // Instrument: engine-step CPU time, texture regens, damage-float text churn, and — patching
    // the shared Audio singleton — how many impact SOUNDS actually fire after any throttle.
    const P = (window.__prof = { steps: [], texRegens: 0, textsMade: 0, soundTriggers: 0, impactCalls: 0, t0: 0 });
    g.events.on('prestep', () => { P.t0 = performance.now(); });
    g.events.on('postrender', () => { P.steps.push(performance.now() - P.t0); });
    const mkGraphics = a.make.graphics.bind(a.make);
    a.make.graphics = (...args) => { P.texRegens++; return mkGraphics(...args); };
    const mkText = a.add.text.bind(a.add);
    a.add.text = (...args) => { P.textsMade++; return mkText(...args); };
    const origImpactFx = a._impactFx.bind(a);
    a._impactFx = (...args) => { P.impactCalls++; return origImpactFx(...args); };
    // Count real impact-sound triggers (after the engine's own throttle).
    import('/src/audio/index.js').then(({ Audio }) => {
      const origImpact = Audio.impact.bind(Audio);
      Audio.impact = (id) => { P.soundTriggers++; return origImpact(id); };
    });

    // Player: FOUR Repeaters (machineGun stream, fireRate 18 × 2 streams) — one in every firing
    // slot — so a held trigger is a torrent of hits. Set the mounts directly on the model (the
    // firing mixin reads mech.weapons() live each frame) and give each an oversized magazine so
    // it never runs dry mid-profile.
    for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) {
      a.mech.mounts[loc] = ['machineGun'];
      a.mech.ammo[loc] = [9999];
    }

    // ONE heavy mech (Warden / 'sniper' — heavy chassis, the "big mech") at point-blank.
    const target = a._spawnEnemy(a.px + 150, a.py, 'sniper');

    // Hold every fire button, aim straight at the target, every frame.
    const origRead = a.controls.read.bind(a.controls);
    a.controls.read = () => {
      const intent = origRead();
      intent.aim = { mode: 'pointer', x: target.x, y: target.y };
      for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) intent.fire[loc] = true;
      return intent;
    };

    // Keep the fight static and endless: don't end the run, keep the ONE target alive and
    // in place (repair + refill both mechs each tick), and top the player's ammo back up.
    a._updateRun = () => {};
    window.__profTimers = [
      setInterval(() => {
        a.mech.repairAll();
        target.mech.repairAll();
        for (const loc of ['rightArm', 'leftArm', 'rightTorso', 'leftTorso']) a.mech.ammo[loc] = [9999];
        // Pin the target next to the player so all fire keeps converging on one point.
        target.x = a.px + 150; target.y = a.py;
      }, 100),
    ];
  });

  const samples = [];
  for (let s = 1; s <= SECONDS; s++) {
    await page.waitForTimeout(1000);
    const row = await page.evaluate(() => {
      const g = window.__game;
      const a = g.scene.getScene('ArenaScene');
      const P = window.__prof;
      const steps = P.steps; P.steps = [];
      const sorted = [...steps].sort((x, y) => x - y);
      const avg = steps.length ? steps.reduce((x, y) => x + y, 0) / steps.length : 0;
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      let texts = 0;
      for (const c of a.children.list) if (c.type === 'Text') texts++;
      return {
        fps: Math.round(g.loop.actualFps * 10) / 10,
        stepMs: Math.round(avg * 100) / 100,
        p95StepMs: Math.round(p95 * 100) / 100,
        children: a.children.list.length,
        tweens: a.tweens.getTweens().length,
        projectiles: a.projectiles.length,
        texts,
        soundTriggers: P.soundTriggers,
        impactCalls: P.impactCalls,
        floatsMade: P.textsMade,
      };
    });
    samples.push({ t: s, ...row });
    console.log(JSON.stringify({ t: s, ...row }));
  }

  await page.evaluate(() => window.__profTimers?.forEach(clearInterval));

  // Summary: steady-state (last 10s) means + per-second rates for the cumulative counters.
  const tail = samples.slice(-10);
  const mean = (rows, k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 100) / 100;
  console.log('\nSUMMARY (steady state — mean over last 10s)');
  for (const k of ['fps', 'stepMs', 'p95StepMs', 'children', 'tweens', 'texts', 'projectiles']) {
    console.log(`  ${k.padEnd(12)} ${mean(tail, k)}`);
  }
  const first = samples[0], last = samples.at(-1), span = Math.max(1, last.t - first.t);
  const rate = (k) => Math.round(((last[k] - first[k]) / span) * 10) / 10;
  console.log('\nPER-SECOND RATES (cumulative counters, averaged across the run)');
  console.log(`  impactCalls/s   ${rate('impactCalls')}`);
  console.log(`  soundTriggers/s ${rate('soundTriggers')}`);
  console.log(`  floatsMade/s    ${rate('floatsMade')}`);
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
