import { describe, it, expect } from 'vitest';
import {
  HEX_BLEED, HEX_TEX_W, HEX_TEX_H, BASE_INFRA_COLOR, terrainFillColor,
  buildHexTextures, COVER_CANOPY_IDS, canopyTexKey, isCoverCanopyId, BOUNDARY_ONLY_IDS,
  buildStreaks, clipSegToHex, HEX_LATTICE, RIVER_STREAK_SETS,
} from './hexArt.js';
import { ART_SCALE } from './_frames.js';
import { BIOMES, BIOME_IDS } from '../data/biomes.js';
import { HEX_SIZE, hexCorners, hexToPixel } from '../data/hexgrid.js';
import { TERRAIN } from '../data/terrain.js';

const SQRT3 = Math.sqrt(3);

// True containment in the pointy-top hex of circumradius `s` — the tile's actual BORDER, not a
// bounding circle. (#471 playtest follow-up: "none of the nice texture stuff should ever spill
// beyond the hex border". The base FILL still bleeds by HEX_BLEED on purpose — that's #255's seam
// fix — but a detail mark must stop at the border.)
const EPS = 1e-6;
function insideHex(dx, dy, s = HEX_SIZE) {
  const hw = (s + EPS) * SQRT3 / 2;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return ax <= hw && ay <= (s + EPS) * (1 - ax / (2 * hw));
}

// #255: hairline seams between adjacent hex tiles. hexToPixel places tile centres at their
// exact (irrational) tessellating spacing, and the placement math itself has no rounding
// (see hexgrid.test.js's round-trip coverage) — the seam comes from the RENDERED tile's own
// polygon fading to fully transparent exactly at the true hex boundary, combined with
// Phaser's `roundPixels` (then forced on by `pixelArt: true`, main.js — #455 has since turned
// it off) snapping each tile's on-screen position independently every frame as the camera
// scrolls. The bleed is kept as belt-and-braces regardless. The fix is bleeding
// each tile's outer polygon `HEX_BLEED` px past the true radius so its opaque interior
// already covers the boundary — these are pure-geometry checks that the bleed actually
// creates overlap (not just a bigger number) and that the texture canvas still comfortably
// contains the bled shape.
describe('hex tile edge bleed (#255 seam fix)', () => {
  it('HEX_BLEED is a positive amount of overdraw', () => {
    expect(HEX_BLEED).toBeGreaterThan(0);
  });

  it('an un-bled hex exactly touches (zero overlap, zero gap) its same-row neighbour', () => {
    // Pointy-top apothem (centre-to-flat-side) = size * sqrt3/2, which for HEX_SIZE is also
    // exactly half of hexToPixel's same-row neighbour spacing — confirms the boundary case
    // this bleed is meant to move away from.
    const apothem = HEX_SIZE * (SQRT3 / 2);
    const { x } = hexToPixel(1, 0);
    expect(apothem).toBeCloseTo(x / 2, 10);
  });

  it('the bled hex genuinely overlaps its neighbour at the shared edge', () => {
    const bledApothem = (HEX_SIZE + HEX_BLEED) * (SQRT3 / 2);
    const { x } = hexToPixel(1, 0); // same-row neighbour centre spacing
    const halfSpacing = x / 2;
    // The bled polygon's flat side now sits PAST the midpoint between the two centres —
    // i.e. this tile's opaque paint reaches into the neighbour's half of the boundary.
    expect(bledApothem).toBeGreaterThan(halfSpacing);
  });

  it('every bled corner still fits inside the texture canvas with room for its own AA ring', () => {
    const corners = hexCorners(HEX_SIZE + HEX_BLEED);
    const halfW = HEX_TEX_W / 2, halfH = HEX_TEX_H / 2;
    const AA_MARGIN = 0.4; // px of slack left for the bled edge's own anti-alias fade
    for (const p of corners) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(halfW - AA_MARGIN);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(halfH - AA_MARGIN);
    }
  });
});

// #269 playtest follow-up: `dock` and `alertTower` used to reuse the (since-removed, #275)
// `helipad`/`tower` outpost textures verbatim, which made them indistinguishable from a real
// helipad / a regular destructible outpost building in play. Each now has its own PAL entry
// (buildHexTextures wires every non-abstract PAL key to a `hex_<key>` texture automatically) —
// these checks confirm the wiring exists and terrain.js actually points at it, without needing a
// real Phaser scene to bake the textures.
describe('dock/alertTower distinct textures (#269 playtest follow-up)', () => {
  it('terrain.js points dock and alertTower at their own distinct texture keys', () => {
    expect(TERRAIN.dock.tex).toBe('hex_dock');
    expect(TERRAIN.alertTower.tex).toBe('hex_alertTower');
    expect(TERRAIN.dock.tex).not.toBe(TERRAIN.alertTower.tex);
  });

  it('alertTower stays on the shared base-infrastructure fill colour', () => {
    expect(terrainFillColor('alertTower')).toBe(BASE_INFRA_COLOR.fill);
  });

  // #395: a `dock` hex is now a recessed BLACK BAY (the doors are separate sliding sprites), so it
  // no longer shares the base-infra concrete fill — it's a distinctly darker shaft.
  it('dock is now a dark bay fill, distinct from the base-infra concrete', () => {
    const bay = terrainFillColor('dock');
    expect(bay).not.toBe(BASE_INFRA_COLOR.fill);
    expect(terrainFillColor('dockClosed')).toBe(bay);   // both dock states share the same black bay
    expect(bay).toBeLessThan(0x222222);                 // unambiguously dark
  });
});

// #289: cover terrain (forest/scrub/drift/wreck/fumarole) now bakes a SECOND, separate texture —
// a transparent-background canopy/foliage overlay — alongside its existing ground texture, so
// world.js can place both as independent Images at different depths. A fake Phaser-shaped
// `scene.make.graphics()` stands in for the real canvas (mirrors dockResupply.test.js's approach
// elsewhere in the codebase); `generateTexture` just records which keys got baked, so these
// checks confirm the REGISTRY wiring (every cover id gets both a ground key and a canopy key)
// without needing a real GPU/canvas context.
function fakeGraphicsScene() {
  const registered = new Set();
  const noop = () => {};
  return {
    make: {
      graphics: () => ({
        fillStyle: noop, lineStyle: noop, fillRect: noop, fillCircle: noop,
        fillEllipse: noop, fillTriangle: noop, fillPoints: noop,
        generateTexture: (key) => registered.add(key),
        destroy: noop,
      }),
    },
    textures: { exists: () => false, get: () => ({ getSourceImage: () => ({ getContext: () => null }) }) },
    _registered: registered,
  };
}

describe('cover terrain ground/canopy texture split (#289)', () => {
  it('lists exactly the 5 walk-through cover terrain ids', () => {
    expect([...COVER_CANOPY_IDS].sort()).toEqual(['drift', 'forest', 'fumarole', 'scrub', 'wreck'].sort());
  });

  it('canopyTexKey accepts both a bare terrain id and a hex_-prefixed texture key', () => {
    expect(canopyTexKey('forest')).toBe('hex_forest_canopy');
    expect(canopyTexKey('hex_forest')).toBe('hex_forest_canopy');
  });

  it('isCoverCanopyId is true only for the 5 cover ids, false for ordinary terrain', () => {
    for (const id of COVER_CANOPY_IDS) {
      expect(isCoverCanopyId(id)).toBe(true);
      expect(isCoverCanopyId(`hex_${id}`)).toBe(true);
    }
    expect(isCoverCanopyId('grass')).toBe(false);
    expect(isCoverCanopyId('hex_alertTower')).toBe(false);
  });

  // #464: a cover id's GROUND texture is whatever its TERRAIN entry names — since the merge that's
  // its cleared twin's tile (`hex_forestCleared`), not `hex_<id>`. The canopy key is still derived
  // from the ID, which is exactly the split this asserts.
  it('buildHexTextures bakes both a ground texture and a canopy texture for every cover id', () => {
    const scene = fakeGraphicsScene();
    buildHexTextures(scene);
    for (const id of COVER_CANOPY_IDS) {
      expect(scene._registered.has(TERRAIN[id].tex), id).toBe(true);
      expect(scene._registered.has(canopyTexKey(id)), id).toBe(true);
      // The old per-id ground tile is genuinely gone, not just unreferenced.
      expect(scene._registered.has(`hex_${id}`), id).toBe(false);
    }
    // Non-cover terrain (e.g. plain grass) still gets exactly its one ground texture — no
    // canopy key is ever baked for it.
    expect(scene._registered.has('hex_grass')).toBe(true);
    expect(scene._registered.has('hex_grass_canopy')).toBe(false);
  });
});

// #464 (playtest, owner: "I'm still seeing the art for the deep hexes, which we talked about not
// needing"). The five world-boundary-only ids are the biomes' `deep` role. #222's 4th pass stopped
// placing ring tiles in the arena entirely (the ring is one flat camera-background fill), so their
// baked tiles had no renderer left except the art gallery — where they showed as five flat swatches.
// The tiles are gone; the PAL fill they were drawn from stays, because that IS the background fill.
describe('world-boundary "deep" terrain has no baked tile (#464)', () => {
  it('bakes no ground texture for any boundary-only id', () => {
    const scene = fakeGraphicsScene();
    buildHexTextures(scene);
    for (const id of BOUNDARY_ONLY_IDS) {
      expect(scene._registered.has(`hex_${id}`), id).toBe(false);
      expect(scene._registered.has(TERRAIN[id].tex), id).toBe(false);
    }
  });

  it('still exposes each boundary id\'s fill colour for the camera background', () => {
    for (const id of BOUNDARY_ONLY_IDS) {
      expect(typeof terrainFillColor(id), id).toBe('number');
    }
  });

  it('every biome\'s deep role is a boundary-only id, so no biome loses a rendered tile', () => {
    for (const bid of BIOME_IDS) expect(BOUNDARY_ONLY_IDS.has(BIOMES[bid].deep), bid).toBe(true);
  });
});

// #447 (owner: "hexes like mud shouldn't have a central art pattern, they should have a generally
// diffuse, vague texture"). A hex is HEX_SIZE=48 across, but mud's detail used to be a single
// 24x14 puddle ellipse plus two pockmarks and a crack, all inside ~±12px of the centre — a small
// stamped motif in the middle of a large flat tile, identical on every mud hex. These checks pin
// the property that matters and is invisible to eyeball-by-diff: the detail marks reach out to the
// tile's edges in EVERY direction, so no centre reads as "the pattern".
//
// The recording scene captures the shapes each texture's draw fn emits, keyed by the texture name
// `generateTexture` is finally called with. Coordinates come through scaled by ART_SCALE (the
// super-sampling wrapper), so they're divided back down to the design grid here.
//
// #471 playtest follow-up: this used to record only each shape's ANCHOR (an ellipse's centre, a
// triangle's first vertex), which is exactly why the containment check below couldn't see the
// spill the owner reported — a blotch seeded just inside the rim has a centre inside the hex and
// paints half its radius over the neighbour. Every shape is now recorded by its OUTLINE, so
// "inside the tile" means the painted pixels, not the anchor point.
function recordingScene() {
  const drawn = {};
  return {
    make: {
      graphics: () => {
        const marks = [];
        const rec = (x, y) => marks.push([x / ART_SCALE, y / ART_SCALE]);
        const recEllipse = (x, y, w, h) => {          // w/h are full diameters
          for (let i = 0; i < 16; i++) {
            const t = (i / 16) * Math.PI * 2;
            rec(x + Math.cos(t) * w / 2, y + Math.sin(t) * h / 2);
          }
        };
        return {
          fillStyle: () => {}, lineStyle: () => {}, destroy: () => {},
          fillRect: (x, y, w, h) => { rec(x, y); rec(x + w, y); rec(x + w, y + h); rec(x, y + h); },
          fillCircle: (x, y, r) => recEllipse(x, y, r * 2, r * 2),
          fillEllipse: (x, y, w, h) => recEllipse(x, y, w, h),
          fillTriangle: (x1, y1, x2, y2, x3, y3) => { rec(x1, y1); rec(x2, y2); rec(x3, y3); },
          fillPoints: () => {},                      // the base hex polygon, not "detail"
          generateTexture: (key) => { drawn[key] = marks; },
        };
      },
    },
    textures: { exists: () => false, get: () => ({ getSourceImage: () => ({ getContext: () => null }) }) },
    _drawn: drawn,
  };
}

describe('mud is a diffuse full-tile texture, not a central motif (#447)', () => {
  const scene = recordingScene();
  buildHexTextures(scene);
  const marks = scene._drawn.hex_mud;
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const offsets = marks.map(([x, y]) => [x - cx, y - cy]);

  it('paints many marks, not a handful of hand-placed shapes', () => {
    expect(offsets.length).toBeGreaterThan(60);
  });

  it('reaches the outer half of the tile in every direction', () => {
    // Six 60° sectors; each must contain a mark past 60% of the hex radius.
    for (let sector = 0; sector < 6; sector++) {
      const lo = sector * 60 - 180, hi = lo + 60;
      const reach = offsets.some(([dx, dy]) => {
        const a = Math.atan2(dy, dx) * 180 / Math.PI;
        return a >= lo && a < hi && Math.hypot(dx, dy) > HEX_SIZE * 0.6;
      });
      expect(reach, `sector ${sector}`).toBe(true);
    }
  });

  it('keeps every mark inside the tile', () => {
    for (const [dx, dy] of offsets) {
      expect(insideHex(dx, dy), `${dx.toFixed(2)},${dy.toFixed(2)}`).toBe(true);
    }
  });
});

// #471: the same sweep applied to the rest of the audit's centre-motif tiles — tier 1 (mud's exact
// twins: a centred ellipse plus a crack or a glow), tier 3 (the channels) and tier 4 (the minor
// ones). Same three properties as the #447 mud checks above, run over every reworked tile at once.
// Tier 2 — the bulk ground tiles — is deliberately NOT in this list: the owner excluded them.
//
// "Inside the tile" is now EXACT (`insideHex`, no tolerance). It used to allow HEX_SIZE + 2,
// because `streaks` clipped each segment's CENTRELINE only and `mottle`/`buildSlabs` placed a mark
// by its centre — so a stroke, blotch or slab on the rim painted its outer half over the
// neighbouring hex. The owner saw that as texture spilling past the hex border; every primitive
// now clips the drawn SHAPE to the tile, and this assertion is what keeps it that way.
describe('the audit\'s remaining centre-motif tiles are full-tile textures (#471)', () => {
  const scene = recordingScene();
  buildHexTextures(scene);
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const TILES = [
    // tier 1
    'hex_quicksand', 'hex_brokenIce', 'hex_cinderField', 'hex_crust', 'hex_dryRiver',
    'hex_rubble', 'hex_debris',
    // tier 3 — the channels
    'hex_river', 'hex_slush', 'hex_canal',
    // tier 4 — the fumarole vent ember + the cleared floors' stubble
    'hex_fumaroleCleared', 'hex_forestCleared', 'hex_scrubCleared', 'hex_driftCleared',
    'hex_wreckCleared',
  ];

  for (const key of TILES) {
    describe(key, () => {
      const offsets = scene._drawn[key].map(([x, y]) => [x - cx, y - cy]);

      it('paints many marks, not a handful of hand-placed shapes', () => {
        expect(offsets.length).toBeGreaterThan(60);
      });

      it('reaches the outer half of the tile in every direction', () => {
        for (let sector = 0; sector < 6; sector++) {
          const lo = sector * 60 - 180, hi = lo + 60;
          const reach = offsets.some(([dx, dy]) => {
            const a = Math.atan2(dy, dx) * 180 / Math.PI;
            return a >= lo && a < hi && Math.hypot(dx, dy) > HEX_SIZE * 0.6;
          });
          expect(reach, `sector ${sector}`).toBe(true);
        }
      });

      it('keeps every mark inside the tile', () => {
        for (const [dx, dy] of offsets) {
          expect(insideHex(dx, dy), `${dx.toFixed(2)},${dy.toFixed(2)}`).toBe(true);
        }
      });
    });
  }
});

// #471, the SECOND half of the channel problem: `river`/`slush`/`canal` also had to stop reading as
// a motif stamped once per hex and start reading as one continuous watercourse. Every hex of a
// terrain shares ONE baked texture, so the fix is to make that texture periodic under the hex
// lattice: `buildStreaks` seeds features inside one hex and emits every lattice translate, and
// `streaks` clips them to the tile.
//
// The property that proves it: where a streak crosses the hex boundary, the neighbouring tile —
// which paints the identical texture shifted by that neighbour's lattice vector — must have a
// crossing at exactly the same world point. Equivalently: the crossing set on edge E equals the
// crossing set on the OPPOSITE edge, translated by the neighbour offset. That's what's asserted
// here; if it holds, a channel is visually continuous across the boundary with no neighbour
// awareness at bake time.
describe('channel streaks continue across the hex boundary (#471)', () => {
  const lines = buildStreaks(0x51, { count: 18, len: 42, segs: 3, wobble: 0.25 });

  // Every point where a streak segment crosses the hex boundary, as {x, y} at circumradius HEX_SIZE.
  const crossings = [];
  for (const line of lines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const c = clipSegToHex(line[i], line[i + 1], line[i + 2], line[i + 3], HEX_SIZE);
      if (!c) continue;
      // A clipped endpoint that moved off the original endpoint sits ON the boundary.
      if (Math.hypot(c[0] - line[i], c[1] - line[i + 1]) > 1e-6) crossings.push([c[0], c[1]]);
      if (Math.hypot(c[2] - line[i + 2], c[3] - line[i + 3]) > 1e-6) crossings.push([c[2], c[3]]);
    }
  }

  it('actually crosses the boundary in the first place', () => {
    expect(crossings.length).toBeGreaterThan(20);
  });

  it('has a matching crossing one lattice step away for every boundary crossing', () => {
    // The six neighbour centre offsets (ring 1 of HEX_LATTICE, i.e. length ≈ sqrt(3)*HEX_SIZE).
    const ring1 = HEX_LATTICE.filter(([x, y]) => {
      const d = Math.hypot(x, y);
      return d > 1 && d < HEX_SIZE * Math.sqrt(3) + 1;
    });
    expect(ring1.length).toBe(6);

    for (const [px, py] of crossings) {
      // Which neighbour does this crossing point face? The one whose centre it is closest to.
      const [ox, oy] = ring1.reduce((best, o) =>
        Math.hypot(px - o[0], py - o[1]) < Math.hypot(px - best[0], py - best[1]) ? o : best);
      // In the neighbour's own tile-local coords that same world point is (p - offset); the
      // neighbour paints the same texture, so it must have a crossing there too.
      const want = [px - ox, py - oy];
      const hit = crossings.some(([qx, qy]) => Math.hypot(qx - want[0], qy - want[1]) < 1e-6);
      expect(hit, `crossing ${px.toFixed(2)},${py.toFixed(2)}`).toBe(true);
    }
  });
});

// #471 playtest, third and fourth passes. Third: the calming pass had left the marks literally
// straight and every test still passed — counts and containment can't tell a wave from a wobbled
// straight — so this block was added, asserting a heavy squiggle (arc/endpoint > 1.2, >= 3 turn
// reversals). Fourth: that squiggle overshot — "should be simpler texture so it blends with the
// 'deep' better, simple horizontal wave lines". A plain, gentle, regular wave legitimately scores
// ~1.07 on arc length, so the OLD thresholds were thresholds from a rejected direction and are gone.
// What replaces them still separates "wave" from "accidentally straight", which is how an earlier
// pass shipped wrong — measured against the line's own chord rather than its total length:
//
//   SWING — the largest perpendicular distance from the straight chord between the endpoints. A
//           straight or gently-wobbled streak barely leaves its chord; a real sine reaches ~amp.
//   CROSSINGS — how many times the path crosses back over that chord. One bend crosses zero times;
//           an undulation must cross once per half wave. This is what says WAVE, not just "bent".
//   HORIZONTAL — the chord's slope. The owner asked specifically for horizontal wave lines.
describe('the river lines are simple horizontal waves (#471)', () => {
  // Signed perpendicular offset of every vertex from the endpoint chord.
  function offsets(line) {
    const x0 = line[0], y0 = line[1];
    const dx = line[line.length - 2] - x0, dy = line[line.length - 1] - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const out = [];
    for (let i = 0; i < line.length; i += 2) out.push((line[i] - x0) * nx + (line[i + 1] - y0) * ny);
    return out;
  }

  const swing = (line) => Math.max(...offsets(line).map(Math.abs));

  function crossings(line) {
    const signs = offsets(line).filter((o) => Math.abs(o) > 1e-6).map(Math.sign);
    let n = 0;
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) n++;
    return n;
  }

  for (const [name, set] of Object.entries(RIVER_STREAK_SETS)) {
    describe(name, () => {
      it('every line swings clear of its own chord', () => {
        for (const line of set) expect(swing(line)).toBeGreaterThan(1.2);
      });

      it('every line crosses back over that chord more than once — a wave, not a bend', () => {
        for (const line of set) expect(crossings(line)).toBeGreaterThanOrEqual(2);
      });

      it('every line runs horizontally', () => {
        for (const line of set) {
          const dx = Math.abs(line[line.length - 2] - line[0]);
          const dy = Math.abs(line[line.length - 1] - line[1]);
          expect(dy / (dx || 1)).toBeLessThan(0.2);
        }
      });
    });
  }

  it('a straight streak set would fail the same properties', () => {
    const straight = buildStreaks(0x77, { count: 8, len: 58, segs: 3, wobble: 0.13 });
    expect(straight.every((l) => swing(l) > 1.2)).toBe(false);
    expect(straight.every((l) => crossings(l) >= 2)).toBe(false);
  });

  // The simplification is only worth anything if it's actually simpler than the rejected pass: one
  // set of a few lines, gently waved, not a dense field of hard squiggles.
  it('is a SIMPLE treatment — one set, few lines, gentle waves', () => {
    const sets = Object.values(RIVER_STREAK_SETS);
    expect(sets).toHaveLength(1);
    expect(sets[0].length / HEX_LATTICE.length).toBeLessThanOrEqual(6);   // seeds per fundamental domain
    // Gentle: the shipped lines peak at ~5.1px off their chord; the rejected 4.6px-amplitude
    // squiggle set never went below 5.9, so this ceiling is what keeps the busy version out.
    for (const line of sets[0]) expect(swing(line)).toBeLessThan(5.5);
  });

  // A waved path still has to satisfy the lattice property the whole channel scheme rests on.
  it('keeps the tile-to-tile crossing match with a waved path', () => {
    const lines = buildStreaks(0x8c, {
      count: 10, len: 54, segs: 24, angle: 0, angleJitter: 0.05,
      wave: { amp: 2.6, period: 24, jitter: 0.12 },
    });
    const crossings = [];
    for (const line of lines) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        const c = clipSegToHex(line[i], line[i + 1], line[i + 2], line[i + 3], HEX_SIZE);
        if (!c) continue;
        if (Math.hypot(c[0] - line[i], c[1] - line[i + 1]) > 1e-6) crossings.push([c[0], c[1]]);
        if (Math.hypot(c[2] - line[i + 2], c[3] - line[i + 3]) > 1e-6) crossings.push([c[2], c[3]]);
      }
    }
    expect(crossings.length).toBeGreaterThan(20);
    const ring1 = HEX_LATTICE.filter(([x, y]) => {
      const d = Math.hypot(x, y);
      return d > 1 && d < HEX_SIZE * Math.sqrt(3) + 1;
    });
    for (const [px, py] of crossings) {
      const [ox, oy] = ring1.reduce((best, o) =>
        Math.hypot(px - o[0], py - o[1]) < Math.hypot(px - best[0], py - best[1]) ? o : best);
      const hit = crossings.some(([qx, qy]) =>
        Math.hypot(qx - (px - ox), qy - (py - oy)) < 1e-6);
      expect(hit, `crossing ${px.toFixed(2)},${py.toFixed(2)}`).toBe(true);
    }
  });
});
