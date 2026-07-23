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

describe('#449 HudScene: the performance readout is dev-gated again (stripped from production)', () => {
  // #296 gated the FPS counter dev-only; #334 reversed that so Jackson could diagnose a Windows/Edge
  // frame-rate problem on the live build; #449 puts it BACK behind DEV ("remove FPS data from
  // production") now that diagnostic run is over. The assertions below are #334's, inverted.
  it('the performance readout is created only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText = this\.add\.text/);
  });

  it('the performance readout is updated only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText\.setText\(perfLines\(\{/);
  });

  it('the one-off renderer/GPU probes are inside the same guard (no probe in production)', () => {
    // Anchored on the fpsText guard itself, so the probes have to sit in THAT block — not merely
    // somewhere after some earlier DEV guard.
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.fpsText = this\.add\.text[\s\S]*?this\._perfRenderer = rendererLabel[\s\S]*?this\._perfGpu = gpuRendererString/);
  });

  it('reads the renderer type LIVE off the game rather than inferring it from config', () => {
    expect(hud).toMatch(/rendererLabel\(this\.game\.renderer\?\.type, Phaser\.WEBGL, Phaser\.CANVAS\)/);
  });
});

describe('#296 HudScene: control hints / control-method / AI readouts stay dev-gated', () => {
  it('the control-method (modeText) + AI (aiText) overlays are created only under import.meta.env.DEV', () => {
    // #452 follow-up: the cluster's backing plate (`devPanelGfx`) was created inside this same
    // guard, so the assertion allows lines between the guard and `modeText` — what it pins is
    // that BOTH overlays (and the plate that backs them) are inside a DEV block, not their order.
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{[\s\S]*?this\.modeText = this\.add\.text[\s\S]*?this\.aiText = this\.add\.text/);
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{[\s\S]*?this\.devPanelGfx = this\.add\.graphics/);
  });

  it('the control-method + AI overlays are updated only under import.meta.env.DEV', () => {
    expect(hud).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.modeText\.setText[\s\S]*?this\.aiText\.setText/);
  });

  // #467: the control-hints + debug d-pad cheat-sheet assertion was DELETED here rather than
  // repaired. #463 removed that top-left help text from HudScene outright ("all the 'controls'
  // help text on top left should also be removed"), so there is no longer any line for a
  // dev-gate guard to guard — the per-slot skill tiles carry the binds now.

  it('MOUSE + KB (a control-method-only string) is never emitted outside a DEV guard', () => {
    // Belt-and-braces: the only occurrence of the literal sits inside the gated update() block.
    const idx = hud.indexOf("'MOUSE + KB'");
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = hud.lastIndexOf('import.meta.env.DEV', idx);
    expect(guardIdx).toBeGreaterThan(-1);
  });
});

describe('#296/#470 tabBar: the AUDIO tab is dev-only', () => {
  it('the AUDIO/AudioScene tab is spread into TABS only under import.meta.env.DEV', () => {
    expect(tabBar).toMatch(/\.\.\.\(import\.meta\.env\.DEV \? \[\{ key: 'AUDIO', scene: 'AudioScene' \}\] : \[\]\)/);
  });

  it('#470: AudioScene is registered by a DEV-guarded dynamic import (never in a prod bundle)', () => {
    expect(main).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{[\s\S]*?import\('\.\/scenes\/AudioScene\.js'\)/);
    // ...and NOT statically imported / listed in the always-on scene array.
    expect(main).not.toMatch(/^import AudioScene from/m);
    expect(main).toMatch(/scene: \[BootScene, GarageScene, ArenaScene, HudScene\],/);
  });

  it('#461: the ART/ArtPreviewScene tab is spread into TABS only under import.meta.env.DEV', () => {
    expect(tabBar).toMatch(/\.\.\.\(import\.meta\.env\.DEV \? \[\{ key: 'ART', scene: 'ArtPreviewScene' \}\] : \[\]\)/);
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

// #470: the SFX-authoring surface used to live in the garage behind a #296 DEV gate, which meant
// the mech lab LAID ITSELF OUT differently in dev (a 300px panel reserve) than in production. The
// whole surface moved to the dev-only AUDIO tab (scenes/AudioScene.js), so the fix isn't a better
// gate — it's that the garage has no sound surface to gate. These assertions are the inverse of
// the ones they replaced: the references must be ABSENT, and the catalog region unconditional.
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

  it('_topRegion is a single unconditional full-width catalog rect — no dev-vs-prod branch', () => {
    const body = garage.match(/_topRegion\(top\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(body).toMatch(/return \{ list: \{ x: 20, y: top, w: this\.W - 40, h: bottom - top \} \};/);
    expect(body).not.toContain('import.meta.env.DEV');
  });

  it('a catalog card click goes straight to the mount path (no panel detour)', () => {
    expect(garage).toMatch(/onSelect: \(id\) => this\._pickItem\(id\)/);
  });

  it('shutdown just destroys the card list', () => {
    expect(garage).toMatch(/this\.events\.once\('shutdown', \(\) => this\.list\.destroy\(\)\);/);
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
});
