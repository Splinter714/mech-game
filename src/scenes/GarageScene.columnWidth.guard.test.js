// #505 (second correction): Jackson re-raised, after playtesting the merged scene, "not save
// space for players that haven't joined yet" — i.e. he suspected the "squished next to empty
// columns" bug from before #505 was still there. Re-reading GarageScene.js's actual layout code
// (not re-trusting the earlier merge's own commit message) confirms it is NOT: `_relayoutColumns`
// divides the width by `this.session.count` (how many players have actually joined, 1..4) and
// only builds columns for `activeIndices(this.session)`, which is exactly `[0..count-1]` — there
// is no loop over MAX_GARAGE_PLAYERS anywhere in the column-building path, so an unjoined slot
// never gets a column, reserved or otherwise. This file pins that as a source-text regression
// guard, since GarageScene is Phaser-API-heavy and isn't instantiable under Vitest (see the
// sibling previewAccent/repairOnEntry/abilityCore guards for the same argument).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

describe('GarageScene column width — no reserved space for an unjoined player (#505)', () => {
  it('column width divides by session.count, not by MAX_GARAGE_PLAYERS', () => {
    const body = src.match(/ {2}_relayoutColumns\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _relayoutColumns() method').toBeTruthy();
    expect(body).toMatch(/this\.colW = Math\.floor\(this\.W \/ this\.session\.count\)/);
    expect(body).not.toContain('MAX_GARAGE_PLAYERS');
  });

  it('only joined (active) indices ever get a column built — no placeholder loop over the full seat count', () => {
    const body = src.match(/ {2}_relayoutColumns\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body).toMatch(/for \(const i of activeIndices\(this\.session\)\) this\._buildColumn\(i\)/);
  });

  it('MAX_GARAGE_PLAYERS is only used for pad-watching (join detection) and the ready/session cap, never for column layout', () => {
    // Every non-column use of MAX_GARAGE_PLAYERS in the file is a `for` loop over pad indices
    // (create()'s padEdges, _updateJoin()'s unclaimed-pad scan) — none of them touch colW/layer
    // positioning, which is the actual "reserved space" surface.
    const uses = [...src.matchAll(/.*MAX_GARAGE_PLAYERS.*/g)].map((m) => m[0]);
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).not.toMatch(/colW|layer\.|_buildColumn/);
    }
  });
});
