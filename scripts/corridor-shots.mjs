// #169 visual evidence — screenshots at spawn (one END of the corridor, boundary on the sides) and
// partway down the spine (terrain not visible from spawn). Run against a dev server:
//   SMOKE_URL=http://localhost:PORT node scripts/corridor-shots.mjs
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 720 });
await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__game?.scene.isActive('GarageScene') && window.__game.registry.get('allMechs'), { timeout: 20000 });
await page.evaluate(() => {
  const sc = window.__game.scene.getScene('GarageScene');
  const mech = window.__game.registry.get('allMechs').mech1;
  if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
  sc.deploy();
});
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene') && window.__game.registry.get('dummyMech'), { timeout: 20000 });

// Settle the camera at spawn (origin, the corridor END).
const spawnInfo = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
  for (let i = 0; i < 90; i++) a.update(0, 16);
  const zoom = a.cameras.main.zoom || 1;
  const vw = a.scale.width / zoom, vh = a.scale.height / zoom;
  const SIZE = 48, RT3 = Math.sqrt(3);
  let onScreen = 0;
  for (const k of (a._boundaryRing ?? [])) {
    const [q, r] = k.split(',').map(Number);
    const bx = SIZE * RT3 * (q + r / 2), by = SIZE * (3 / 2) * r;
    if (bx >= -vw / 2 && bx <= vw / 2 && by >= -vh / 2 && by <= vh / 2) onScreen++;
  }
  return { startAngle: (a._spine.startAngle * 180 / Math.PI).toFixed(0), boundaryOnScreenAtSpawn: onScreen, corridorHexes: a.terrain.size };
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/corridor-spawn.png' });

// Jump the player to ~55% down the spine and settle the camera there.
const midInfo = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const spine = a._spine;
  const maxU = spine.points[spine.points.length - 1].u;
  const targetU = 0.55 * maxU;
  let best = spine.points[0];
  for (const p of spine.points) if (Math.abs(p.u - targetU) < Math.abs(best.u - targetU)) best = p;
  a.px = best.x; a.py = best.y; a.vx = 0; a.vy = 0;
  if (a.playerView) { a.playerView.x = best.x; a.playerView.y = best.y; }
  a.cameras.main.centerOn(best.x, best.y);
  for (let i = 0; i < 90; i++) a.update(0, 16);
  return { atU: Math.round(targetU), px: Math.round(best.x), py: Math.round(best.y) };
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/corridor-mid.png' });

console.log('spawn:', JSON.stringify(spawnInfo));
console.log('mid:  ', JSON.stringify(midInfo));
console.log('screenshots: /tmp/corridor-spawn.png (one END + boundary on sides), /tmp/corridor-mid.png (partway down the spine)');
await browser.close();
