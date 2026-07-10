// Headless combat-performance profiler (#71). Boots the real game like scripts/smoke.mjs,
// deploys into the arena, then stages a HEAVY sustained fight: a pack of enemies is spawned
// close in, the player's fire buttons are held down continuously (via a controls.read()
// override), and fresh enemies keep arriving so kills/drops/fx accumulate — the scenario the
// lag report (#71) describes. While the fight runs it samples, once per second:
//
//   fps        — Phaser's measured actual FPS
//   stepMs     — CPU cost of one full engine step (prestep → postrender), avg over the second
//   p95StepMs  — 95th percentile of the same (spike detector)
//   children   — ArenaScene display-list length (leak detector: game objects)
//   tweens     — active tween count (leak detector: impact-fx / float-text tweens)
//   timers     — pending clock events (leak detector: delayedCall build-up)
//   projectiles/beams/patches/enemies/texts — live sim counts
//   texRegens  — cumulative scene.make.graphics() calls (each procedural texture (re)build
//                makes exactly one throwaway Graphics, so this counts texture regeneration —
//                the reskin-on-every-hit cost)
//   textsMade  — cumulative add.text() calls (float-text churn)
//
// Usage: start a dev server, then `SMOKE_URL=http://localhost:PORT node scripts/profile-fight.mjs`.
// Optional: PROFILE_SECONDS=40 (default 40), PROFILE_ENEMIES=8 (initial pack size).

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const SECONDS = Number(process.env.PROFILE_SECONDS || 40);
const PACK = Number(process.env.PROFILE_ENEMIES || 8);

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

  // Complete the build if needed (deploy() no-ops on an incomplete mech), then deploy.
  await page.evaluate(() => {
    const sc = window.__game.scene.getScene('GarageScene');
    const mech = window.__game.registry.get('allMechs').mech1;
    if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
    sc.deploy();
  });
  await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

  // Stage the fight + install instrumentation.
  await page.evaluate((pack) => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');

    // Instrumentation: engine-step CPU time (prestep → postrender), texture regens, texts.
    const P = (window.__prof = { steps: [], texRegens: 0, textsMade: 0, t0: 0 });
    g.events.on('prestep', () => { P.t0 = performance.now(); });
    g.events.on('postrender', () => { P.steps.push(performance.now() - P.t0); });
    const mkGraphics = a.make.graphics.bind(a.make);
    a.make.graphics = (...args) => { P.texRegens++; return mkGraphics(...args); };
    const mkText = a.add.text.bind(a.add);
    a.add.text = (...args) => { P.textsMade++; return mkText(...args); };

    // A close-in pack so everyone is in weapons range immediately.
    for (let i = 0; i < pack; i++) {
      const ang = (i / pack) * Math.PI * 2;
      a._spawnEnemy(a.px + Math.cos(ang) * 260, a.py + Math.sin(ang) * 260,
        ['raider', 'skirmisher', 'sniper', 'artillery'][i % 4]);
    }

    // Hold every fire button and aim at the nearest living enemy, every frame.
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
      return intent;
    };

    // Keep the fight going for the whole sample window: the run must not end (player death /
    // mission complete would dump us back to the garage mid-profile), the player is repaired
    // whenever hurt, and reinforcements keep arriving.
    a._updateRun = () => {};
    window.__profTimers = [
      setInterval(() => {
        for (const p of Object.values(a.mech.parts)) {
          if (p.armor + p.structure < (p.armorMax + p.structureMax) * 0.75) { a.mech.repairAll(); break; }
        }
      }, 250),
      setInterval(() => { if (a.scene.isActive()) a._spawnEnemyDebug(); }, 3000),
    ];
  }, PACK);

  // Sample once per second.
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
        timers: a.time._active?.length ?? -1,
        projectiles: a.projectiles.length,
        beams: a.beams.length + a.dyingBeams.length,
        patches: a.firePatches.length,
        enemies: a.enemies.length,
        alive: a.enemies.filter((e) => !e.mech.isDestroyed()).length,
        texts,
        texRegens: P.texRegens,
        textsMade: P.textsMade,
        textures: Object.keys(g.textures.list).length,
      };
    });
    samples.push({ t: s, ...row });
    console.log(JSON.stringify({ t: s, ...row }));
  }

  await page.evaluate(() => window.__profTimers?.forEach(clearInterval));

  // Summary: first vs last 5 seconds.
  const head = samples.slice(0, 5), tail = samples.slice(-5);
  const mean = (rows, k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 100) / 100;
  console.log('\nSUMMARY (first 5s vs last 5s of the fight)');
  for (const k of ['fps', 'stepMs', 'p95StepMs', 'children', 'tweens', 'timers', 'texts']) {
    console.log(`  ${k.padEnd(10)} ${String(mean(head, k)).padStart(8)}  →  ${mean(tail, k)}`);
  }
  const last = samples.at(-1);
  console.log(`  texRegens (cumulative): ${last.texRegens}   textsMade (cumulative): ${last.textsMade}`);
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
} catch (e) {
  console.error('PROFILE FAIL:', e.message, errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
