// #528: Jackson's report — "when in garage, the bottom panel that contains all of the mech
// preview and ability buttons and stuff should NOT allow clicks to pass through it (currently
// it's allowing clicks to pass through and select different weapons that are obscured behind
// it)". Root cause: WeaponCardList (ui/weaponCardList.js) scrolls its cards under a geometry
// mask (`scroller.setMask(...)`) that clips RENDERING only — Phaser's input hit-test still finds
// a scrolled-off (invisible) card at its real position, and since it's its own top-level
// container added to the scene AFTER col.layer, it also won the hit-test (Phaser's default
// `topOnly` mode picks whichever interactive object rendered LAST at that screen point). Nothing
// in col.layer's loadout panel (the mech-preview Graphics, the gaps between tiles) was interactive
// at all, so a click there fell straight through to that scrolled-off card, silently re-mounting
// a different weapon.
//
// The fix has two parts, both wired in GarageScene.js's `_buildColumn`: (1) an invisible
// interactive rect (`col.panelBlocker`) covering `gl.panel` — the loadout row's full bounding box
// from garage/columnLayout.js, geometry-tested in columnLayout.test.js — added FIRST so every
// real tile/preview object (added afterward) still wins its own exact rect; (2) `col.layer` is
// brought back to the top of the scene's display list once the column (including its
// WeaponCardList catalog) is fully built, so the whole loadout panel — including panelBlocker and
// every tile's own hit area — wins the input hit-test against any catalog card underneath.
//
// GarageScene is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling guards —
// loadoutRework/abilityCore/previewAccent/repairOnEntry/columnWidth), so this is a source-text
// guard, same technique as those.
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

describe('#528 — the loadout panel (mech preview + tiles) blocks clicks from reaching the catalog underneath', () => {
  it('_buildColumn creates an interactive panelBlocker over gl.panel, added to col.layer BEFORE the readyBg/tiles/preview it must lose to', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/col\.panelBlocker = this\.add\.rectangle\(gl\.panel\.x, gl\.panel\.y, gl\.panel\.w, gl\.panel\.h, 0x000000, 0\)\s*\n\s*\.setOrigin\(0, 0\)\.setInteractive\(\);/);
    expect(body).toContain('col.layer.add(col.panelBlocker);');

    // Ordering matters: panelBlocker must be added to col.layer's own child list BEFORE the
    // readyBg tile-row/preview objects, so those still win Phaser's topOnly hit-test over their
    // own exact rects — panelBlocker should only catch the gaps/preview-art area they don't cover.
    const blockerIdx = body.indexOf('col.panelBlocker = this.add.rectangle');
    const readyIdx = body.indexOf('col.readyBg = this.add.rectangle');
    const previewIdx = body.indexOf('col.previewPanel = this.add.graphics();');
    expect(blockerIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeLessThan(readyIdx);
    expect(blockerIdx).toBeLessThan(previewIdx);
  });

  it('_buildColumn brings col.layer to the top of the scene display list AFTER col.catalogList exists, so the panel wins the hit-test against the catalog', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toContain('this.children.bringToTop(col.layer);');

    const catalogIdx = body.indexOf('col.catalogList = new WeaponCardList(');
    const bringIdx = body.indexOf('this.children.bringToTop(col.layer);');
    expect(catalogIdx).toBeGreaterThan(-1);
    expect(bringIdx).toBeGreaterThan(catalogIdx);
  });

  it('_relayoutColumns\' teardown (col.layer.destroy(true)) still cleans up panelBlocker — no separate destroy call was added for it', () => {
    expect(src).not.toMatch(/col\.panelBlocker\.destroy/);
    expect(src).toContain('col?.layer?.destroy(true);');
  });
});
