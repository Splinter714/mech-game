// #201: locks in that the 3 new SFX domain triggers are actually wired at the specific call
// sites Jackson called out, and that the old generic `Audio.explosion(...)` calls they replace
// are gone from those spots. combat.js/run.js are Phaser scene mixins (rely on `this` being a
// live ArenaScene with textures/tweens/etc.) so a full behavioral unit test would need to stand
// up most of a scene — same reason this repo's test discipline reserves scene-level behavior
// for the Playwright smoke test (see CLAUDE.md) rather than unit tests. A source-text assertion
// (same technique architecture.guard.test.js already uses) is the practical way to pin the
// wiring without that overhead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const combat = readFileSync(join(DIR, 'combat.js'), 'utf8');
const run = readFileSync(join(DIR, 'run.js'), 'utf8');
const arenaScene = readFileSync(join(DIR, '..', 'ArenaScene.js'), 'utf8');

describe('#201 SFX call-site wiring', () => {
  it('combat.js fires the shared partDestroyed cue for both player- and enemy-part loss', () => {
    const matches = combat.match(/Audio\.ui\('partDestroyed'\)/g) ?? [];
    expect(matches.length).toBe(2);   // _damagePlayerAt + _damageEnemyAt
  });

  it('combat.js fires mechDestroyed on the player MECH DOWN moment', () => {
    // #236: the floating "MECH DOWN" text was removed (Jackson: drop almost all
    // player-anchored float text), so this now anchors on the `_playerDead` flag flip
    // that marks the same moment instead of the text that used to sit next to it.
    expect(combat).toMatch(/_playerDead = true;[\s\S]*?Audio\.ui\('mechDestroyed'\)/);
  });

  it('combat.js no longer uses the generic explosion cue for part-loss/mech-destroyed', () => {
    // #107's deathExplosion (enemy kills) and world.js's terrain explosion are untouched by
    // #201 — only these two specific generic explosion(...) calls were replaced.
    expect(combat).not.toMatch(/Audio\.explosion\(0\.6\)/);
    expect(combat).not.toMatch(/Audio\.explosion\(1\.2\)/);
  });

  // #210: `runLost` (fired only on loss, right alongside mechDestroyed at the death moment)
  // was replaced with `returnToGarage`. #216: that cue then moved again, off of run.js's
  // RUN_OVER_DELAY delayedCall and into ArenaScene's `toGarage()` itself, because the manual
  // G-key/Select-B exit paths call `toGarage()` directly and bypassed the delayedCall entirely
  // — so the sound never played on those paths. `toGarage()` is the one method every
  // return-to-garage path funnels through, so that's now the sole call site.
  it('run.js no longer fires the old runLost cue', () => {
    expect(run).not.toMatch(/Audio\.ui\('runLost'\)/);
  });

  it('run.js no longer fires returnToGarage itself (moved to ArenaScene#toGarage)', () => {
    expect(run).not.toMatch(/Audio\.ui\('returnToGarage'\)/);
  });

  it('run.js still transitions via this.toGarage() inside the RUN_OVER_DELAY delayedCall', () => {
    const delayedCallMatch = run.match(/delayedCall\(RUN_OVER_DELAY[\s\S]*?\}\);/);
    expect(delayedCallMatch).toBeTruthy();
    expect(delayedCallMatch[0]).toMatch(/this\.toGarage\(\)/);
  });

  it('ArenaScene#toGarage fires returnToGarage exactly once, ahead of the scene transition', () => {
    const toGarageMatch = arenaScene.match(/toGarage\(\)\s*\{[\s\S]*?\n  \}/);
    expect(toGarageMatch).toBeTruthy();
    const body = toGarageMatch[0];
    expect(body).toMatch(/Audio\.ui\('returnToGarage'\)/);
    expect(body).toMatch(/this\.scene\.start\('GarageScene'\)/);
  });

  it('returnToGarage is fired from exactly one place across run.js and ArenaScene.js', () => {
    const runMatches = run.match(/Audio\.ui\('returnToGarage'\)/g) ?? [];
    const arenaMatches = arenaScene.match(/Audio\.ui\('returnToGarage'\)/g) ?? [];
    expect(runMatches.length + arenaMatches.length).toBe(1);
  });
});
