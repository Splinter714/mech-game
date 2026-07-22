// #433 (re-architecture): the reload blink is now a VISIBILITY toggle on a separate per-slot muzzle-
// glow overlay sprite — the part texture never changes. These lock in the pure decision seam: whether
// a slot's glow overlay is shown this frame, given the weapon's state and the blink phase.
import { describe, it, expect } from 'vitest';
import { glowOverlayVisible } from './ammoIndicators.js';

// A limited-ammo weapon mid-reload: online, has a real magazine, reloading.
const reloading = { online: true, ammo: 0, reloading: true, location: 'leftArm' };

describe('glowOverlayVisible', () => {
  it('blinks with the phase while an online, limited-ammo weapon is reloading', () => {
    expect(glowOverlayVisible(reloading, true)).toBe(true);    // on phase → glow shown
    expect(glowOverlayVisible(reloading, false)).toBe(false);  // off phase → glow hidden
  });

  it('stays solid ON for a loaded weapon that is not reloading (both phases)', () => {
    const idle = { ...reloading, reloading: false };
    expect(glowOverlayVisible(idle, true)).toBe(true);
    expect(glowOverlayVisible(idle, false)).toBe(true);
  });

  it('keeps an unlimited-ammo weapon (ammo == null, e.g. melee) solid on — it never reloads', () => {
    const melee = { ...reloading, ammo: null };
    expect(glowOverlayVisible(melee, true)).toBe(true);
    expect(glowOverlayVisible(melee, false)).toBe(true);
  });

  it('hides the overlay for an offline (destroyed-part) weapon on either phase', () => {
    const offline = { ...reloading, online: false };
    expect(glowOverlayVisible(offline, true)).toBe(false);
    expect(glowOverlayVisible(offline, false)).toBe(false);
  });

  it('hides the overlay for an empty slot (no weapon)', () => {
    expect(glowOverlayVisible(undefined, true)).toBe(false);
    expect(glowOverlayVisible(null, false)).toBe(false);
  });
});
