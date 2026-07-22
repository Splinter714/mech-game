// #433: the reload blink is now a texture swap — a weapon-carrying part sprite toggles between its
// normal texture and a pre-baked "muzzle-off" variant while the weapon reloads. These lock in the
// pure decision seam: which texture key a part shows this frame, and when the muzzle extinguishes.
import { describe, it, expect } from 'vitest';
import { reloadBlinkOff, partTextureKey } from './ammoIndicators.js';
import { MUZZLE_OFF_SUFFIX } from '../../art/index.js';

// A limited-ammo weapon mid-reload: online, has a real magazine, reloading.
const reloading = { online: true, ammo: 0, reloading: true, location: 'leftArm' };

describe('reloadBlinkOff', () => {
  it('is true only for an online, limited-ammo weapon that is reloading on the OFF phase', () => {
    expect(reloadBlinkOff(reloading, false)).toBe(true);   // off phase → muzzle extinguished
  });

  it('is false on the ON phase (muzzle lit) even while reloading', () => {
    expect(reloadBlinkOff(reloading, true)).toBe(false);
  });

  it('never blinks a weapon that is not reloading', () => {
    expect(reloadBlinkOff({ ...reloading, reloading: false }, false)).toBe(false);
  });

  it('never blinks an offline weapon', () => {
    expect(reloadBlinkOff({ ...reloading, online: false }, false)).toBe(false);
  });

  it('never blinks an unlimited-ammo weapon (ammo == null, e.g. melee)', () => {
    expect(reloadBlinkOff({ ...reloading, ammo: null }, false)).toBe(false);
  });

  it('is false for an empty slot (no weapon)', () => {
    expect(reloadBlinkOff(undefined, false)).toBe(false);
    expect(reloadBlinkOff(null, false)).toBe(false);
  });
});

describe('partTextureKey', () => {
  it('picks the muzzle-off variant while reloading on the off phase', () => {
    expect(partTextureKey('playerMech', 'leftArm', reloading, false))
      .toBe(`playerMech_leftArm${MUZZLE_OFF_SUFFIX}`);
  });

  it('picks the normal part texture on the on phase', () => {
    expect(partTextureKey('playerMech', 'leftArm', reloading, true))
      .toBe('playerMech_leftArm');
  });

  it('picks the normal part texture whenever the weapon is not reloading', () => {
    const idle = { ...reloading, reloading: false };
    expect(partTextureKey('playerMech', 'rightTorso', idle, false)).toBe('playerMech_rightTorso');
    expect(partTextureKey('playerMech', 'rightTorso', idle, true)).toBe('playerMech_rightTorso');
  });

  it('respects the mech base key so co-op player 2 swaps its OWN textures', () => {
    expect(partTextureKey('playerMech1', 'rightArm', reloading, false))
      .toBe(`playerMech1_rightArm${MUZZLE_OFF_SUFFIX}`);
  });

  it('an empty slot always shows the normal part texture', () => {
    expect(partTextureKey('playerMech', 'leftTorso', undefined, false)).toBe('playerMech_leftTorso');
  });
});
