// #404 follow-up (playtest): the lab preview mech was still UNTINTED grey while the very same
// build deployed into the arena wearing the player's colour — because the garage baked
// 'garageMech' with no art opts at all, so mechArt fell back to the base player palette.
//
// The fix is a single seam: GarageScene#_previewArt() hands every bake of the preview the rim
// accent of whoever is BUILDING RIGHT NOW, drawn from the same PLAYER_ACCENTS table the arena
// uses. Two things are worth pinning, and this file does both:
//   1. the accent SOURCE — it must be players.js, so the lab and the arena can never disagree;
//   2. the accent SUBJECT — `session.editing`, not a hardcoded player 1, so the co-op handoff
//      re-tints the preview to player 2.
//
// GarageScene is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling
// repairOnEntry guard for the full argument), so the wiring is checked as source text and the
// per-player logic is exercised for real against the pure modules it is built from.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLAYER_ACCENTS, playerAccent } from '../data/players.js';
import { makeGarageSession, advanceEditing, joinPlayer } from '../data/coopGarage.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

// The scene's own one-liner, replayed here so the assertions below run the real rule.
const previewAccent = (session) => playerAccent(makeGarageSession(session).editing);

describe('#404 the garage preview mech wears the building player’s colour', () => {
  it('_previewArt() tints with the ARENA accent table, keyed by who is editing', () => {
    const body = src.match(/_previewArt\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _previewArt() method').toBeTruthy();
    expect(body).toContain("theme: 'player'");
    expect(body).toContain('playerAccent(this.session.editing)');
  });

  it('the accent comes from data/players.js — not a garage-local colour list', () => {
    expect(src).toMatch(/import \{[^}]*playerAccent[^}]*\} from '\.\.\/data\/players\.js'/);
  });

  it('every bake of the garageMech textures passes the preview art opts', () => {
    const bakes = src.match(/(?:buildMechTextures|reskinMech)\(this, 'garageMech'[^\n]*/g) ?? [];
    expect(bakes.length).toBeGreaterThan(0);
    for (const call of bakes) expect(call).toContain('this._previewArt()');
  });

  it('single-player shows player 1’s colour', () => {
    expect(previewAccent({ count: 1, editing: 0 })).toBe(PLAYER_ACCENTS[0]);
  });

  it('the co-op handoff re-tints the preview to the next builder', () => {
    let session = joinPlayer(makeGarageSession({ count: 1 }));   // P2 joins, P1 still building
    expect(previewAccent(session)).toBe(PLAYER_ACCENTS[0]);
    session = advanceEditing(session);                            // P1 READY → P2 builds
    expect(previewAccent(session)).toBe(PLAYER_ACCENTS[1]);
    expect(PLAYER_ACCENTS[1]).not.toBe(PLAYER_ACCENTS[0]);
  });

  it('a mere JOIN does not steal the tint from the player mid-build', () => {
    const session = joinPlayer(joinPlayer(makeGarageSession({ count: 1 })));
    expect(session.count).toBe(3);
    expect(previewAccent(session)).toBe(PLAYER_ACCENTS[0]);
  });

  it('every seatable builder has a distinct accent to be shown in', () => {
    let session = makeGarageSession({ count: 1 });
    const seen = [previewAccent(session)];
    while (session.editing < session.count - 1 || seen.length < PLAYER_ACCENTS.length) {
      const grown = joinPlayer(session);
      if (grown.count === session.count) break;
      session = advanceEditing(grown);
      seen.push(previewAccent(session));
    }
    expect(seen.length).toBe(PLAYER_ACCENTS.length);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
