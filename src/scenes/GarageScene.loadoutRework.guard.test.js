// #505 THIRD rework — Jackson's five-part playtest note, dense: (1) the loadout section should
// be "nearly identical to the in-game UI... just that same layout of buttons" — reusing the REAL
// shared skillTiles.js/HudScene.js tile code, not a look-alike; (2) the mech preview should be
// "the same height as that button layout AND should be left of those buttons"; (3) "arrow keys
// should function the same as d-pad in the garage"; (4) "color select label and swatch should
// not be visible"; (5) "any player1 label should just be at the bottom below the mech preview
// art". The actual pixel math for (1)/(2) is unit-tested for real in
// src/scenes/garage/columnLayout.test.js (garageColumnLayout calls the genuine
// ui/skillTiles.js `weaponAbilityRows`) — this file is the source-text guard for the wiring
// GarageScene.js itself does around that, following the same technique as the sibling
// previewAccent/abilityCore/repairOnEntry/columnWidth guards (GarageScene is Phaser-API-heavy
// and isn't instantiable under Vitest).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

function bodyOf(methodPattern) {
  const match = src.match(methodPattern);
  expect(match, `expected to find method matching ${methodPattern}`).toBeTruthy();
  return match[0];
}

describe('#505 THIRD rework — loadout tiles reuse the real shared HUD layout code', () => {
  it('_buildColumn gets its geometry from garageColumnLayout, imported from garage/columnLayout.js', () => {
    expect(src).toMatch(/import \{ garageColumnLayout \} from '\.\/garage\/columnLayout\.js';/);
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/const gl = garageColumnLayout\(w, h, \{ pad \}\);/);
  });

  it('columnLayout.js itself calls the REAL skillTiles.js weaponAbilityRows, not a reimplementation', () => {
    const layout = readFileSync(join(DIR, 'garage', 'columnLayout.js'), 'utf8');
    expect(layout).toMatch(/import \{ weaponAbilityRows \} from '\.\.\/\.\.\/ui\/skillTiles\.js';/);
    expect(layout).toContain('weaponAbilityRows(tileAreaX, tileBlockW');
    // No hardcoded ability-below-weapon or icon-layout assumption baked in here — the block's
    // own top/bottom fall out of whatever weaponAbilityRows currently returns.
    expect(layout).not.toMatch(/abilityTop|weaponTop|iconCx|iconCy/);
  });

  it('the diamond ability layout (superseded by weaponAbilityRows for this section) is no longer imported/used', () => {
    expect(src).not.toMatch(/diamondLayout/);
  });

  it('drawSkillTile draws every weapon, ability, AND the passive tile from gl.tiles/gl.passive, the shared layout\'s own rects', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/for \(const rect of \[\.\.\.gl\.tiles\.weapons, \.\.\.gl\.tiles\.abilities, gl\.passive\]\) this\._drawColTile\(col, rect\);/);
  });

  // #505 FIFTH rework (fresh playtest correction): the passive/core slot moved out of the old
  // per-column header band entirely, into its own tile ABOVE the mech preview — see
  // garage/columnLayout.js's `passive` rect. It's drawn in the same loop as every other tile now
  // (above), not via a separate coreTileRect(...) call.
  it('the core (passive) tile is no longer drawn via a standalone coreTileRect(...) call in a header band', () => {
    expect(src).not.toContain('coreTileRect');
  });
});

describe('#505 THIRD rework — mech preview: left of the tile block, same height', () => {
  it('the preview panel/scale come from gl.preview (garageColumnLayout), not a fixed square box', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/const \{ cx: previewCx, cy: previewCy, w: previewW, h: previewH \} = gl\.preview;/);
  });

  it('no leftover PREVIEW_BOX square-box sizing from the earlier rework', () => {
    expect(src).not.toContain('PREVIEW_BOX');
  });
});

// #505 playtest follow-up: "round the mech preview box, matching the weapon/ability tiles" — the
// panel is now a Graphics painted with the SAME paintTilePlate the skill tiles themselves use,
// not a plain squared-off Rectangle.
describe('#505 playtest follow-up — mech preview panel reuses the shared tile-plate paint', () => {
  it('imports paintTilePlate from the shared skillTiles module', () => {
    expect(src).toMatch(/import \{ [^}]*paintTilePlate[^}]* \} from '\.\.\/ui\/skillTiles\.js';/);
  });

  it('previewPanel is a Graphics object painted via paintTilePlate over the preview rect, not a plain Rectangle', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/col\.previewPanel = this\.add\.graphics\(\);/);
    expect(body).toMatch(/paintTilePlate\(col\.previewPanel, \{ x: previewCx - previewW \/ 2, y: previewCy - previewH \/ 2, w: previewW, h: previewH \}\);/);
    expect(body).not.toMatch(/this\.add\.rectangle\(previewCx, previewCy, previewW, previewH/);
  });
});

describe('#505 THIRD rework — arrow keys mirror the pad d-pad exactly', () => {
  it('LEFT/RIGHT call _cycleColor on column 0, same as DPAD_LEFT/RIGHT do for a pad column', () => {
    expect(src).toContain("this.input.keyboard.on('keydown-LEFT', () => this._cycleColor(this.cols[0], -1));");
    expect(src).toContain("this.input.keyboard.on('keydown-RIGHT', () => this._cycleColor(this.cols[0], 1));");
    expect(src).toContain('if (e.pressed(PAD.DPAD_LEFT)) { this._cycleColor(col, -1); continue; }');
    expect(src).toContain('if (e.pressed(PAD.DPAD_RIGHT)) { this._cycleColor(col, 1); continue; }');
  });

  it('UP/DOWN call the SAME _stepSlot helper the pad\'s DPAD_UP/DOWN uses — one mapping, not two', () => {
    expect(src).toContain("this.input.keyboard.on('keydown-UP', () => this._stepSlot(this.cols[0], -1));");
    expect(src).toContain("this.input.keyboard.on('keydown-DOWN', () => this._stepSlot(this.cols[0], 1));");
    expect(src).toContain('if (e.pressed(PAD.DPAD_UP)) { this._stepSlot(col, -1); continue; }');
    expect(src).toContain('if (e.pressed(PAD.DPAD_DOWN)) { this._stepSlot(col, 1); continue; }');
    const stepSlotBody = bodyOf(/_stepSlot\(col, dir\)\s*\{[\s\S]*?\n {2}\}/);
    expect(stepSlotBody).toMatch(/ALL_SLOTS\[stepIndex\(ALL_SLOTS\.indexOf\(col\.selectedSlot\), dir, ALL_SLOTS\.length\)\]/);
  });
});

describe('#505 THIRD rework — colour-select swatch/label hidden, cycling still works', () => {
  it('no colorSwatch/colorName/colorHint display objects are created any more', () => {
    expect(src).not.toContain('colorSwatch');
    expect(src).not.toContain('colorName');
    expect(src).not.toContain('colorHint');
    expect(src).not.toContain('_refreshColorControl');
  });

  it('_cycleColor still mutates the mech\'s colour and re-bakes its texture — the functionality survives the UI removal', () => {
    const body = bodyOf(/_cycleColor\(col, dir\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toContain('cycleSwatch(builds, col.index, current, dir)');
    expect(body).toContain('col.mech.color = next;');
    expect(body).toContain('buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));');
  });
});

describe('#505 THIRD rework — player label moved onto the preview art (now INSIDE it, near the bottom — #505 playtest follow-up)', () => {
  it('headerLabel is positioned from gl.label (inside the preview, near its bottom), not a fixed header-row offset', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/col\.headerLabel = this\.add\.text\(gl\.label\.cx, gl\.label\.y, `PLAYER \$\{i \+ 1\}`/);
  });

  it('#505 seventh rework (playtest follow-up): the separate identity-colour dot is gone — the label text itself carries the colour instead', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).not.toContain('col.headerColor');
    expect(body).not.toMatch(/col\.headerColor = this\.add\.rectangle\(pad, 6,/);
    expect(body).toMatch(/col\.headerLabel = this\.add\.text\(gl\.label\.cx, gl\.label\.y, `PLAYER \$\{i \+ 1\}`, \{\s*\n\s*fontFamily: 'monospace', fontSize: '12px', color: hexColor\(mechColorFor\(col\.mech, i\)\),/);
  });
});

describe('#505 seventh rework (playtest follow-up) — the compact ready indicator is a pure status light, not a button', () => {
  it('col.readyBg is created with no setInteractive/pointerdown — clicking it does nothing', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    const readyBgStatement = body.match(/col\.readyBg = this\.add\.rectangle\([^;]*;/)?.[0];
    expect(readyBgStatement, 'expected a col.readyBg = this.add.rectangle(...) statement').toBeTruthy();
    expect(readyBgStatement).not.toContain('setInteractive');
    expect(readyBgStatement).not.toContain('pointerdown');
    expect(readyBgStatement).not.toContain('useHandCursor');
  });

  it('ready still toggles via its other existing triggers — keyboard D and gamepad START — independent of any click on the indicator', () => {
    expect(src).toContain("this.input.keyboard.on('keydown-D', () => this._toggleReady(0));");
    expect(src).toMatch(/if \(e\.pressed\(PAD\.START\)\) \{ this\._toggleReady\(i\); continue; \}/);
  });
});
