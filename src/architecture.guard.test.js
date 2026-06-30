// Architecture guard — locks in the registry/mixin structure so concurrent feature work
// keeps landing in NEW files with append-only touchpoints, instead of growing the old
// if/else-over-"type" chokepoints back. Runs in node (uses `fs` to read source).
//
// Two rules:
//   1. No hardcoded variant in a shared dispatcher. Each generic dispatcher routes through
//      its registry via a bracket lookup; it must not branch on a variant string literal
//      (`x === 'plasma'` / `if (kind === …)`). Registry-key strings inside the registry
//      object literal are fine — those ARE the append-only registration.
//   2. Shared engine/boot/save never names a specific weapon id. New weapons are data; the
//      shared plumbing must stay variant-agnostic.
//
// Staged with the refactor: each registry's assertion is added as that registry lands, so
// the suite stays green throughout. (projectiles → Phase 1; mounts/decor → Phase 3;
// sfx → Phase 4; arena/*.js weapon-id check → Phase 2.)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WEAPON_IDS } from './data/weapons.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const dirJsFiles = (rel) => readdirSync(join(SRC, rel)).filter((f) => f.endsWith('.js')).map((f) => `${rel}/${f}`);

// Strip line + block comments so prose mentioning a variant ("falls back to `slug`") never
// trips the dispatcher rule — only executable code counts.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// A generic dispatcher must not branch on a variant string literal. Forbid the two shapes
// that re-grow a chain: `<word> === 'literal'` and `case 'literal':`.
function assertNoVariantBranch(rel) {
  const code = stripComments(read(rel));
  const equalsBranch = /[A-Za-z_$][\w$]*\s*===\s*['"][^'"]+['"]/;
  const caseBranch = /\bcase\s+['"][^'"]+['"]\s*:/;
  expect(code, `${rel} should dispatch via a registry lookup, not an === 'variant' branch`)
    .not.toMatch(equalsBranch);
  expect(code, `${rel} should dispatch via a registry lookup, not a switch/case on a variant`)
    .not.toMatch(caseBranch);
}

// No specific weapon id appears as a string literal in a shared, variant-agnostic file.
function assertNoWeaponIdLiteral(rel) {
  const code = stripComments(read(rel));
  const hits = WEAPON_IDS.filter((id) => new RegExp(`['"]${id}['"]`).test(code));
  expect(hits, `${rel} hardcodes weapon id(s): ${hits.join(', ')}`).toEqual([]);
}

describe('shared dispatchers route through a registry (no hardcoded variant)', () => {
  it('projectile-kind art', () => {
    const code = stripComments(read('art/projectiles/index.js'));
    expect(code, 'drawProjectileBody must dispatch via PROJECTILE_ART[kind]')
      .toMatch(/PROJECTILE_ART\s*\[/);
    assertNoVariantBranch('art/projectiles/index.js');
  });

  it('weapon-mount art (by category)', () => {
    const code = stripComments(read('art/mounts/index.js'));
    expect(code, 'drawWeaponMount must dispatch via MOUNT_ART[catId]')
      .toMatch(/MOUNT_ART\s*\[/);
    assertNoVariantBranch('art/mounts/index.js');
  });

  it('chassis decor art (by kind)', () => {
    const code = stripComments(read('art/decor/index.js'));
    expect(code, 'drawDecor must dispatch via DECOR_ART[kind]')
      .toMatch(/DECOR_ART\s*\[/);
    assertNoVariantBranch('art/decor/index.js');
  });

  it('gameplay sfx cues (by kind/category)', () => {
    // sfx.js holds both the dispatchers and the cue bodies (which legitimately branch on
    // e.g. `pattern === 'stream'`), so assert the dispatch shape directly: each dispatcher
    // routes through its registry, and nothing dispatches on a kind/category literal.
    const code = stripComments(read('audio/sfx.js'));
    for (const reg of ['FIRE_CUES', 'IMPACT_CUES', 'ABILITY_CUES']) {
      expect(code, `sfx must dispatch via ${reg}[...]`).toMatch(new RegExp(`${reg}\\s*\\[`));
    }
    expect(code, 'sfx must not dispatch on a kind/category string literal')
      .not.toMatch(/\b(kind|catId|category)\s*===\s*['"]/);
    expect(code, 'sfx must not switch on a variant').not.toMatch(/\bswitch\s*\(/);
  });
});

describe('shared plumbing never names a specific weapon', () => {
  // The arena scene mixins are the orchestrator/engine; enemy loadouts are data
  // (data/enemies.js), so no arena/*.js file should name a weapon id.
  const files = ['data/delivery.js', 'data/save.js', 'scenes/BootScene.js', ...dirJsFiles('scenes/arena')];
  for (const rel of files) {
    it(rel, () => assertNoWeaponIdLiteral(rel));
  }
});
