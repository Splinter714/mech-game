// #468: the ENEMIES tab's NORMALIZED ↔ TRUE RELATIVE SCALE toggle. ArtPreviewScene extends
// Phaser.Scene and is Phaser-API-heavy, so — same technique as devGating.guard.test.js — these are
// source-text guards over the real file rather than a constructed instance. The arithmetic itself
// is unit-tested for real in data/unitScale.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const scene = readFileSync(join(DIR, 'ArtPreviewScene.js'), 'utf8');

describe('#468 ArtPreviewScene: the ENEMIES scale toggle', () => {
  it('starts NORMALIZED — the toggle is opt-in, not the default', () => {
    expect(scene).toMatch(/this\.trueScale = false;/);
  });

  it('offers the toggle as a control-strip button that names the CURRENT mode', () => {
    expect(scene).toMatch(/`SCALE: \$\{this\.trueScale \? 'TRUE RELATIVE' : 'NORMALIZED'\}`/);
  });

  it('shows the button only on the ENEMIES view, and flips the flag + rebuilds on click', () => {
    const block = scene.match(/if \(this\.view === 'ENEMIES'\) \{[\s\S]*?\n {4}\}/)[0];
    expect(block).toMatch(/SCALE: /);
    expect(block).toMatch(/this\.trueScale = !this\.trueScale;/);
    expect(block).toMatch(/this\._buildControls\(\);/);
    expect(block).toMatch(/this\._rebuild\(\);/);
  });

  it('renders the ON state with the shared `active` styling, so the mode is visible at a glance', () => {
    const block = scene.match(/if \(this\.view === 'ENEMIES'\) \{[\s\S]*?\n {4}\}/)[0];
    expect(block).toMatch(/\{ active: this\.trueScale \}/);
  });
});

describe('#468 ArtPreviewScene: what TRUE scale actually draws', () => {
  const body = scene.match(/_buildEnemies\(\) \{[\s\S]*?\n {2}\}/)[0];

  it('collects every unit\'s ink + game-scale factor BEFORE laying any group out', () => {
    // `_group` builds its cells synchronously, so a base settled mid-layout would give the
    // vehicles and the mechs two different scales — the exact comparison the toggle exists for.
    const firstGroup = body.indexOf('this._group(');
    expect(firstGroup).toBeGreaterThan(-1);
    const setup = body.slice(0, firstGroup);
    expect(setup).toMatch(/vehicleScaleFactor\(def\)/);
    expect(setup).toMatch(/note\(this\._mechKeys\(key\), MECH_SCALE_FACTOR\)/);
  });

  it('puts vehicles and enemy mechs on the SAME shared base scale', () => {
    expect(scene).toMatch(/trueScaleBase\(this\._trueEntries \?\? \[\], box\)/);
    // one cached base per cell-size, so a zoom change recomputes but a row does not drift
    expect(scene).toMatch(/if \(this\._trueBox !== box\)/);
  });

  it('falls back to per-cell fitting whenever no factor is supplied (normalized stays intact)', () => {
    expect(scene).toMatch(/_unitScale\(u, box, factor\) \{\s*\n\s*return factor == null \? this\._fit\(u\.w, u\.h, box\) : this\._trueBase\(box\) \* factor;/);
  });

  it('drops the mech row\'s shared ink in TRUE mode (the tab-wide scale supersedes it)', () => {
    expect(body).toMatch(/const enemyInk = on \? null : this\._inkUnion\(/);
  });

  it('labels both groups as TRUE SCALE while the toggle is on', () => {
    expect(body).toMatch(/TRUE SCALE/);
  });
});
