// #270 playtest follow-up: unify hex-label styling (this file's per-terrain labels used to be a
// deliberately distinct muted-gray/low-alpha look vs. bases.js's bold red — now both share one
// style, see hexLabelStyle.js) and add a live visibility toggle (`_hexLabelsVisible`, flipped by
// ArenaScene's L keybind — see hexLabelDevGate.guard.test.js for the wiring itself). This file
// covers `_initTerrainLabels`/`_updateTerrainLabels`'s own behavior: pooled labels use the
// shared style, and a newly-created label picks up whatever `_hexLabelsVisible` currently is.
import { describe, it, expect } from 'vitest';
import { TerrainLabelsMixin } from './terrainLabels.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';
import { HEX_LABEL_COLOR, HEX_LABEL_FONT_SIZE, HEX_LABEL_FONT_STYLE } from './hexLabelStyle.js';

// Same chainable-fake `add.text` style as dormantWake.test.js's hex-label tests, now with
// setVisible tracked so tests can assert on it.
function makeScene({ hexLabelsVisible } = {}) {
  const created = [];
  const scene = {
    _hexLabelsVisible: hexLabelsVisible,
    add: {
      text: (x, y, s, style) => {
        const label = {
          x, y, text: s, style, visible: true,
          setOrigin() { return this; }, setDepth() { return this; },
          setVisible(v) { this.visible = v; return this; },
        };
        created.push(label);
        return label;
      },
    },
  };
  Object.assign(scene, TerrainLabelsMixin);
  return { scene, created };
}

// A minimal one-hex terrain map + view rect centred on it, big enough radius to include it.
function oneHexTerrain(q = 0, r = 0, id = 'grass') {
  const terrain = new Map();
  terrain.set(axialKey(q, r), id);
  const { x, y } = hexToPixel(q, r);
  const view = { x: x - 50, y: y - 50, width: 100, height: 100 };
  return { terrain, view };
}

describe('#270: terrainLabels.js pooled labels use the SHARED style (unified with bases.js)', () => {
  it('a newly-created pooled label matches hexLabelStyle.js exactly', () => {
    const { scene, created } = makeScene();
    scene.bases = [];
    scene.alertTowerHexes = [];
    scene._initTerrainLabels();
    const { terrain, view } = oneHexTerrain();
    scene.terrain = terrain;

    scene._updateTerrainLabels(view, 1);

    expect(created.length).toBe(1);
    expect(created[0].style.color).toBe(HEX_LABEL_COLOR);
    expect(created[0].style.fontSize).toBe(HEX_LABEL_FONT_SIZE);
    expect(created[0].style.fontStyle).toBe(HEX_LABEL_FONT_STYLE);
    // Same red bases.js uses, no more muted-gray/low-alpha distinction.
    expect(created[0].style.color).toBe('#ff4444');
  });
});

describe('#270: terrainLabels.js honours the live hex-label visibility toggle', () => {
  it('a label created while _hexLabelsVisible is true is visible', () => {
    const { scene, created } = makeScene({ hexLabelsVisible: true });
    scene.bases = [];
    scene.alertTowerHexes = [];
    scene._initTerrainLabels();
    const { terrain, view } = oneHexTerrain();
    scene.terrain = terrain;

    scene._updateTerrainLabels(view, 1);

    expect(created[0].visible).toBe(true);
  });

  it('a label created while _hexLabelsVisible is false is created hidden', () => {
    const { scene, created } = makeScene({ hexLabelsVisible: false });
    scene.bases = [];
    scene.alertTowerHexes = [];
    scene._initTerrainLabels();
    const { terrain, view } = oneHexTerrain();
    scene.terrain = terrain;

    scene._updateTerrainLabels(view, 1);

    expect(created[0].visible).toBe(false);
  });

  it('defaults to visible when _hexLabelsVisible is unset (test-harness safety, real ArenaScene always sets it)', () => {
    const { scene, created } = makeScene();   // no hexLabelsVisible passed -> undefined
    scene.bases = [];
    scene.alertTowerHexes = [];
    scene._initTerrainLabels();
    const { terrain, view } = oneHexTerrain();
    scene.terrain = terrain;

    scene._updateTerrainLabels(view, 1);

    expect(created[0].visible).toBe(true);
  });
});
