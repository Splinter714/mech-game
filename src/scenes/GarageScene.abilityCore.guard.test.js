// #506: the Garage's mounting UI now serves three slot families — weapon, ability, core — off
// ONE shared WeaponCardList instance (no second catalog, no new tab) and one shared `_drawTile`.
// GarageScene is Phaser-API-heavy and isn't instantiable under Vitest (see the sibling
// previewAccent/repairOnEntry guards for the full argument), so the wiring is pinned as source
// text: that the slot-family branch actually exists, that the new mount/unmount calls are wired
// in, and — the regression this file exists to catch — that deploy gating stays weapon-only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

describe('GarageScene ability/core mounting UI wiring (#506)', () => {
  it('_eligibleIds branches on slotKind for the ability/core catalogs', () => {
    const body = src.match(/_eligibleIds\(loc\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected an _eligibleIds(loc) method').toBeTruthy();
    expect(body).toMatch(/slotKind\(loc\)/);
    expect(body).toMatch(/Object\.keys\(ABILITIES\)/);
    expect(body).toMatch(/Object\.keys\(CORE_ITEMS\)/);
  });

  it('_pickItem branches on slotKind to unmount an already-mounted ability/core item', () => {
    const body = src.match(/_pickItem\(id\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _pickItem(id) method').toBeTruthy();
    expect(body).toMatch(/slotKind\(this\.selected\)/);
    expect(body).toContain('_unmountFrom');
  });

  it('actually calls the Mech ability/core mount and unmount methods somewhere in the file', () => {
    expect(src).toContain('mountAbility(');
    expect(src).toContain('unmountAbility(');
    expect(src).toContain('mountCore(');
    expect(src).toContain('unmountCore(');
  });

  it('the single WeaponCardList is reused (no second catalog instance, no new tab)', () => {
    expect((src.match(/new WeaponCardList\(/g) ?? []).length).toBe(1);
  });

  it('abilities/core items are exempt from the SCRAP-unlock gate passed to the catalog', () => {
    const isLocked = src.match(/isLocked:\s*\([^)]*\)\s*=>[^\n,]*/)?.[0];
    const cost = src.match(/costOf:\s*\([^)]*\)\s*=>[^\n,]*/)?.[0];
    expect(isLocked, 'expected an isLocked closure passed to WeaponCardList').toBeTruthy();
    expect(cost, 'expected a costOf closure passed to WeaponCardList').toBeTruthy();
    expect(isLocked).toMatch(/isWeapon\(id\)/);
    expect(cost).toMatch(/isWeapon\(id\)/);
  });

  // The regression this file exists to guard against: deploy gating must stay weapon-slot-only.
  // Ability/core slots are deliberately OPTIONAL (#506's own confirmed decision) — if a future
  // edit makes deploy()/isComplete() reference abilityMounts/coreMounts, a build that skips a
  // shield or leaves an ability slot empty would silently become undeployable.
  it('deploy() never references abilityMounts/coreMounts — ability/core slots stay optional', () => {
    const body = src.match(/ {2}deploy\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a deploy() method').toBeTruthy();
    expect(body).not.toMatch(/abilityMounts|coreMounts/);
    expect(body).toContain('isComplete()');
  });
});
