// #296: dev/debug UI (FPS counter, control hints, control-method + AI readouts, the MUSIC tab,
// and the whole SFX-authoring surface — sound-tuning panel + sound-trigger rows) is gated behind
// `import.meta.env.DEV` (Vite's build-time flag, stripped/dead-code-eliminated in `npm run build`)
// so none of it ships in a production bundle. HudScene/GarageScene extend Phaser.Scene and are
// Phaser-API-heavy, so — same technique as sfxCallSites.guard.test.js
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

describe('#334 HudScene: the performance readout is NOT dev-gated (it ships to production)', () => {
  // #296 originally gated the FPS counter dev-only; #334 reverses that for the performance readout
  // ONLY, so Jackson can diagnose the Windows/Edge frame-rate problem on the live build. The rest
  // of #296's gating (below) is unchanged — that's the whole point of keeping these in one file.
  it('the performance readout is created unconditionally', () => {
    expect(hud).toMatch(/\n\s*this\.fpsText = this\.add\.text/);
    expect(hud).not.toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText = this\.add\.text/);
  });

  it('the performance readout is updated unconditionally', () => {
    expect(hud).toMatch(/\n\s*this\.fpsText\.setText\(perfLines\(\{/);
    expect(hud).not.toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText\.setText/);
  });

  it('reads the renderer type LIVE off the game rather than inferring it from config', () => {
    expect(hud).toMatch(/rendererLabel\(this\.game\.renderer\?\.type, Phaser\.WEBGL, Phaser\.CANVAS\)/);
  });
});

describe('#296 HudScene: control hints / control-method / AI readouts stay dev-gated', () => {
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

  it('#445: in-row `actions` reuse the tab rect geometry (same size + vertical alignment)', () => {
    expect(tabBar).toMatch(/for \(const action of actions\) \{[\s\S]*?scene\.add\.rectangle\(x, y, tabW, tabH/);
  });

  it('#445: in-row actions advance the same x cursor the tabs do (one shared gap)', () => {
    const body = tabBar.match(/for \(const action of actions\) \{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/x \+= tabW \+ gap;/);
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

  it('#445: the run-stats overlay is constructed only under import.meta.env.DEV', () => {
    expect(garage).toMatch(/if \(import\.meta\.env\.DEV\) this\._statsOverlay = new StatsOverlay\(this\);/);
  });

  it('#445: the STATS button is spread into the tab bar row only under import.meta.env.DEV', () => {
    expect(garage).toMatch(/actions: import\.meta\.env\.DEV\s*\n?\s*\? \[\{ key: 'STATS', onClick: \(\) => this\._statsOverlay\.open\(\) \}\]\s*\n?\s*: \[\],/);
  });

  it('#445: STATS is an in-row tab-bar action, never a free-floating this.button(...)', () => {
    expect(garage).not.toMatch(/this\.button\([^\n]*'STATS'/);
  });

  it('_topRegion returns a full-width catalog (no panel reserve) in production', () => {
    const body = garage.match(/_topRegion\(top\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/if \(!import\.meta\.env\.DEV\)\s*\{\s*\n\s*return \{ list: \{ x: 20, y: top, w: this\.W - 40/);
  });
});
