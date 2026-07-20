// #289: cover terrain (forest/scrub/drift/wreck/fumarole) now renders as TWO separately-placed
// Images per hex — a ground layer (unchanged depth/behaviour) and a new foliage/canopy overlay
// (hexArt.js's separate canopy texture pass) at a depth between GROUND_UNITS and LARGE_GROUND_UNITS
// (#289 follow-up), so a SMALL ground unit standing in cover renders BELOW the canopy (peeks out
// from under) while LARGE ground units and the player render ABOVE it. Non-cover hexes are
// unaffected — still exactly one Image. These tests build a real world via `_buildWorld` against
// a minimal fake Phaser `add`/`cameras`/`registry` (mirrors dockResupply.test.js's hand-rolled
// scene harness) and inspect the resulting `tileImages`/`canopyImages` maps directly, rather than
// re-deriving the placement logic — a genuine end-to-end check of what world.js actually builds.
import { describe, it, expect } from 'vitest';
import { WorldMixin } from './world.js';
import { DEPTH } from './shared.js';
import { COVER_CANOPY_IDS, canopyTexKey, isCoverCanopyId } from '../../art/hexArt.js';
import { getTerrain } from '../../data/terrain.js';

// A chainable fake Image game object — records the texture key and the depth it was set to.
function fakeImage(x, y, tex) {
  const obj = { x, y, tex, visible: true, depth: undefined };
  obj.setScale = () => obj;
  obj.setDepth = (d) => { obj.depth = d; return obj; };
  obj.setVisible = (v) => { obj.visible = v; return obj; };
  obj.setTexture = (t) => { obj.tex = t; return obj; };
  obj.destroy = () => { obj.destroyed = true; };
  return obj;
}

// A chainable fake Graphics/generic game object — enough surface for `_buildWorld`'s one-time
// boundary outline draw (`add.graphics().setDepth(...)`, then `.lineStyle()`/`.lineBetween()`)
// and `_outpostCollapseFx`'s flash/ring/debris (`add.circle`/`add.rectangle`, `tweens.add`),
// which `_damageBuildingAt` triggers on collapse. Mirrors mission.test.js's fake-scene pattern.
function fakeGraphics() {
  const obj = {};
  obj.setDepth = () => obj;
  obj.lineStyle = () => obj;
  obj.lineBetween = () => obj;
  obj.setStrokeStyle = () => obj;
  obj.destroy = () => {};
  return obj;
}

function makeScene() {
  const scene = {
    cameras: { main: { setBackgroundColor: () => {} } },
    registry: { set: () => {} },
    add: {
      image: (x, y, tex) => fakeImage(x, y, tex),
      graphics: () => fakeGraphics(),
      circle: () => fakeGraphics(),
      rectangle: () => fakeGraphics(),
    },
    tweens: { add: () => {} },
    px: 0, py: 0,
  };
  Object.assign(scene, WorldMixin);
  return scene;
}

describe('#289 cover terrain ground/canopy split', () => {
  it('every cover terrain id is registered for a canopy overlay', () => {
    expect(COVER_CANOPY_IDS.sort()).toEqual(['drift', 'forest', 'fumarole', 'scrub', 'wreck'].sort());
    for (const id of COVER_CANOPY_IDS) expect(isCoverCanopyId(id)).toBe(true);
    expect(isCoverCanopyId('grass')).toBe(false);
  });

  it('a cover hex gets TWO Images (ground + canopy) at the correct two depths; a non-cover hex gets exactly one', () => {
    const scene = makeScene();
    // Fixed seed for a reproducible layout (per `_buildWorld`'s own doc comment: pass a seed to
    // reproduce a run). The default biome (grassland) uses `forest` for its cover role.
    scene._buildWorld(12345);

    let sawCoverHex = false;
    let sawPlainHex = false;
    for (const [k, id] of scene.terrain) {
      const tex = getTerrain(id).tex;
      const groundImg = scene.tileImages.get(k);
      const canopyImg = scene.canopyImages.get(k);
      if (!groundImg) continue; // boundary-only ids never get a tile Image at all (unchanged, #222)

      // Every placed ground tile stays at DEPTH.TERRAIN regardless of cover.
      expect(groundImg.depth).toBe(DEPTH.TERRAIN);
      expect(groundImg.tex).toBe(tex);

      if (isCoverCanopyId(id)) {
        sawCoverHex = true;
        expect(canopyImg).toBeTruthy();
        expect(canopyImg.tex).toBe(canopyTexKey(tex));
        expect(canopyImg.depth).toBe(DEPTH.COVER_CANOPY);
        // #289 follow-up: the canopy sits strictly between the SMALL ground tier (GROUND_UNITS)
        // and the LARGE ground tier (LARGE_GROUND_UNITS) — small units peek out under it, large
        // units tower over it.
        expect(DEPTH.COVER_CANOPY).toBeGreaterThan(DEPTH.GROUND_UNITS);
        expect(DEPTH.COVER_CANOPY).toBeLessThan(DEPTH.LARGE_GROUND_UNITS);
        // Same hex centre as the ground tile.
        expect(canopyImg.x).toBe(groundImg.x);
        expect(canopyImg.y).toBe(groundImg.y);
      } else {
        sawPlainHex = true;
        expect(canopyImg).toBeUndefined();
      }
    }
    expect(sawCoverHex).toBe(true);   // the generated layout actually placed cover somewhere
    expect(sawPlainHex).toBe(true);   // ...and plenty of ordinary single-Image terrain too
  });

  it('DEPTH.COVER_CANOPY sits strictly between the small (GROUND_UNITS) and large (LARGE_GROUND_UNITS) ground tiers, both below UNITS', () => {
    expect(DEPTH.GROUND_UNITS).toBeLessThan(DEPTH.COVER_CANOPY);
    expect(DEPTH.COVER_CANOPY).toBeLessThan(DEPTH.LARGE_GROUND_UNITS);
    expect(DEPTH.LARGE_GROUND_UNITS).toBeLessThan(DEPTH.UNITS);
  });

  // Find a cover hex in the built world and return its key + the pixel centre of its ground image
  // (reuses the hex->pixel conversion the world build already did, rather than re-importing it).
  function findCoverHex(scene) {
    for (const [k, id] of scene.terrain) {
      if (isCoverCanopyId(id)) {
        const img = scene.tileImages.get(k);
        return { key: k, x: img.x, y: img.y };
      }
    }
    return null;
  }

  // #351: cover terrain is natural terrain, and natural terrain is now permanent scenery — so in
  // real play a canopy is never orphaned, because its hex can never collapse. This is the live
  // behaviour.
  it('#351 a cover hex cannot be shot down at all, so its canopy simply persists', () => {
    const scene = makeScene();
    scene._buildWorld(12345);
    const cover = findCoverHex(scene);
    expect(cover).toBeTruthy();
    const canopyImg = scene.canopyImages.get(cover.key);
    expect(canopyImg).toBeTruthy();
    const before = scene.terrain.get(cover.key);

    const destroyed = scene._damageBuildingAt(cover.x, cover.y, 100000); // one huge hit
    expect(destroyed).toBe(false);                       // nature is permanent
    expect(scene.terrain.get(cover.key)).toBe(before);   // still foliage, never rubble
    expect(canopyImg.destroyed).toBeFalsy();
    expect(scene.canopyImages.has(cover.key)).toBe(true);
  });

  // The #289 cleanup path itself is still correct and still runs for anything that DOES collapse —
  // and it is what the `NATURAL_TERRAIN_DESTRUCTIBLE` revert re-arms. Driven by forcing the hex
  // into `coverHp` exactly as worldgen would have before #351.
  it('the orphaned-canopy cleanup still fires for a cover hex that does collapse (#289, re-armed by a #351 revert)', () => {
    const scene = makeScene();
    scene._buildWorld(12345);
    const cover = findCoverHex(scene);
    const canopyImg = scene.canopyImages.get(cover.key);
    scene.coverHp.set(cover.key, getTerrain(scene.terrain.get(cover.key)).hp);

    const destroyed = scene._damageBuildingAt(cover.x, cover.y, 100000);
    expect(destroyed).toBe(true);
    expect(canopyImg.destroyed).toBe(true);
    expect(scene.canopyImages.has(cover.key)).toBe(false);
  });
});
