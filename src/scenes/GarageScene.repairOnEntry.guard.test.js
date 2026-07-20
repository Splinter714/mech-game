// #249 (playtest: "the player mech icon bottom right in garage stays destroyed after a round;
// it should refresh when coming back to the garage"). Root cause: `repairAll()` only ran at the
// START of the NEXT deploy (see deploy() below), not when the player actually returns to the
// Garage — so a run that ended in death left `this.mech` (and the textures baked from it) with
// destroyed-part damage for the whole time the player was back in the Garage. ArenaScene#toGarage
// is the single funnel every return-to-garage path goes through (manual G key, Select/B pad
// exit, the RUN_OVER_DELAY delayedCall — see sfxCallSites.guard.test.js for that same funnel
// argument), and it always ends in `this.scene.start('GarageScene')`, which re-runs
// GarageScene#create() from scratch. So repairing unconditionally at the top of create() — before
// `buildMechTextures` bakes the preview/paper-doll sprites — covers every entry path (fresh boot,
// ESC from the Music tab, and the bug's post-run return) with one idempotent call, no new state
// or flag needed.
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

describe('#249 Garage repairs the mech on every scene entry, not just on next deploy', () => {
  // #349: the repair now covers EVERY player build slot, not just the one on screen. Player 2's
  // mech comes back from a co-op run damaged too and must be healthy the instant the handoff
  // swaps it in — there is no second create() to heal it at that point.
  const REPAIR_ALL_SLOTS = 'for (const key of PLAYER_MECH_KEYS) this.allMechs[key]?.repairAll();';

  it('create() repairs the mech being edited unconditionally', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toMatch(/this\.mech = this\.allMechs\[this\.mechKey\];[\s\S]*?PLAYER_MECH_KEYS\) this\.allMechs\[key\]\?\.repairAll\(\);/);
  });

  it('create() repairs EVERY player slot, so the handed-off player 2 mech is healthy too (#349)', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toContain(REPAIR_ALL_SLOTS);
  });

  it('create() repairs BEFORE building the preview/paper-doll textures from this.mech', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    const repairIdx = create.indexOf(REPAIR_ALL_SLOTS);
    const textureIdx = create.indexOf("buildMechTextures(this, 'garageMech', this.mech);");
    expect(repairIdx).toBeGreaterThan(-1);
    expect(textureIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeLessThan(textureIdx);
  });

  it('create() persists the repair so localStorage does not disagree with the on-screen mech', () => {
    const create = bodyOf(/create\(\)\s*\{[\s\S]*?\n {2}\}/);
    expect(create).toMatch(/repairAll\(\);\s*\n\s*saveAllMechs\(this\.allMechs\);/);
  });

  // #349: the handoff swaps `this.mech` to the other player's slot mid-scene, so that path needs
  // the same repair guarantee the entry path has.
  it('_setSession() repairs the incoming player mech before reskinning the preview from it', () => {
    const body = bodyOf(/_setSession\(next\)\s*\{[\s\S]*?\n {2}\}/);
    const repairIdx = body.indexOf('this.mech.repairAll();');
    const reskinIdx = body.indexOf("reskinMech(this, 'garageMech', this.mech);");
    expect(repairIdx).toBeGreaterThan(-1);
    expect(reskinIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeLessThan(reskinIdx);
  });

  it('deploy() still repairs too (belt-and-braces; harmless no-op once create() already healed it)', () => {
    expect(garageScene).toMatch(/deploy\(\)\s*\{[\s\S]*?this\.mech\.repairAll\(\);/);
  });
});
