// #321: structural audit of per-frame RENDER work — counts, not wall-clock.
//
// Absolute frame timings are worthless in this environment (headless Chromium has no GPU; #326
// measured 89-141ms averages that were pure noise and rightly discarded them). Counts are not:
// the number of Graphics commands the renderer walks each frame is a hard, reproducible number that
// doesn't care about GPU, thermal state, or how many other agents are hammering the box.
//
// The number that matters is `graphicsVisibleCmds`. Phaser's WebGL Graphics pipeline re-walks and
// re-tessellates a VISIBLE Graphics object's entire command buffer every single frame — there is
// no retained geometry and no built-in culling — so that figure is a direct proxy for per-frame
// CPU spent on vector geometry. An INVISIBLE Graphics is skipped outright, which is why
// `graphicsTotalCmds` staying high while `graphicsVisibleCmds` falls is exactly the intended
// outcome, not a partial fix.
//
// Baseline when #321 was opened: 20,718 visible commands, in two world-spanning Graphics objects
// (the wall line at 16,835 and the #222 boundary outline at 3,787), every frame, everywhere in the
// world. After chunking + culling (world.js): ~1,100 in open ground, ~4,000-8,000 parked at a base.
//
// Usage: start a dev server on a port you have VERIFIED serves your own worktree, then
//   SMOKE_URL=http://localhost:PORT node scripts/audit-gfx-321.mjs
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5377';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 30000 });
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 30000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const g = window.__game;
  const a = g.scene.getScene('ArenaScene');
  const list = a.children.list;

  // Bucket the display list by type, and for Graphics count the command-buffer length —
  // that is what the renderer walks every frame.
  const byType = {};
  const graphics = [];
  let visibleCount = 0;
  for (const o of list) {
    const t = o.type || o.constructor?.name || '?';
    byType[t] = (byType[t] || 0) + 1;
    if (o.visible) visibleCount++;
    if (t === 'Graphics') {
      graphics.push({
        depth: o.depth,
        visible: o.visible,
        cmds: o.commandBuffer ? o.commandBuffer.length : -1,
      });
    }
  }
  graphics.sort((x, y) => y.cmds - x.cmds);

  return {
    displayListTotal: list.length,
    visibleCount,
    byType,
    topGraphics: graphics.slice(0, 12),
    graphicsTotalCmds: graphics.reduce((s, x) => s + Math.max(0, x.cmds), 0),
    graphicsVisibleCmds: graphics.filter((x) => x.visible).reduce((s, x) => s + Math.max(0, x.cmds), 0),
    graphicsCount: graphics.length,
    terrainTiles: a.terrain?.size ?? null,
    tileImages: a.tileImages?.size ?? null,
    visibleTiles: a._visibleTiles?.size ?? null,
    enemies: a.enemies?.length ?? null,
    wallSpans: a.wallEdges?.edges?.size ?? null,
  };
});

console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
