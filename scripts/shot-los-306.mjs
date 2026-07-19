// #306 verification screenshots: the raycast shadow overlay in the REAL running game.
// Usage: SMOKE_URL=http://localhost:PORT node scripts/shot-los-306.mjs
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const OUT = process.env.SHOT_DIR || '/tmp/los306';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 20000 });
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

// Park the player beside a base wall ring and hold still, so the shot is stable.
const info = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const spans = [...(a.wallEdges?.edges?.values() ?? [])].filter((e) => !e.destroyed);
  const ring = spans.filter((e) => e.baseId === spans[0]?.baseId);
  const cx = ring.reduce((s, e) => s + e.x0, 0) / ring.length;
  const cy = ring.reduce((s, e) => s + e.y0, 0) / ring.length;
  const far = Math.max(...ring.map((e) => Math.hypot(e.x0 - cx, e.y0 - cy)));
  a.px = cx + far + 70; a.py = cy;
  a._updateRun = () => {};
  const orig = a.controls.read.bind(a.controls);
  a.controls.read = () => { const i = orig(); i.throttle = 0; i.turn = 0; return i; };
  window.__ring = { cx, cy, far };
  return { ringSpans: ring.length, cx, cy, far };
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}-wall.png` });

// A flyer parked behind the wall ring (out of sight) plus one in the open, for the comparison shot.
await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const { cx, cy, far } = window.__ring;
  a._spawnEnemy(cx - far * 0.3, cy, 'helicopter');            // behind the ring → must be DIMMED
  a._spawnEnemy(a.px + 40, a.py - 240, 'helicopter');          // in the open → must be BRIGHT
  a._spawnEnemy(cx - far * 0.3, cy + 90, 'raider');            // ground, behind → DIMMED
});
await page.waitForTimeout(1600);
await page.screenshot({ path: `${OUT}-flyer.png` });

const report = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  return {
    segments: a._shadowSegs,
    dimAlphaLayerDepth: a.fogFx.depth,
    playerDepth: a.playerView?.depth ?? null,
    flyers: a.enemies.filter((e) => e.kind?.flying || e.flying).map((e) => ({
      kind: e.kindId ?? e.kind?.id, depth: e.view?.depth,
      hexVisible: a._pointVisible(e.x, e.y),
    })),
  };
});
console.log(JSON.stringify({ info, report, errors }, null, 2));
await browser.close();
