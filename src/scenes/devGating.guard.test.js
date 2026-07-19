// #296: dev/debug UI (FPS counter, control hints, control-method + AI readouts, the MUSIC tab,
// and the whole SFX-authoring surface — sound-tuning panel + sound-trigger rows) is gated behind
// `import.meta.env.DEV` (Vite's build-time flag, stripped/dead-code-eliminated in `npm run build`)
// so none of it ships in a production bundle. HudScene/GarageScene extend Phaser.Scene and are
// Phaser-API-heavy, so — same technique as hexLabelDevGate.guard.test.js / sfxCallSites.guard.test.js
// — these are source-text guards over the real files, not constructed instances. They lock in that
// each gated surface is wrapped in a DEV guard (and, for the SFX call sites, that the guard covers
// the dangling references — panel/rows — so a production build with no panel can't throw).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(DIR, rel), 'utf8');
const hud = read('HudScene.js');
const garage = read('GarageScene.js');
const tabBar = read('../ui/tabBar.js');

describe('#296 HudScene: FPS / control hints / control-method / AI readouts are dev-gated', () => {
  it('the FPS counter is created only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText = this\.add\.text/);
  });

  it('the FPS counter is updated only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText\.setText\(`FPS /);
  });

  it('the control-method (modeText) + AI (aiText) overlays are created only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.modeText = this\.add\.text[\s\S]*?this\.aiText = this\.add\.text/);
  });

  it('the control-method + AI overlays are updated only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.modeText\.setText[\s\S]*?this\.aiText\.setText/);
  });

  it('the control-hints + debug d-pad cheat-sheet lines are created only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.add\.text\(16, 36, 'WASD\/L-stick/);
  });

  it('MOUSE + KB (a control-method-only string) is never emitted outside a DEV guard', () => {
    // Belt-and-braces: the only occurrence of the literal sits inside the gated update() block.
    const idx = hud.indexOf("'MOUSE + KB'");
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = hud.lastIndexOf('import.meta.env.DEV', idx);
    expect(guardIdx).toBeGreaterThan(-1);
  });
});

describe('#296 tabBar: the MUSIC tab is dev-only', () => {
  it('the MUSIC/MusicScene tab is spread into TABS only under import.meta.env.DEV', () => {
    expect(tabBar).toMatch(/\.\.\.\(import\.meta\.env\.DEV \? \[\{ key: 'MUSIC', scene: 'MusicScene' \}\] : \[\]\)/);
  });

  it("MECH LAB stays unconditional so production still has the garage tab", () => {
    expect(tabBar).toMatch(/const TABS = \[\s*\n\s*\{ key: 'MECH LAB', scene: 'GarageScene' \},/);
  });
});

describe('#296 GarageScene: the SFX-authoring surface is dev-only', () => {
  it('the WeaponSfxPanel + explosion/UI/autofire rows are built only under import.meta.env.DEV', () => {
    expect(garage).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.panel = new WeaponSfxPanel[\s\S]*?this\._buildExplosionRow[\s\S]*?this\._buildUiRow[\s\S]*?this\._buildAutofireRow/);
  });

  it('_onCardSelect guards its panel/row calls so a production card-click just mounts the item', () => {
    const body = garage.match(/_onCardSelect\(id\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.panel\.setWeapon\(id\)/);
    // the mount call must stay OUTSIDE the guard (production still mounts)
    expect(body).toMatch(/\}\s*\n\s*this\._pickItem\(id\);/);
  });

  it('the shutdown teardown of panel/explosion row is guarded', () => {
    expect(garage).toMatch(/this\.list\.destroy\(\);\s*\n\s*\/\/[\s\S]*?if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.panel\.destroy\(\);/);
  });

  // #240: the inverse direction of the same pattern — the Boss Arena option must be
  // UNCONDITIONALLY available on the dev server (otherwise the fight can't be playtested without
  // clearing all five biomes first), while a production build falls through to the real unlock.
  it('#240 the Boss Arena option is always available under DEV, and gated on the real unlock otherwise', () => {
    const body = garage.match(/_bossArenaUnlocked\(\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/if \(import\.meta\.env\.DEV\) return true;/);
    expect(body).toMatch(/return allBiomesCleared\(\);/);
  });

  it('_topRegion returns a full-width catalog (no panel reserve) in production', () => {
    const body = garage.match(/_topRegion\(top\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/if \(!import\.meta\.env\.DEV\)\s*\{\s*\n\s*return \{ list: \{ x: 20, y: top, w: this\.W - 40/);
  });
});
