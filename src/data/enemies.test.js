import { describe, it, expect } from 'vitest';
import { Mech } from './Mech.js';
import { ENEMIES } from './enemies.js';

// #272: artillery/Mortarhead is meant to be an entrenched siege unit whose ENTIRE loadout is
// indirect-fire (homing or arcing), so the tactical AI's `isAllIndirect` (scenes/arena/
// enemies.js) reads true and its "camp behind cover and bombard" posture actually triggers —
// see the design comment on ENEMIES.artillery above. #96 had it reusing the sniper's direct-fire
// plasmaLance/clusterRocket loadout as a stopgap (since its original indirect weapons were
// shelved), which silently broke that AI posture. #244 later un-shelved every weapon, so this
// locks in that artillery got its own distinct, fully-indirect loadout back — mirrors the exact
// condition `isIndirectWeapon` in scenes/arena/enemies.js checks (guidance 'homing' or path
// 'arcing'), without needing to import that Phaser-adjacent scene file here.
function isIndirect(weapon) {
  const d = weapon?.delivery;
  return !!d && (d.guidance === 'homing' || d.path === 'arcing');
}

describe('ENEMIES.artillery loadout', () => {
  it('is fully indirect-fire — every mounted weapon is arcing or homing', () => {
    const mech = new Mech(ENEMIES.artillery);
    const weapons = mech.weapons().map((w) => w.weapon).filter(Boolean);
    expect(weapons.length).toBeGreaterThan(0);
    expect(weapons.every(isIndirect)).toBe(true);
  });

  it('is distinct from the sniper loadout (not just a reskinned Warden)', () => {
    const artillery = new Mech(ENEMIES.artillery);
    const sniper = new Mech(ENEMIES.sniper);
    const artilleryIds = artillery.weapons().map((w) => w.weapon?.id).sort();
    const sniperIds = sniper.weapons().map((w) => w.weapon?.id).sort();
    expect(artilleryIds).not.toEqual(sniperIds);
  });
});
