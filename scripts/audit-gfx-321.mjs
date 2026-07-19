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
// RE-CHECKED after #333 grew bases ~3.5x (2026-07-19). The win is DILUTED, not undone:
//   ~7,800 at the quietest point in the world | ~8,000 parked at a base | ~14,400 between two bases
// Two things moved. (1) A ring costs ~7,000 commands now, up from ~3,400: 54-64 spans each (was
// ~20) at ~128 commands per span. (2) More importantly, OPEN GROUND NO LONGER EXISTS — five rings
// this large fill the corridor so completely that the furthest point in the whole world is only
// ~319px from a ring's bounding box, inside the 400px GFX_CULL_MARGIN_PX, so at least one ring is
// resident everywhere. Worst case is still comfortably under the 20,718 baseline, so #321's fix is
// still paying; the specific "~1,100 in open ground" figure is simply no longer reachable.
//
// The remaining lever is sub-ring granularity, and it is NOT cheap — see the seam analysis in
// world.js `_buildWorld`. `drawWallEdges` is strictly layered (shadow -> plate -> face -> pillars
// -> pips), so two chunks holding ADJACENT spans would interleave those layers at their shared
// junction. Rings are safe to split from each other only because they don't touch. Micro-trims
// (deduping the doubly-drawn junction pillars, hoisting invariant fillStyles) are worth ~10% and
// do not change the picture. The real fix would be baking each ring's static spans into a
// RenderTexture, re-baked on damage — correct by construction, but invasive, and not verifiable
// for visual regressions in this GPU-less harness.
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

const sample = () => page.evaluate(() => {
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
    cameraCentre: [Math.round(a.cameras.main.midPoint.x), Math.round(a.cameras.main.midPoint.y)],
    visibleRings: [...(a._wallGfxByBase?.entries() ?? [])].filter(([, g]) => g.visible).length,
    ringCount: a._wallGfxByBase?.size ?? null,
    terrainTiles: a.terrain?.size ?? null,
    tileImages: a.tileImages?.size ?? null,
    visibleTiles: a._visibleTiles?.size ?? null,
    enemies: a.enemies?.length ?? null,
    wallSpans: a.wallEdges?.edges?.size ?? null,
  };
});

console.log('=== AT SPAWN ===');
console.log(JSON.stringify(await sample(), null, 2));

// #321 re-check (#333 grew bases ~3.5x): the single spawn sample is not enough on its own, because
// the whole question is how the cost varies with WHERE the camera is. Two more stations, picked
// from the live ring bounds rather than hardcoded: the point furthest from every ring (open
// ground) and a ring centre (parked at a base). Teleporting the player is enough — the camera
// follows it and `_updateTileCulling` recomputes once the centre moves past CULL_RECHECK_PX.
const stations = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const bounds = [...(a._wallGfxBounds?.values() ?? [])];
  if (!bounds.length) return [];
  // Distance from a point to a ring's BOUNDING BOX (0 inside it) — culling is bbox-based, so
  // that, not the ring centre, is what decides whether a ring stays resident.
  const distToBox = (x, y, b) => Math.hypot(
    Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
  // Search the whole playable extent (the camera's world bounds), not just the span between
  // ring centres — with rings this large those two are very different places.
  const wb = a.cameras.main._bounds ?? a.physics?.world?.bounds
    ?? { x: 0, y: 0, width: 12000, height: 12000 };
  let best = null;
  for (let i = 0; i <= 80; i++) {
    for (let j = 0; j <= 80; j++) {
      const x = wb.x + wb.width * (i / 80), y = wb.y + wb.height * (j / 80);
      const d = Math.min(...bounds.map((b) => distToBox(x, y, b)));
      if (!best || d > best.d) best = { x, y, d };
    }
  }
  const r0 = bounds[0];
  return [
    { label: `OPEN GROUND (${Math.round(best.d)}px from nearest ring)`, x: best.x, y: best.y },
    { label: 'PARKED AT A BASE', x: (r0.minX + r0.maxX) / 2, y: (r0.minY + r0.maxY) / 2 },
  ];
});

for (const s of stations) {
  await page.evaluate(({ x, y }) => {
    const a = window.__game.scene.getScene('ArenaScene');
    // The camera follows `playerView`, which tracks the scene's authoritative `px`/`py`.
    a.px = x; a.py = y;
    a.playerView?.setPosition?.(x, y);
    a.cameras.main.centerOn(x, y);
  }, s);
  await page.waitForTimeout(1200);
  console.log(`=== ${s.label} ===`);
  console.log(JSON.stringify(await sample(), null, 2));
}

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
