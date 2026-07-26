// #506: the Garage's mounting UI serves three slot families — weapon, ability, core — off one
// shared `_eligibleIds`/`_mountInto`/`_drawColTile` path per column. #505 first replaced the old
// full-width animated WeaponCardList catalog with a condensed per-column icon grid, then — per
// Jackson's second round of playtest feedback ("the square-only weapon selection... it should
// still be the rows of weapon firing live preview") — put WeaponCardList BACK, in its `compact`
// mode, as every column's catalog (see weaponCardList.js's COMPACT_* sizing and GarageScene.js's
// `_buildColumn`/`_refreshCatalogList`). GarageScene is Phaser-API-heavy and isn't instantiable
// under Vitest (see the sibling previewAccent/repairOnEntry guards for the full argument), so the
// wiring is pinned as source text: that the slot-family branch actually exists, that the mount/
// unmount calls are wired in, that the catalog is really WeaponCardList again (not the condensed
// icon grid), and — the regression this file exists to catch — that readying up stays gated on
// weapon slots only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(DIR, 'GarageScene.js'), 'utf8');

describe('GarageScene ability/core mounting UI wiring (#506, #505)', () => {
  it('_eligibleIds branches on slotKind for the ability/core catalogs', () => {
    const body = src.match(/_eligibleIds\(loc\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected an _eligibleIds(loc) method').toBeTruthy();
    expect(body).toMatch(/slotKind\(loc\)/);
    expect(body).toMatch(/Object\.keys\(ABILITIES\)/);
    expect(body).toMatch(/Object\.keys\(CORE_ITEMS\)/);
  });

  it('_mountInto branches on slotKind to unmount an already-mounted ability/core item on re-pick', () => {
    const body = src.match(/_mountInto\(col, loc, itemId\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _mountInto(col, loc, itemId) method').toBeTruthy();
    expect(body).toMatch(/slotKind\(loc\)/);
    expect(body).toContain('_unmountFrom');
  });

  it('actually calls the Mech ability/core mount and unmount methods somewhere in the file', () => {
    expect(src).toContain('mountAbility(');
    expect(src).toContain('unmountAbility(');
    expect(src).toContain('mountCore(');
    expect(src).toContain('unmountCore(');
  });

  it('#505 (second correction): every column catalog is WeaponCardList again, in compact mode — the condensed icon grid is gone', () => {
    expect(src).toMatch(/from '\.\.\/ui\/weaponCardList\.js'/);
    expect(src).toContain('new WeaponCardList(');
    expect(src).toMatch(/compact:\s*true/);
    // The condensed-icon-grid-specific helper is gone along with the grid itself.
    expect(src).not.toContain('_fitGrid');
  });

  it('a locked weapon in the catalog routes to purchase rather than mounting', () => {
    const body = src.match(/_clickCatalogItem\(col, id\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _clickCatalogItem(col, id) method').toBeTruthy();
    expect(body).toMatch(/isWeapon\(id\) && !this\.unlocked\.has\(id\)/);
    expect(body).toContain('_purchase');
  });

  // The regression this file exists to guard against: readying up must stay weapon-slot-only.
  // Ability/core slots are deliberately OPTIONAL (#506's own confirmed decision) — if a future
  // edit makes the ready gate reference abilityMounts/coreMounts, a build that skips a shield or
  // leaves an ability slot empty would silently become undeployable.
  it('_toggleReady() never references abilityMounts/coreMounts — ability/core slots stay optional', () => {
    const body = src.match(/ {2}_toggleReady\(i\)\s*\{[\s\S]*?\n {2}\}/)?.[0];
    expect(body, 'expected a _toggleReady(i) method').toBeTruthy();
    expect(body).not.toMatch(/abilityMounts|coreMounts/);
    expect(body).toContain('isComplete()');
  });
});
