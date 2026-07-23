// #421 (biome visibility pass). Snow (0xd9e6ef) and sand (0xbf9c5e) are bright grounds, and a
// lot of what the game draws OVER the ground is bright too — the enemy faction is a near-white
// machine, projectiles are hot cores, the world-space UI is saturated wayfinding colour. On those
// biomes the whole scene washed out.
//
// The fix everywhere is the same shape, so the test is too: nothing is allowed to rely on being
// bright OR on being dark. Every element drawn over terrain must carry a PAIR of tones — one dark
// enough to read on a light biome, one light enough to read on a dark one — so that whatever the
// ground under it, at least one of them is in real contrast with it.
//
// This is a property over the whole biome table rather than a pin on any pixel: add a biome, or
// retune an existing one's ground fill, and this test asks the same question of it automatically.
// Deliberately NOT a check that the terrain palettes are dark enough — snow and sand are supposed
// to be bright (owner's explicit call on this issue); the burden is on what's drawn on top.
import { describe, it, expect } from 'vitest';
import { BIOMES, BIOME_IDS } from '../data/biomes.js';
import { terrainFillColor } from './hexArt.js';
import { HALO, HALO_EDGE } from './mechPrims.js';
import { VEHICLE, VEHICLE_EDGE } from './vehicles/palette.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── WCAG relative luminance + contrast ratio, on 0xRRGGBB ints. ──
const chan = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export function relLuminance(hex) {
  const r = chan((hex >> 16) & 0xff), g = chan((hex >> 8) & 0xff), b = chan(hex & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a, b) {
  const la = relLuminance(a), lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Every ground tone a unit/round/marker can actually be standing on: both checker floors, the
// channel strip and the in-map hazard, for every biome. (`deep` is boundary-only — the invisible
// wall at the world's edge — so nothing is ever drawn over it.)
const GROUND_ROLES = ['groundA', 'groundB', 'channel', 'hazard'];
const GROUNDS = [];
for (const id of BIOME_IDS) {
  for (const role of GROUND_ROLES) {
    const terrainId = BIOMES[id][role];
    const fill = terrainId && terrainFillColor(terrainId);
    if (fill != null) GROUNDS.push({ biome: id, role, terrainId, fill });
  }
}

// WCAG's floor for a non-text UI component against its background. Anything at or above this
// separates cleanly at a glance; the numbers these pairs actually hit are far higher.
const MIN_CONTRAST = 3;

// The contrast PAIRS the art layers, element by element. `light`/`dark` are the two tones the
// element puts against the ground; the property is that one of them always clears MIN_CONTRAST.
const PAIRS = [
  // Enemy mechs: the #129 halo (bright) + the #421 edge ring drawn outside it (dark).
  { what: 'enemy mech silhouette', light: HALO, dark: HALO_EDGE },
  // Non-mech vehicles (tank / drone / helicopter / turret / infantry / carrier) — same pairing,
  // applied by the haloRound/haloPoly/haloRect/haloEllipse helpers in vehicles/palette.js.
  { what: 'vehicle silhouette', light: VEHICLE.halo, dark: VEHICLE_EDGE },
  // Projectiles: a hot core over a dark contrast layer (bullet disc / plasma rim / slug shell /
  // beam under-line all use 0x14161a).
  { what: 'bullet', light: 0xfff0c4, dark: 0x14161a },
  { what: 'plasma glob', light: 0xffffff, dark: 0x14161a },
  { what: 'slug shell', light: 0xffffff, dark: 0x2a2d33 },
  // World-space UI drawn straight onto the ground.
  { what: 'respawn drop-zone marker', light: 0xffffff, dark: 0x0b0e14 },
  { what: 'floating pickup label', light: 0xffffff, dark: 0x0b0e14 },
  { what: 'powerup / salvage pickup', light: 0xffffff, dark: 0x0b0e14 },
  // Objective / dock / enemy pips (mission.js drawPipLayers) — a bright halo ring around a dark
  // outline ring, which is the same property, already in place before this issue.
  { what: 'objective pip', light: 0xfbfdff, dark: 0x0b0e14 },
];

describe('#421 — everything drawn over terrain reads on every biome', () => {
  it('the biome table really does contain both very light and very dark grounds', () => {
    // Guards the test itself: if every ground were mid-toned, a single-tone element would pass
    // by luck rather than by design.
    const lums = GROUNDS.map((g) => relLuminance(g.fill));
    expect(Math.max(...lums)).toBeGreaterThan(0.55);   // snow
    expect(Math.min(...lums)).toBeLessThan(0.12);      // volcanic ash / a dark channel
  });

  for (const p of PAIRS) {
    it(`${p.what}: one of its two tones clears ${MIN_CONTRAST}:1 on every ground tile`, () => {
      const failures = GROUNDS.filter((g) =>
        Math.max(contrastRatio(p.light, g.fill), contrastRatio(p.dark, g.fill)) < MIN_CONTRAST);
      expect(failures.map((f) => `${f.biome}/${f.terrainId}`)).toEqual([]);
    });
  }

  it('every pair is genuinely a pair — a dark tone and a light tone, not two of a kind', () => {
    for (const p of PAIRS) {
      expect(relLuminance(p.dark)).toBeLessThan(0.1);
      expect(relLuminance(p.light)).toBeGreaterThan(0.5);
    }
  });

  it('vehicle art draws its halo shapes only through the paired helpers', () => {
    // The pairing lives in vehicles/palette.js (`haloRound`/`haloPoly`/`haloRect`/`haloEllipse`),
    // so a shape drawn with a bare `V.halo` fill would silently be a bright-only silhouette again
    // — the exact bug this issue is about, reintroduced one call site at a time. The drone's boom
    // is the one hand-rolled case (it strokes a line rather than filling a shape) and pairs its
    // own strokes, so it is allowed to name VEHICLE_EDGE explicitly.
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'vehicles');
    const offenders = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js') || f.endsWith('.test.js') || f === 'palette.js') continue;
      const src = readFileSync(join(dir, f), 'utf8');
      for (const line of src.split('\n')) {
        if (/\b(poly|rectC|roundC|ellipseC)\(sg,[^)]*V\.halo/.test(line)) offenders.push(`${f}: ${line.trim()}`);
        if (/lineStyle\([^)]*V\.halo/.test(line) && !src.includes('VEHICLE_EDGE')) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the two brightest grounds (snow, sand) are carried by the DARK half of every pair', () => {
    // The regression this issue was filed for: on snow/sand the bright halves do nothing, so if
    // a dark tone ever drifts light the element silently stops reading there.
    for (const terrainId of ['snow', 'sand']) {
      const fill = terrainFillColor(terrainId);
      for (const p of PAIRS) {
        expect(contrastRatio(p.dark, fill), `${p.what} on ${terrainId}`).toBeGreaterThan(MIN_CONTRAST);
      }
    }
  });
});
