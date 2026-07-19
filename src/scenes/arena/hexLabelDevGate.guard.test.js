// #270 playtest follow-up: both hex-label systems (bases.js's dock/alertTower/objective
// tags + terrainLabels.js's per-terrain pool) are a playtest legibility aid, never meant to ship
// in production — so ArenaScene.js gates their auto-invocation behind `import.meta.env.DEV`
// (Vite's build-time flag, stripped in `npm run build`) and adds a live L-key toggle (dev-only
// too) so they can be hidden/shown without a restart. ArenaScene extends Phaser.Scene and is
// Phaser-API-heavy, so — same technique as sfxCallSites.guard.test.js and
// GarageScene.repairOnEntry.guard.test.js — this is a source-text guard over the real file, not
// a constructed instance.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const arenaScene = readFileSync(join(DIR, '..', 'ArenaScene.js'), 'utf8');

function bodyOf(methodPattern) {
  const match = arenaScene.match(methodPattern);
  expect(match, `expected to find method matching ${methodPattern}`).toBeTruthy();
  return match[0];
}

describe('#270: hex-label systems are dev-gated in ArenaScene#create', () => {
  it('_spawnHexLabels and _initTerrainLabels are called inside an import.meta.env.DEV guard', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\._spawnHexLabels\(\);\s*\n\s*this\._initTerrainLabels\(\);/);
  });

  it('the L keybind (hex-label toggle) is also dev-gated', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*\n\s*this\.input\.keyboard\.on\('keydown-L', \(\) => this\._toggleHexLabels\(\)\);/);
  });

  it('_hexLabelsVisible is initialized unconditionally (not itself inside the DEV guard), defaulting to true', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    const flagIdx = create.indexOf('this._hexLabelsVisible = true;');
    const guardIdx = create.indexOf('if (import.meta.env.DEV) {\n      this._spawnHexLabels();');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(guardIdx);
  });
});

describe('#270: _updateTerrainLabels\'s per-frame call is also dev-gated', () => {
  it('update() only calls _updateTerrainLabels when import.meta.env.DEV', () => {
    const update = bodyOf(/update\(_time, delta\)\s*\{[\s\S]*?\n {2}\}/);
    expect(update).toMatch(/if \(import\.meta\.env\.DEV\) this\._updateTerrainLabels\(view, dt\);/);
  });
});

describe('#270: _toggleHexLabels flips _hexLabelsVisible and re-applies it to every live label', () => {
  it('the method exists, flips the flag, and calls setVisible on both label collections', () => {
    const toggle = bodyOf(/_toggleHexLabels\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(toggle).toMatch(/this\._hexLabelsVisible = !this\._hexLabelsVisible;/);
    expect(toggle).toMatch(/this\._hexLabels[\s\S]*setVisible\(this\._hexLabelsVisible\)/);
    expect(toggle).toMatch(/this\._terrainLabelPool[\s\S]*setVisible\(this\._hexLabelsVisible\)/);
  });
});
