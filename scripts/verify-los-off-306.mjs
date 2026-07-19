// #306 verification: with the dimming overlay toggled OFF (`LOS_DIM_ENABLED` in
// scenes/arena/visibility.js), prove in the REAL running game that
//   (a) nothing dims — no overlay Graphics exists at all at the DEPTH.LOS_DIM tier, and
//   (b) the GAMEPLAY sight gate still works — an enemy behind a base wall still cannot be locked,
//       while the identical enemy in the open can.
// Usage: SMOKE_URL=http://localhost:PORT node scripts/verify-los-off-306.mjs
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const OUT = process.env.SHOT_DIR || '/tmp/los306-off';
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

// Park the player just outside a base wall ring and hold still.
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
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}-arena.png` });

// (a) Is there any dimming layer at all?
const overlay = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  // Anything in the display list sitting exactly at the LOS_DIM tier (2.9) would be the overlay.
  const atDimTier = a.children.list.filter((o) => o.depth === 2.9).map((o) => o.type);
  return { fogFx: a.fogFx, shadowSegs: a._shadowSegs, objectsAtDimTier: atDimTier };
});

// (b) The gameplay gate, one enemy at a time so `_updateLock` has exactly one candidate.
// NOTE: this must be entirely SYNCHRONOUS. Any await yields to the browser, letting ArenaScene's
// own update() run `_updateLock` again with its own turret angle and clobber what we just measured.
const lockTest = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const { cx, cy } = window.__ring;

  const tryLock = (x, y, kind) => {
    a.enemies.length = 0;
    a._spawnEnemy(x, y, kind);
    const e = a.enemies[0];
    e.x = x; e.y = y;                        // pin it exactly where we asked
    a.turretAngle = Math.atan2(y - a.py, x - a.px);   // aim straight at it
    a._invalidateVisibility();
    a._updateVisibility(a.cameras.main.worldView);
    a.lock = { target: null };
    a._updateLock(0.016);
    // What convergence/lock actually latched onto matters more than whether it latched at all:
    // #250 lets a DESTRUCTIBLE HEX be a fallback convergence target when no enemy is targetable,
    // so a non-null lock is only a failure if the lock IS the hidden enemy.
    const describe = (t) => (t == null ? null : (t === e ? 'THE-ENEMY' : (t.q !== undefined ? 'destructible-hex' : 'other')));
    return {
      kind, hexVisible: a._pointVisible(e.x, e.y),
      aimEnemyIsEnemy: a.aimEnemy === e,
      convergeTarget: describe(a.convergeTarget),
      lockTarget: describe(a.lock.target),
      lockIsTheEnemy: a.lock.target === e,
    };
  };

  return {
    // Deep inside the walled base — the ring is between it and the player.
    behindWall: tryLock(cx, cy, 'raider'),
    behindWallFlyer: tryLock(cx, cy, 'helicopter'),
    // The control: open ground on the far side of the player, AWAY from the base, at the same
    // range. (Going -260 from the player would land inside the ring, not in the open.)
    inOpen: tryLock(a.px + 260, a.py, 'raider'),
    inOpenFlyer: tryLock(a.px + 260, a.py - 60, 'helicopter'),
  };
});

console.log(JSON.stringify({ info, overlay, lockTest, errors }, null, 2));
await browser.close();
