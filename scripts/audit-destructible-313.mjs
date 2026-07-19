// #313 — measurement harness: how long does it actually take to break a fortification?
//
// Boots the real game, deploys the real saved loadout into the arena, then for each target
// (one wall span, one objective hex, one sealed dock, one turret bunker, one alert tower)
// plants the target directly downrange, holds every trigger, and measures on the game's OWN
// clock how many damage events and how many seconds it takes to bring the thing down.
//
// Everything runs through the real firing path (`_fireSlot` -> projectile/hitscan ->
// `_damageBuildingAt`/`_damageWallEdge`), so the numbers are what a player actually experiences,
// not an arithmetic model of the HP table.
//
// Usage: start a dev server, then `node scripts/audit-destructible-313.mjs`

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 45000);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 20000 });

await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

// ── Rig ──────────────────────────────────────────────────────────────────────────────────
// Keep the run alive and the player safe; leave the FIRING and DAMAGE paths completely intact,
// because those are the thing under measurement.
const loadout = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  a._updateRun = () => {};
  a._damagePlayerAt = () => {};
  a.enemies.length = 0;                       // nothing shooting back, nothing else to hit
  a.mech.consumeAmmo = () => {};              // measure the fortification, not the magazine

  window.__a313 = { events: 0, dmg: 0, shots: 0, perSlot: {}, done: false, t0: 0, t1: 0 };

  // Count real TRIGGER PULLS per slot — "how many shots did that take" in player terms, which
  // is not the same as damage events (a cluster rocket is one shot but many impacts).
  const origFire = a.fireWeapon.bind(a);
  a.fireWeapon = (w) => {
    const s = window.__a313;
    if (s.armed && !s.done) { s.shots++; s.perSlot[w.location] = (s.perSlot[w.location] || 0) + 1; }
    return origFire(w);
  };

  // Count every damage event that lands on the target, via the real damage entry points.
  const origBuilding = a._damageBuildingAt.bind(a);
  a._damageBuildingAt = (x, y, amount, opts = {}) => {
    const s = window.__a313;
    if (s.armed && !s.done && !opts.stomp) { s.events++; s.dmg += amount; }
    return origBuilding(x, y, amount, opts);
  };

  return (a.mech.weapons?.() || []).map((w) => `${w.location}:${w.weapon?.id ?? '?'}`);
});

// Aim + hold every trigger, straight down +X, where the target is planted.
const holdTriggers = async () => {
  await page.evaluate(() => {
    const a = window.__game.scene.getScene('ArenaScene');
    const a2 = a;
    a2.controls.read = () => ({
      move: { x: 0, y: 0 },
      aim: { mode: 'pointer', x: a2.px + 800, y: a2.py, angle: 0 },
      fire: (window.__a313slots
        ? Object.fromEntries(window.__a313slots.map((l) => [l, true]))
        : { rightArm: true, leftArm: true, rightTorso: true, leftTorso: true,
            centerTorso: false, head: true }),
      mode: 'kbm', dashPressed: false,
    });
  });
};

// Measure one target: plant it at a fixed range straight ahead, hold fire, and wait for it
// to come down — reading the game's own elapsed clock, not the harness's wall clock.
// Restrict firing to a single slot (or all of them), so we can report both the four-weapon
// number a fully-armed player sees and a one-weapon worst case.
async function useSlots(only) {
  await page.evaluate((only) => { window.__a313slots = only; }, only);
}

async function measure(label, plant) {
  await page.evaluate(({ plant }) => {
    const a = window.__game.scene.getScene('ArenaScene');
    window.__a313 = { events: 0, dmg: 0, shots: 0, perSlot: {}, done: false, armed: false, t0: 0, t1: 0, hp0: 0 };
    // eslint-disable-next-line no-new-func
    new Function('a', 'S', plant)(a, window.__a313);
    window.__a313.t0 = a.time.now;
    window.__a313.armed = true;
  }, { plant });

  await holdTriggers();
  // Let the turret finish slewing onto the aim point before the clock starts, so slew time
  // never lands in the measured number.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const a = window.__game.scene.getScene('ArenaScene');
    window.__a313.t0 = a.time.now;
    window.__a313.events = 0; window.__a313.dmg = 0;
    window.__a313.shots = 0; window.__a313.perSlot = {};
  });

  await page.waitForFunction(() => window.__a313.done, { timeout: TIMEOUT_MS })
    .catch(() => { throw new Error(`${label}: still standing after ${TIMEOUT_MS}ms`); });

  const r = await page.evaluate(() => {
    const s = window.__a313;
    s.armed = false;
    return { events: s.events, dmg: s.dmg, shots: s.shots, perSlot: { ...s.perSlot }, hp0: s.hp0, ms: s.t1 - s.t0 };
  });

  // Release the triggers between targets so nothing bleeds into the next measurement.
  await page.evaluate(() => {
    const a = window.__game.scene.getScene('ArenaScene');
    const a2 = a;
    a2.controls.read = () => ({
      move: { x: 0, y: 0 },
      aim: { mode: 'pointer', x: a2.px + 800, y: a2.py, angle: 0 },
      fire: {}, mode: 'kbm', dashPressed: false,
    });
  });
  return { label, ...r };
}

// A destructible TERRAIN hex, planted on the tile the player is aiming at.
const plantHex = (id) => `
  const { pixelToHex, axialKey, hexToPixel } = a.__hex313;
  const h = pixelToHex(a.px + 200, a.py);
  const k = axialKey(h.q, h.r);
  a.terrain.set(k, '${id}');
  S.hp0 = a.__buildingHp313('${id}');
  a.buildingHp.set(k, S.hp0);
  const prev = a._onTerrainCollapsed;
  a._onTerrainCollapsed = (key) => {
    if (key === k && !S.done) { S.done = true; S.t1 = a.time.now; }
    return prev?.call(a, key);
  };
`;

// A WALL SPAN — an edge-owned obstacle, so it takes the dedicated wall damage path.
const plantWall = `
  const { pixelToHex, neighbors, hexToPixel } = a.__hex313;
  // Straddle the firing line: the boundary between the hex ~200px downrange and its EASTWARD
  // neighbour is a span the rounds must physically cross, so this measures the real crossing
  // test rather than a hand-placed segment.
  const h = pixelToHex(a.px + 180, a.py);
  const ns = neighbors(h.q, h.r);
  const n = ns.reduce((best, c) => (hexToPixel(c.q, c.r).x > hexToPixel(best.q, best.r).x ? c : best), ns[0]);
  a.wallEdges = a.__makeWallEdgeSet313([{ a: { q: h.q, r: h.r }, b: n, baseId: 'audit' }]);
  const span = [...a.wallEdges.edges.values()][0];
  S.hp0 = span.hp;
  const orig = a._damageWallEdge.bind(a);
  a._damageWallEdge = (edge, amount) => {
    if (S.armed && !S.done) { S.events++; S.dmg += amount; }
    const r = orig(edge, amount);
    if (edge.destroyed && !S.done) { S.done = true; S.t1 = a.time.now; }
    return r;
  };
`;

// Expose the pure helpers the planting snippets need, off the real modules.
await page.addScriptTag({ type: 'module', content: `
  import { pixelToHex, axialKey, hexToPixel, neighbors } from '/src/data/hexgrid.js';
  import { makeWallEdgeSet } from '/src/data/wallEdges.js';
  import { buildingHp } from '/src/data/terrain.js';
  const a = window.__game.scene.getScene('ArenaScene');
  a.__hex313 = { pixelToHex, axialKey, hexToPixel, neighbors };
  a.__makeWallEdgeSet313 = makeWallEdgeSet;
  a.__buildingHp313 = buildingHp;
  window.__a313ready = true;
` });
await page.waitForFunction(() => window.__a313ready, { timeout: 15000 });

const results = [];
// Pass 1: everything the player has mounted — the normal case.
await useSlots(null);
results.push(await measure('wall span', plantWall));
for (const id of ['objective', 'dockClosed', 'alertTower']) {
  results.push(await measure(id, plantHex(id)));
}
// Pass 2: one gun only — the worst case a stripped or half-wrecked mech faces.
await useSlots(['rightArm']);
results.push(await measure('wall span (1 gun)', plantWall));
results.push(await measure('objective (1 gun)', plantHex('objective')));

// ── Check 2: RAMMING ────────────────────────────────────────────────────────────────────
// #313 asked whether WALL_STOMP_FACTOR (0.25) is still a sane last resort now that a span has
// 4x the HP, or whether ramming has become effectively impossible. Measured, not modelled:
// drive flat out into a live span with the guns cold and time the real per-frame stomp path.
const ramming = await page.evaluate(async () => {
  const a = window.__game.scene.getScene('ArenaScene');
  const { pixelToHex, neighbors, hexToPixel } = a.__hex313;
  const h = pixelToHex(a.px, a.py);
  const ns = neighbors(h.q, h.r);
  const n = ns.reduce((x, c) => (hexToPixel(c.q, c.r).x > hexToPixel(x.q, x.r).x ? c : x), ns[0]);
  a.wallEdges = a.__makeWallEdgeSet313([{ a: { q: h.q, r: h.r }, b: n, baseId: 'audit' }]);
  const span = [...a.wallEdges.edges.values()][0];
  const S = { hp0: span.hp, done: false, t0: a.time.now, t1: 0 };
  const orig = a._damageWallEdge.bind(a);
  a._damageWallEdge = (e, amt) => {
    const r = orig(e, amt);
    if (e.destroyed && !S.done) { S.done = true; S.t1 = a.time.now; }
    return r;
  };
  // Guns cold, throttle pinned — the "magazines dry, ram it" case.
  a.controls.read = () => ({
    move: { x: 1, y: 0 },
    aim: { mode: 'pointer', x: a.px + 800, y: a.py, angle: 0 },
    fire: {}, mode: 'kbm', dashPressed: false,
  });
  const t = Date.now();
  while (!S.done && Date.now() - t < 60000) await new Promise((r) => setTimeout(r, 100));
  return { hp0: S.hp0, done: S.done, ms: S.t1 - S.t0 };
});

console.log(`\n#313 destructible HP — measured in the real running game`);
console.log(`loadout: ${loadout.join(', ')}\n`);
console.log('target                 HP   shots  impacts   seconds   per-slot shots');
console.log('----------------------------------------------------------------------');
for (const r of results) {
  const per = Object.entries(r.perSlot).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `${r.label.padEnd(21)} ${String(r.hp0).padStart(4)} ${String(r.shots).padStart(7)} `
    + `${String(r.events).padStart(8)} ${(r.ms / 1000).toFixed(2).padStart(9)}   ${per}`,
  );
}

console.log(
  `\nramming (WALL_STOMP_FACTOR): a ${ramming.hp0} HP span takes `
  + `${ramming.done ? `${(ramming.ms / 1000).toFixed(1)}s` : 'MORE THAN 60s'} of flat-out leaning `
  + `— vs ~${(results[0].ms / 1000).toFixed(1)}s of shooting.`,
);

if (errors.length) {
  console.log(`\npage errors:\n${errors.slice(0, 5).join('\n')}`);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
