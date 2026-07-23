// #404 (third pass) — THE LAB PREVIEW AND THE DEPLOYED MECH MUST BE THE SAME RENDER.
//
// The issue came back three times because the garage and the arena each wrote their own
// `buildMechTextures` options by hand: the accent reached one surface and not the other, and then
// the lab still passed no `statusSpot`, which is the flag `drawTurret` uses to tell a PLAYER from
// an ENEMY — so the lab painted the reactor spine, its two flanking vents and the cockpit optic in
// `mechPrims.REACTOR` purple that the deployed mech has never had.
//
// These tests pin the shared inputs so the two surfaces can't drift apart again:
//   1. `playerMechArt()` is the single definition, and its `statusSpot` defaults to the EMPTY list
//      (the "no powerup" dark core) — never to undefined, which is the enemy look.
//   2. Baked at the pixel level, the lab's options and the arena's produce an IDENTICAL turret,
//      containing no reactor purple at all — with the pre-fix options kept as a control, so the
//      test demonstrably fails on the regression it exists for.
//   3. Nothing else assembles player art options inline any more.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { playerMechArt } from './playerMechLook.js';
import { buildMechTextures, HULL_FRAMES, PLAYER_HULL_FRAMES, strideDir } from './mechArt.js';
import { REACTOR } from './mechPrims.js';
import { PLAYER_ACCENTS, playerAccent } from '../data/players.js';
import { POWERUPS } from '../data/powerups.js';
import { Mech } from '../data/Mech.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(DIR, ...p), 'utf8');

// Bake a mech's whole texture set against a fake scene that records the COLOUR of every fill
// emitted per texture key, so two bakes can be compared exactly without a browser. gen() makes a
// fresh graphics per texture and finishes with `generateTexture(key)` — the first point the key is
// known to the graphics object — so that call closes each key's record.
function bakeFills(mech, opts) {
  const fills = {};
  const scene = {
    make: {
      graphics: () => {
        const seen = [];
        const g = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'fillStyle') return (color) => seen.push(color >>> 0);
            if (prop === 'generateTexture') return (key) => { fills[key] = seen.slice(); };
            if (prop === 'destroy') return () => {};
            if (prop === 'raw') return g;
            return () => {};
          },
        });
        return g;
      },
    },
    textures: { exists: () => false },
  };
  buildMechTextures(scene, 'm', mech, opts);
  return fills;
}

const loadedMech = () => new Mech({
  chassisId: 'mediumPlayer',
  mounts: {
    leftArm: ['autocannon'], rightArm: ['pulseLaser'],
    leftTorso: ['machineGun'], rightTorso: ['swarmRack'],
  },
});

const REACTOR_TONES = new Set([REACTOR.halo, REACTOR.core, REACTOR.hot, REACTOR.edge]);

describe('#404 the garage preview is the same render as the deployed mech', () => {
  it('playerMechArt() is the player look: player theme, the arena accent table, no reactor branch', () => {
    const art = playerMechArt(0);
    expect(art.theme).toBe('player');
    expect(art.accent).toBe(PLAYER_ACCENTS[0]);
    // The bug: an ABSENT statusSpot is the enemy/reactor-purple branch of drawTurret. It must
    // default to the empty list ("no powerup" dark core), which is what a player deploys wearing.
    expect(art.statusSpot).toEqual([]);
    expect(art.statusSpot).not.toBeUndefined();
  });

  it('every player gets their own accent, straight from data/players.js', () => {
    for (let i = 0; i < PLAYER_ACCENTS.length; i++) {
      expect(playerMechArt(i).accent).toBe(playerAccent(i));
    }
  });

  it('a live powerup list passes through (the centre spot is the powerup readout)', () => {
    const colors = [POWERUPS.overdrive.color];
    expect(playerMechArt(0, { statusSpot: colors }).statusSpot).toEqual(colors);
  });

  // ── the render itself ───────────────────────────────────────────────────────────────────
  it('the lab bake and the arena bake produce an IDENTICAL body/turret', () => {
    const mech = loadedMech();
    const lab = bakeFills(mech, playerMechArt(0, { hullFrames: HULL_FRAMES }));
    const arena = bakeFills(mech, playerMechArt(0));
    expect(lab.m_turret.length).toBeGreaterThan(0);
    expect(lab.m_turret).toEqual(arena.m_turret);
    for (const part of ['m_leftArm', 'm_rightArm', 'm_leftTorso', 'm_rightTorso']) {
      expect(lab[part]).toEqual(arena[part]);
    }
    // …and the still pose the lab actually shows is the arena's own frame 0.
    expect(lab.m_hull_0).toEqual(arena.m_hull_0);
  });

  it('no reactor purple anywhere on a player body — the thing Jackson saw in the lab', () => {
    const lab = bakeFills(loadedMech(), playerMechArt(0, { hullFrames: HULL_FRAMES }));
    const purple = lab.m_turret.filter((c) => REACTOR_TONES.has(c));
    expect(purple).toEqual([]);
  });

  it('CONTROL: the pre-fix options (no statusSpot) DO paint the turret reactor purple', () => {
    // Exactly what the garage used to pass. If this ever stops finding purple, the test above has
    // stopped proving anything.
    const before = bakeFills(loadedMech(), { theme: 'player', accent: PLAYER_ACCENTS[0] });
    expect(before.m_turret.some((c) => REACTOR_TONES.has(c))).toBe(true);
  });

  it('the lab’s cheaper hull-frame count is a texture budget, not a different pose', () => {
    // The preview only ever shows _hull_0, and frame 0 is the neutral stance at any frame count.
    expect(strideDir(0, HULL_FRAMES)).toBe(strideDir(0, PLAYER_HULL_FRAMES));
    expect(strideDir(0, HULL_FRAMES)).toBe(-0);
  });

  // ── the wiring ──────────────────────────────────────────────────────────────────────────
  it('the garage preview asks for the shared player look rather than writing its own', () => {
    const src = read('..', 'scenes', 'GarageScene.js');
    const body = src.match(/_previewArt\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _previewArt() method').toBeTruthy();
    expect(body).toContain('playerMechArt(this.session.editing');
    expect(src).toMatch(/import \{[^}]*playerMechArt[^}]*\} from '\.\.\/art\/playerMechLook\.js'/);
    // Every bake of the preview textures goes through it.
    const bakes = src.match(/(?:buildMechTextures|reskinMech)\(this, 'garageMech'[^\n]*/g) ?? [];
    expect(bakes.length).toBeGreaterThan(0);
    for (const call of bakes) expect(call).toContain('this._previewArt()');
  });

  it('the arena bakes the same player look — nobody hand-writes the options', () => {
    for (const file of [['..', 'scenes', 'arena', 'coop.js'], ['..', 'scenes', 'arena', 'combat.js'],
      ['..', 'scenes', 'GarageScene.js']]) {
      const src = read(...file);
      // A `theme: 'player'` object literal outside playerMechLook.js is exactly how this drifted.
      expect(src, `${file.join('/')} should not assemble player art opts inline`)
        .not.toMatch(/theme:\s*'player'/);
    }
  });

  it('the lab and the arena build their sprite stack from the same shared helper', () => {
    for (const file of [['..', 'scenes', 'GarageScene.js'], ['..', 'scenes', 'arena', 'locomotion.js']]) {
      expect(read(...file)).toMatch(/from '.*art\/mechView\.js'/);
    }
  });
});
