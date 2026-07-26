// #249 (playtest: "the player mech icon bottom right in garage stays destroyed after a round;
// it should refresh when coming back to the garage"). Root cause: `repairAll()` only ran at the
// START of the NEXT deploy, not when the player actually returns to the Garage — so a run that
// ended in death left a destroyed-looking preview for the whole time the player was back in the
// Garage. ArenaScene#toGarage is the single funnel every return-to-garage path goes through, and
// it always ends in `this.scene.start('GarageScene')`, which re-runs GarageScene#create() from
// scratch. So repairing unconditionally at the top of create() — before any column bakes its
// preview/tile textures — covers every entry path with one idempotent call, no new state needed.
//
// #349/#505: the repair covers EVERY player build slot, not just the one(s) on screen — a column
// only gets rendered once its player has joined, but its mech must already be healthy the instant
// that happens (there's no per-join repair step any more, since #505 removed the sequential
// handoff GarageScene used to rebind a single editing surface through).
//
// GarageScene extends Phaser.Scene and its create() is Phaser-API-heavy (this.add.*, cameras,
// tweens, ...), so standing up a real instance isn't practical in Vitest — this repo's test
// discipline reserves that level of behavior for the Playwright smoke test (see CLAUDE.md) and
// uses a source-text guard for scene-wiring order instead (same technique as
// src/scenes/arena/sfxCallSites.guard.test.js and src/architecture.guard.test.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const garageScene = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

function bodyOf(methodPattern) {
  const match = garageScene.match(methodPattern);
  expect(match, `expected to find method matching ${methodPattern}`).toBeTruthy();
  return match[0];
}

describe('#249/#505 Garage repairs every player slot on every scene entry', () => {
  const REPAIR_ALL_SLOTS = 'for (const key of PLAYER_MECH_KEYS) this.allMechs[key]?.repairAll();';

  it('create() repairs every persistent build slot unconditionally', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toContain(REPAIR_ALL_SLOTS);
  });

  it('create() repairs BEFORE any column bakes its textures from that slot', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    const repairIdx = create.indexOf(REPAIR_ALL_SLOTS);
    // create() doesn't bake textures directly any more (that moved into _buildColumn, called via
    // _relayoutColumns) — the ordering guarantee is that the repair loop precedes that call.
    const relayoutIdx = create.indexOf('this._relayoutColumns();');
    expect(repairIdx).toBeGreaterThan(-1);
    expect(relayoutIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeLessThan(relayoutIdx);
  });

  it('create() persists the repair so localStorage does not disagree with the on-screen mechs', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toMatch(/repairAll\(\);\s*\n\s*saveAllMechs\(this\.allMechs\);/);
  });

  it('_buildColumn(i) bakes a column’s textures only after the entry-repair has already run (it never repairs itself)', () => {
    const body = bodyOf(/_buildColumn\(i\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).not.toContain('repairAll');
    expect(body).toContain("buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));");
  });

  it('_deploy() still repairs the joined players too (belt-and-braces; harmless no-op once create() already healed them)', () => {
    const body = bodyOf(/_deploy\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(body).toMatch(/this\.allMechs\[PLAYER_MECH_KEYS\[i\]\]\?\.repairAll\(\);/);
  });
});
