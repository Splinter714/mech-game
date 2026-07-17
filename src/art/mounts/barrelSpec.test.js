// #233 ("projectiles should originate from the tip of the weapon muzzle art"): barrelLen() is
// the SAME length computation every mount draw fn (energy.js, ballistic.js, .../weapons.js,
// etc.) now uses to size its drawn barrel/tube — these tests pin it down so the art and the
// muzzle math it feeds (weaponMuzzleTip, shared.js partMuzzle's tipOffset) can never drift.
import { describe, it, expect } from 'vitest';
import { CENTER } from '../mechPrims.js';
import { BARREL_SPECS, barrelLen, weaponMuzzleTip } from './barrelSpec.js';

describe('barrelLen (#233)', () => {
  it('scales the raw spec length by s when well inside the cap', () => {
    expect(barrelLen('energy', 1, 100)).toBeCloseTo(BARREL_SPECS.energy.len, 10);
    expect(barrelLen('beamLaser', 2, 100)).toBeCloseTo(BARREL_SPECS.beamLaser.len * 2, 10);
  });

  it('clamps to cap so a barrel never draws (or spawns a shot) past the texture canvas edge', () => {
    expect(barrelLen('railLance', 1, 5)).toBeCloseTo(5, 10);
  });

  it('falls back to the energy spec for an unknown id', () => {
    expect(barrelLen('totallyMadeUpWeapon', 1, 100)).toBeCloseTo(BARREL_SPECS.energy.len, 10);
  });
});

describe('weaponMuzzleTip (#233)', () => {
  // A part near the mech's centre (small |y|) so its front edge isn't already close to the
  // canvas boundary — keeps `cap` generous and isolates the len*frac behaviour being tested.
  const bigPart = { x: 0, y: 0, w: 10, h: 10 };

  it('returns the full modeled barrel length for a frac:1 weapon (e.g. Beam Laser)', () => {
    const bodyLen = 38; // s === 1 at this reference size
    const tip = weaponMuzzleTip('beamLaser', 'energy', bigPart, bodyLen, CENTER);
    expect(tip).toBeCloseTo(BARREL_SPECS.beamLaser.len, 10);
  });

  it('returns len * frac for a weapon whose tip glow sits short of the full tube (Napalm)', () => {
    const bodyLen = 38;
    const tip = weaponMuzzleTip('napalm', 'ballistic', bigPart, bodyLen, CENTER);
    expect(tip).toBeCloseTo(BARREL_SPECS.napalm.len * BARREL_SPECS.napalm.frac, 10);
  });

  it('falls back to the CATEGORY spec for a weapon id with no bespoke mount art', () => {
    const bodyLen = 38;
    const bespoke = weaponMuzzleTip('someUnbespokeSupportWeapon', 'support', bigPart, bodyLen, CENTER);
    expect(bespoke).toBeCloseTo(BARREL_SPECS.support.len * BARREL_SPECS.support.frac, 10);
  });

  it('scales down for a smaller chassis (s < 1), matching what the art actually draws', () => {
    const smallBodyLen = 19; // s = 0.5
    const tip = weaponMuzzleTip('railLance', 'energy', bigPart, smallBodyLen, CENTER);
    expect(tip).toBeCloseTo(BARREL_SPECS.railLance.len * 0.5, 10);
  });

  it('is 0 (no forward push) only if the spec somehow resolved to a 0-length barrel — sanity: every real spec is positive', () => {
    for (const [id, spec] of Object.entries(BARREL_SPECS)) {
      expect(spec.len, `${id} should have a positive modeled length`).toBeGreaterThan(0);
      expect(spec.frac, `${id} frac should be in (0, 1]`).toBeGreaterThan(0);
      expect(spec.frac).toBeLessThanOrEqual(1);
    }
  });
});
