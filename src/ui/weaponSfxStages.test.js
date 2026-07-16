import { describe, it, expect } from 'vitest';
import { WEAPON_STAGES, testFirePlan } from './weaponSfxStages.js';
import { SFX_DOMAINS } from '../audio/sfxDomains.js';

// #191: "test fire" on a non-weapon UI sound (e.g. the "Equip Weapon" cue registered via
// sfxDomains.js's `ui` domain, #177/#178) played a completely unrelated procedural WEAPON
// sound instead of the UI sound's own configured cue. Root cause: WeaponSfxPanel._testFire()
// hardcoded 'fire'/'trajectory'/'impact' as the stages to preview, regardless of what the
// CURRENTLY TARGETED thing's own `stages` list actually was — so previewing a UI cue (whose
// only real stage is `play`) still called `_playStage('fire')`, which sends the UI id through
// the WEAPON-shaped `Audio.fire({ id })` call. That id isn't in WEAPONS/DEFAULT_SFX, so
// getSfxParams() silently fell back to FALLBACK_SFX — a generic procedural weapon sound with
// zero relation to the UI cue actually selected in the panel.
//
// testFirePlan(stages, ...) is the extracted, Phaser-free planning logic _testFire() now uses:
// it must build the play sequence from the TARGET's own stage keys, not a hardcoded weapon
// triple, so previewing works identically whether the target came from WEAPONS or SFX_DOMAINS.
describe('testFirePlan (#191)', () => {
  it('plays fire -> trajectory -> impact with the real weapon stagger for a weapon-shaped target', () => {
    const plan = testFirePlan(WEAPON_STAGES, 120);
    expect(plan).toEqual([
      { stage: 'fire', delay: 0 },
      { stage: 'trajectory', delay: 120 },
      { stage: 'impact', delay: 300 },
    ]);
  });

  it('plays only the stages a weapon-shaped target actually has (e.g. a destruction-explosion category, fire only)', () => {
    const explosionStages = [['fire', 'FIRE']];
    const plan = testFirePlan(explosionStages, 120);
    expect(plan).toEqual([{ stage: 'fire', delay: 0 }]);
  });

  it('plays a non-weapon (SFX_DOMAINS) target\'s OWN stage, not a hardcoded "fire" stage', () => {
    const equip = SFX_DOMAINS.ui.find((e) => e.id === 'equip');
    expect(equip.stages).toEqual([['play', 'PLAY']]);

    const plan = testFirePlan(equip.stages, 120);

    // The bug, concretely: the old _testFire() would have queued 'fire' (and delayed
    // 'trajectory'/'impact' calls) regardless of what `stages` said. The fix must instead
    // produce exactly this target's own stage(s), immediately, with no weapon-shaped stages
    // fabricated out of thin air.
    expect(plan).toEqual([{ stage: 'play', delay: 0 }]);
    expect(plan.some((p) => p.stage === 'fire')).toBe(false);
  });

  it('every registered UI domain entry previews its own stage(s) only, never a weapon stage', () => {
    for (const entry of SFX_DOMAINS.ui) {
      const plan = testFirePlan(entry.stages, 120);
      const stageNames = plan.map((p) => p.stage);
      expect(stageNames).toEqual(entry.stages.map(([key]) => key));
      expect(stageNames).not.toContain('fire');
    }
  });
});
