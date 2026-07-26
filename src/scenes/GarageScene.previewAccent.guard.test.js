// #404 / #505: every joined player's column preview wears THEIR OWN colour (rim accent), not a
// single "whoever is currently editing" colour — #505 removed the old sequential single-editor
// model entirely, so there is no longer one "current builder" to key a lone preview off. Each
// column now bakes its own textures from its own player index, via `_artFor(col)`.
//
// GarageScene is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling
// repairOnEntry guard for the full argument), so the wiring is checked as source text; the
// underlying colour-resolution math (mechColorFor/cycleSwatch distinctness) is exercised for real
// in mechColors.test.js, not re-proven here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

describe('#505 every Garage column wears its own player colour', () => {
  it('_artFor(col) keys the shared player look off the COLUMN’s own index', () => {
    const body = src.match(/_artFor\(col\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected an _artFor(col) method').toBeTruthy();
    expect(body).toContain('playerMechArt(col.index');
    expect(body).toMatch(/mechColorFor\(col\.mech, col\.index\)/);
  });

  it('the accent comes from the shared look (and so from data/players.js), not a garage-local list', () => {
    expect(src).toMatch(/import \{[^}]*playerMechArt[^}]*\} from '\.\.\/art\/playerMechLook\.js'/);
    const look = readFileSync(join(DIR, '..', 'art', 'playerMechLook.js'), 'utf8');
    expect(look).toMatch(/import \{[^}]*playerAccent[^}]*\} from '\.\.\/data\/players\.js'/);
  });

  it('every bake of a column’s textures passes that column’s own art opts', () => {
    const bakes = src.match(/(?:buildMechTextures|reskinMech)\(this, col\.textureKey[^\n]*/g) ?? [];
    expect(bakes.length).toBeGreaterThan(0);
    for (const call of bakes) expect(call).toContain('this._artFor(col)');
  });

  it('each column bakes into its OWN texture key, keyed by player index — no shared texture', () => {
    expect(src).toMatch(/col\.textureKey = `garageMech\$\{i\}`;/);
  });
});
