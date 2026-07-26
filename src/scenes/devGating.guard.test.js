// #296: dev/debug UI (FPS counter, control hints, control-method + AI readouts, and the AUDIO tab
// — which since #470 holds the whole SFX-authoring surface: sound-tuning panel + sound-trigger
// rows) is gated behind
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
const main = read('../main.js');

describe('#523 HudScene: perf/control-method/AI/version readouts moved from DEV-gated to toggle-gated', () => {
  // #296 gated the FPS counter dev-only; #334 reversed that so Jackson could diagnose a Windows/
  // Edge frame-rate problem on the live build; #449 put it BACK behind DEV. #523 supersedes all
  // of that: none of these five overlays (fpsText/versionText/modeText/aiText/devPanelGfx) are
  // gated by `import.meta.env.DEV` any more — HudScene.js has NO live DEV guard left at all. Each
  // is created unconditionally and gated per-frame by its own persisted pause-menu toggle
  // (data/pauseSettings.js, registry channels `showPerf`/`showVersion`/`showControlMethod`/
  // `showAiDebug`) instead.
  it('HudScene.js contains no live `if (import.meta.env.DEV)` guard any more', () => {
    expect(hud).not.toMatch(/if \(import\.meta\.env\.DEV\)/);
  });

  it('the five overlay objects are created unconditionally in create()', () => {
    expect(hud).toMatch(/this\.devPanelGfx = this\.add\.graphics\(\)\.setDepth\(30\);/);
    expect(hud).toMatch(/this\.versionText = this\.add\.text/);
    expect(hud).toMatch(/this\.modeText = this\.add\.text/);
    expect(hud).toMatch(/this\.aiText = this\.add\.text/);
    expect(hud).toMatch(/this\.fpsText = this\.add\.text/);
  });

  it('the one-off renderer/GPU probes run unconditionally too', () => {
    expect(hud).toMatch(/this\._perfRenderer = rendererLabel\(this\.game\.renderer\?\.type, Phaser\.WEBGL, Phaser\.CANVAS\);/);
    expect(hud).toMatch(/this\._perfGpu = gpuRendererString\(/);
  });

  it('the perf readout text is only ever set to real content behind the `showPerf` registry toggle', () => {
    expect(hud).toMatch(/const showPerf = this\.registry\.get\('showPerf'\) === true;\s*\n\s*if \(showPerf\) \{\s*\n\s*this\.fpsText\.setText\(perfLines\(\{/);
  });

  it('the version readout is only ever set to real content behind the `showVersion` registry toggle', () => {
    expect(hud).toMatch(/const showVersion = this\.registry\.get\('showVersion'\) === true;/);
    expect(hud).toMatch(/this\.versionText\.setText\(showVersion \? `BUILD \$\{formatBuildTime\(BUILD_TIME\)\}` : ''\)\.setVisible\(showVersion\);/);
  });

  it('the control-method readout is only ever set to real content behind the `showControlMethod` registry toggle', () => {
    expect(hud).toMatch(/const showControlMethod = this\.registry\.get\('showControlMethod'\) === true;/);
    expect(hud).toMatch(/this\.modeText\.setText\(showControlMethod \? this\._inputModeLabel\(\) : ''\)\.setVisible\(showControlMethod\);/);
  });

  it('the AI debug readout is only ever set to real content behind the `showAiDebug` registry toggle', () => {
    expect(hud).toMatch(/const showAiDebug = this\.registry\.get\('showAiDebug'\) === true;/);
  });

  it('reads the renderer type LIVE off the game rather than inferring it from config', () => {
    expect(hud).toMatch(/rendererLabel\(this\.game\.renderer\?\.type, Phaser\.WEBGL, Phaser\.CANVAS\)/);
  });

  // #467: the control-hints + debug d-pad cheat-sheet assertion was DELETED here rather than
  // repaired. #463 removed that top-left help text from HudScene outright ("all the 'controls'
  // help text on top left should also be removed"), so there is no longer any line for a
  // dev-gate guard to guard — the per-slot skill tiles carry the binds now.

  it('MOUSE + KB (a control-method-only string) is never emitted behind a live DEV guard', () => {
    // Belt-and-braces, inverse of the old DEV-guard pin: the literal must exist, and no `if
    // (import.meta.env.DEV)` guard (as opposed to a comment merely mentioning the flag — several
    // still do, explaining the #523 change) precedes it.
    const idx = hud.indexOf("'MOUSE + KB'");
    expect(idx).toBeGreaterThan(-1);
    expect(hud.lastIndexOf('if (import.meta.env.DEV)', idx)).toBe(-1);
  });
});

describe('#529 tabBar: MECH LAB/AUDIO/ART tabs are gone — moved to the Mech Lab\'s own tabs / the pause menu', () => {
  it('TABS is now empty — no scene-navigation tabs live in the shared header any more', () => {
    expect(tabBar).toMatch(/const TABS = \[\];/);
  });

  it('#470/#461: AudioScene/ArtPreviewScene are still registered by DEV-guarded dynamic imports (never in a prod bundle) — only their ACCESS moved, not their dev-only-ness', () => {
    expect(main).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{[\s\S]*?import\('\.\/scenes\/AudioScene\.js'\)/);
    expect(main).not.toMatch(/^import AudioScene from/m);
    // #523: PauseMenuScene joined the always-on array (it's a production feature, not a dev-only
    // authoring tool), and the array wrapped onto multiple lines — match loosely on the scene
    // names/order rather than exact whitespace.
    expect(main).toMatch(/scene: \[\s*BootScene, BaseScene, GarageScene, MissionSelectScene, ArenaScene, HudScene,\s*PauseMenuScene,?\s*\]/);
  });

  it('#529: AUDIO/ART/STATS access instead lives in the pause menu (dev-only nav rows)', () => {
    const pauseMenuData = readFileSync(join(DIR, '..', 'data', 'pauseMenu.js'), 'utf8');
    expect(pauseMenuData).toMatch(/DEV_NAV_ROWS = \['audio', 'art', 'stats'\]/);
  });

  it('#445: in-row `actions` reuse the tab rect geometry (same size + vertical alignment)', () => {
    expect(tabBar).toMatch(/for \(const action of actions\) \{[\s\S]*?scene\.add\.rectangle\(x, y, tabW, tabH/);
  });

  it('#445: in-row actions advance the same x cursor the tabs do (one shared gap)', () => {
    const body = tabBar.match(/for \(const action of actions\) \{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/x \+= tabW \+ gap;/);
  });
});

// #470: the SFX-authoring surface used to live in the garage behind a #296 DEV gate, which meant
// the mech lab LAID ITSELF OUT differently in dev (a 300px panel reserve) than in production. The
// whole surface moved to the dev-only AUDIO tab (scenes/AudioScene.js), so the fix isn't a better
// gate — it's that the garage has no sound surface to gate at all. #505 briefly replaced the
// full-width WeaponCardList catalog with a condensed per-column icon grid, then (per Jackson's
// second round of playtest feedback) put a `compact` WeaponCardList back per column — see
// GarageScene.abilityCore.guard.test.js. The old single-editor scene's exact shape (`_topRegion`,
// `this.list.destroy()`) still doesn't describe this scene (there's no single `this.list` — each
// column owns its own `col.catalogList`), but `onSelect` wiring is back.
describe('#470 GarageScene: the SFX-authoring surface is gone (not merely dev-gated)', () => {
  it('never references the WeaponSfxPanel or any of its trigger rows', () => {
    for (const symbol of [
      'WeaponSfxPanel', 'weaponSfxPanel', 'this.panel', 'sfxDomains', 'SFX_UI_GROUPS',
      'EXPLOSION_CATEGORIES', 'explosionSfxId', '_buildExplosionRow', '_buildUiRow',
      '_buildAutofireRow', 'autoFireEnabled',
    ]) {
      expect(garage).not.toContain(symbol);
    }
  });

  it('a catalog card click goes straight to the mount path (no panel detour)', () => {
    expect(garage).toMatch(/onSelect:\s*\(id\)\s*=>\s*this\._clickCatalogItem\(col, id\)/);
  });

  it('#445: the run-stats overlay is constructed only under import.meta.env.DEV', () => {
    expect(garage).toMatch(/if \(import\.meta\.env\.DEV\) this\._statsOverlay = new StatsOverlay\(this\);/);
  });

  // #529: STATS access moved from a tab-bar `actions` entry into the pause menu (openStats
  // callback) — the tab bar no longer carries a STATS action at all.
  it('#529: the tab bar no longer carries a STATS `actions` entry — GarageScene passes openStats to wirePauseMenu instead', () => {
    expect(garage).not.toMatch(/actions: \[/);
    expect(garage).toMatch(/wirePauseMenu\(this, \{ openStats: \(\) => this\._statsOverlay\?\.open\(\) \}\);/);
  });

  it('#529: STATS is never a free-floating this.button(...) on the garage itself', () => {
    expect(garage).not.toMatch(/this\.button\([^\n]*'STATS'/);
  });
});
