// #433 (re-architecture, then simplified from a blink to steady on/off): the reload indicator is a
// VISIBILITY toggle on a separate per-slot muzzle-glow overlay sprite — the part texture never
// changes. These lock in the pure decision seam: whether a slot's glow overlay is shown this frame,
// given only the weapon's own state (no time/cadence input).
import { describe, it, expect } from 'vitest';
import { glowOverlayVisible } from './ammoIndicators.js';

// A limited-ammo weapon mid-reload: online, has a real magazine, reloading.
const reloading = { online: true, ammo: 0, reloading: true, location: 'leftArm' };

describe('glowOverlayVisible', () => {
  it('hides the overlay for the whole time an online, limited-ammo weapon is reloading', () => {
    expect(glowOverlayVisible(reloading)).toBe(false);
  });

  it('stays solid ON for a loaded weapon that is not reloading', () => {
    const idle = { ...reloading, reloading: false };
    expect(glowOverlayVisible(idle)).toBe(true);
  });

  it('keeps an unlimited-ammo weapon (ammo == null, e.g. melee) solid on — it never reloads', () => {
    const melee = { ...reloading, ammo: null };
    expect(glowOverlayVisible(melee)).toBe(true);
  });

  it('hides the overlay for an offline (destroyed-part) weapon regardless of reload state', () => {
    const offline = { ...reloading, online: false };
    expect(glowOverlayVisible(offline)).toBe(false);
    expect(glowOverlayVisible({ ...offline, reloading: false })).toBe(false);
  });

  it('hides the overlay for an empty slot (no weapon)', () => {
    expect(glowOverlayVisible(undefined)).toBe(false);
    expect(glowOverlayVisible(null)).toBe(false);
  });
});
