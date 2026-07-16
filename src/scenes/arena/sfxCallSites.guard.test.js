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

describe('#201 SFX call-site wiring', () => {
  it('combat.js fires the shared partDestroyed cue for both player- and enemy-part loss', () => {
    const matches = combat.match(/Audio\.ui\('partDestroyed'\)/g) ?? [];
    expect(matches.length).toBe(2);   // _damagePlayerAt + _damageEnemyAt
  });

  it('combat.js fires mechDestroyed on the player MECH DOWN moment', () => {
    expect(combat).toMatch(/MECH DOWN[\s\S]*?Audio\.ui\('mechDestroyed'\)/);
  });

  it('combat.js no longer uses the generic explosion cue for part-loss/mech-destroyed', () => {
    // #107's deathExplosion (enemy kills) and world.js's terrain explosion are untouched by
    // #201 — only these two specific generic explosion(...) calls were replaced.
    expect(combat).not.toMatch(/Audio\.explosion\(0\.6\)/);
    expect(combat).not.toMatch(/Audio\.explosion\(1\.2\)/);
  });

  it('run.js fires runLost only on the losing run-over transition, not the win case', () => {
    expect(run).toMatch(/if \(!won\) Audio\.ui\('runLost'\)/);
  });
});
