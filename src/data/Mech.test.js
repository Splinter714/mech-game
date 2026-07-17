import { describe, it, expect, vi } from 'vitest';
import { Mech, AMMO_EMPTY_COOLDOWN } from './Mech.js';
import { LOCATIONS } from './anatomy.js';

// Unlimited-ammo (ammoMax: null) is a generic mechanic — historically exercised by the
// melee category, which has no live entry in the registry anymore. Inject a test-only
// fixture with that shape so the behavior stays covered without reviving a real weapon.
vi.mock('./weapons.js', async (importOriginal) => {
  const actual = await importOriginal();
  const WEAPONS = {
    ...actual.WEAPONS,
    testMelee: {
      id: 'testMelee', name: 'Test Melee', category: 'melee',
      damage: 22, range: { min: 0, opt: 0, max: 32 },
      ammoMax: null, ammoRegen: 0, slots: 2, cycleTime: 1300,
      delivery: { hit: 'contact', pattern: 'single', kind: 'slash' },
    },
  };
  return {
    ...actual,
    WEAPONS,
    WEAPON_IDS: Object.keys(WEAPONS),
    getWeapon: (id) => WEAPONS[id],
  };
});

describe('Mech damage: armor then structure', () => {
  it('depletes armor before structure, no destruction until structure hits 0', () => {
    const m = new Mech({ chassisId: 'light' });
    const ct = m.parts.leftTorso;
    m.applyDamage('leftTorso', ct.maxArmor + 5);
    expect(ct.armor).toBe(0);
    expect(ct.structure).toBe(ct.maxStructure - 5);
    expect(m.isPartDestroyed('leftTorso')).toBe(false);
  });

  it('destroys a part once structure reaches 0', () => {
    const m = new Mech({ chassisId: 'light' });
    const arm = m.parts.leftArm;
    const res = m.applyDamage('leftArm', arm.maxArmor + arm.maxStructure + 10);
    expect(arm.structure).toBe(0);
    expect(res.destroyed).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
  });
});

describe('Mech build completeness (deploy gating)', () => {
  it('isComplete only once every weapon slot is filled with a legal item', () => {
    const m = new Mech({ chassisId: 'light' });
    expect(m.isComplete()).toBe(false);                 // empty build
    m.mount('leftArm', 'pulseLaser');
    m.mount('rightArm', 'beamLaser');
    m.mount('leftTorso', 'autocannon');
    expect(m.isComplete()).toBe(false);                 // right torso still empty
    m.mount('rightTorso', 'machineGun');
    expect(m.isComplete()).toBe(true);                  // all four filled
  });
});

describe('Mech kill rule (#128: both side torsos destroyed = kill)', () => {
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxStructure + 50);

  it('destroying both side torsos is lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftTorso');
    expect(m.isDestroyed()).toBe(false);   // one side torso alone isn't enough
    overkill(m, 'rightTorso');
    expect(m.isDestroyed()).toBe(true);
  });

  it('destroying only one side torso is NOT lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftTorso');
    expect(m.isDestroyed()).toBe(false);
  });

  it('losing both arms (torsos intact) is NOT lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftArm');
    overkill(m, 'rightArm');
    expect(m.isDestroyed()).toBe(false);
  });

  it('head/cockpit/centerTorso are no longer damage-tracked or lethal — massive "damage" to them is a no-op, never a kill', () => {
    for (const loc of ['head', 'cockpit', 'centerTorso']) expect(LOCATIONS).not.toContain(loc);
    const m = new Mech({ chassisId: 'medium' });
    for (const loc of ['head', 'cockpit', 'centerTorso']) {
      expect(m.parts[loc]).toBeUndefined();
      const res = m.applyDamage(loc, 999999);
      expect(res.applied).toBe(0);
      expect(res.destroyed).toBe(false);
      expect(m.isPartDestroyed(loc)).toBe(false);
    }
    expect(m.isDestroyed()).toBe(false);
  });

  it('centerTorso is no longer mountable at all (#188: Sprint replaced the old ability slot)', () => {
    const m = new Mech({ chassisId: 'medium' });
    expect(m.canMount('centerTorso', 'autocannon').ok).toBe(false);
    expect(m.mounts.centerTorso).toBeUndefined();
  });
});

describe('Mech damage propagation (cascade)', () => {
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxStructure + 50);

  it('destroying a side torso also destroys the attached arm', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftTorso');
    expect(m.isPartDestroyed('leftTorso')).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
    expect(m.isPartDestroyed('rightArm')).toBe(false);
  });

  it('a weapon in an arm goes offline when its side torso is destroyed', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon');
    expect(m.onlineWeapons()).toHaveLength(1);
    overkill(m, 'rightTorso');
    expect(m.onlineWeapons()).toHaveLength(0);
  });

  it('destroying both side torsos leaves all four WEAPON_SLOTS destroyed (weapons blown off before death, per #128)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'pulseLaser');
    m.mount('rightArm', 'beamLaser');
    m.mount('leftTorso', 'autocannon');
    m.mount('rightTorso', 'machineGun');
    overkill(m, 'leftTorso');
    overkill(m, 'rightTorso');
    expect(m.isDestroyed()).toBe(true);
    for (const loc of ['leftTorso', 'rightTorso', 'leftArm', 'rightArm']) {
      expect(m.isPartDestroyed(loc)).toBe(true);
    }
    expect(m.onlineWeapons()).toHaveLength(0);
  });
});

describe('Mech weapons go offline with their part', () => {
  it('a weapon in a destroyed arm is no longer online', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'pulseLaser');
    expect(m.onlineWeapons()).toHaveLength(1);
    m.applyDamage('leftArm', m.parts.leftArm.maxArmor + m.parts.leftArm.maxStructure + 10);
    expect(m.onlineWeapons()).toHaveLength(0);
    expect(m.weapons()[0].online).toBe(false);
  });
});

describe('Mech weapon ammo (self-regenerating magazines)', () => {
  it('starts a mounted weapon with a full magazine', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon'); // ammoMax 12
    expect(m.weapons()[0].ammo).toBe(12);
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('firing spends ammo and an empty weapon is not ready', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4
    for (let i = 0; i < 4; i++) m.consumeAmmo('leftArm', 0, 1);
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].ready).toBe(false);
    expect(m.readyWeapons()).toHaveLength(0);
  });

  it('regenAmmo refills over time but never past the magazine size (partial drain, no cooldown)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4, regen 0.5/s
    m.consumeAmmo('leftArm', 0, 3); // down to 1 — a partial drain, not a full empty, so
    // #238's empty-cooldown never engages here; regen should proceed immediately.
    m.regenAmmo(2); // +1.0
    expect(m.weapons()[0].ammo).toBeCloseTo(2, 5);
    m.regenAmmo(100); // would overshoot
    expect(m.weapons()[0].ammo).toBe(4);
  });

  // #235: Overdrive halves the fire cycle (cycleMult 0.5 -> shots go out ~2x as often).
  // Rather than boost ammo regen, firing.js's fireWeapon scales the CONSUMED amount by
  // cycleMult (`this.mech.consumeAmmo(w.location, w.index, mods.cycleMult ?? 1)`), so during
  // Overdrive each shot only spends 0.5 ammo — exactly offsetting the 2x fire rate for a
  // net-neutral economy, distinct from Overcharge's true unlimited ammo (freeAmmo). These
  // tests exercise consumeAmmo directly (the arena scene call site isn't unit-testable here),
  // confirming it accepts a fractional `n` cleanly with no rounding/truncation.
  it('consumeAmmo spends a flat 1 ammo/shot at normal (non-Overdrive) fire rate, unchanged', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4
    m.consumeAmmo('leftArm', 0, 1); // cycleMult defaults to 1 outside Overdrive
    expect(m.weapons()[0].ammo).toBe(3);
  });

  it('consumeAmmo spends only 0.5 ammo/shot when passed Overdrive\'s cycleMult (0.5)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4
    m.consumeAmmo('leftArm', 0, 0.5); // as fireWeapon would call it during Overdrive
    expect(m.weapons()[0].ammo).toBe(3.5);
    m.consumeAmmo('leftArm', 0, 0.5);
    expect(m.weapons()[0].ammo).toBe(3); // fractional consumption accumulates cleanly
  });

  it('Overdrive is net-neutral: N shots at 2x fire rate / 0.5 cost each drain the same total '
    + 'ammo as N shots at normal rate / 1 cost each', () => {
    const shots = 10;

    const normal = new Mech({ chassisId: 'medium' });
    normal.mount('leftArm', 'plasmaCannon');
    for (let i = 0; i < shots; i++) normal.consumeAmmo('leftArm', 0, 1);

    const overdrive = new Mech({ chassisId: 'medium' });
    overdrive.mount('leftArm', 'plasmaCannon');
    for (let i = 0; i < shots; i++) overdrive.consumeAmmo('leftArm', 0, 0.5);

    const normalDrained = 4 - normal.weapons()[0].ammo;   // plasmaCannon ammoMax 4
    const overdriveDrained = 4 - overdrive.weapons()[0].ammo;
    // Same total ammo drained per shot fired, regardless of how fast those shots came out —
    // Overdrive fires twice as often in real time but costs half as much per shot, so the
    // economy nets out identical shot-for-shot instead of draining faster.
    expect(overdriveDrained).toBeCloseTo(normalDrained, 5);
  });

  it('melee weapons have unlimited ammo and stay ready', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'testMelee'); // ammoMax null
    expect(m.weapons()[0].ammo).toBeNull();
    m.consumeAmmo('rightArm', 0, 5); // no-op
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('repairAll tops every magazine back up', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon');
    m.consumeAmmo('rightArm', 0, 12);
    expect(m.weapons()[0].ammo).toBe(0);
    m.repairAll();
    expect(m.weapons()[0].ammo).toBe(12);
  });
});

// #238: a fully-drained weapon slot enters a cooldown lockout (AMMO_EMPTY_COOLDOWN
// seconds) — it can't fire and doesn't regen until the timer expires, scoped to only
// that one slot.
describe('Mech per-slot ammo-empty cooldown (#238)', () => {
  it('draining a magazine to exactly 0 starts that slot\'s cooldown', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4
    m.consumeAmmo('leftArm', 0, 4);
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].cooldown).toBeCloseTo(AMMO_EMPTY_COOLDOWN, 5);
    expect(m.weapons()[0].ready).toBe(false);
  });

  it('firing is blocked while a slot is on cooldown (ready stays false even if ammo were topped up)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, 4);
    // Still well inside the cooldown window.
    m.regenAmmo(AMMO_EMPTY_COOLDOWN / 2);
    expect(m.weapons()[0].ready).toBe(false);
    expect(m.readyWeapons()).toHaveLength(0);
  });

  it('regenAmmo does not tick ammo up during the cooldown window — it only counts the timer down', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // regen 0.5/s
    m.consumeAmmo('leftArm', 0, 4);
    m.regenAmmo(2); // would be +1.0 ammo if regen applied, but cooldown blocks it
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].cooldown).toBeCloseTo(AMMO_EMPTY_COOLDOWN - 2, 5);
  });

  it('once the cooldown expires, normal regen resumes exactly as before', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4, regen 0.5/s
    m.consumeAmmo('leftArm', 0, 4);
    // Tick past the cooldown window in one call (dt exceeds AMMO_EMPTY_COOLDOWN): the
    // remaining time after the timer hits 0 should NOT also count toward regen in the same
    // tick (each regenAmmo call spends its dt on cooldown OR regen, never splits mid-call) —
    // so drain it in two ticks: first clears the cooldown, second regenerates.
    m.regenAmmo(AMMO_EMPTY_COOLDOWN);
    expect(m.weapons()[0].cooldown).toBe(0);
    expect(m.weapons()[0].ammo).toBe(0); // cooldown just expired, no regen yet this tick
    expect(m.weapons()[0].ready).toBe(false); // still empty, but no longer on cooldown
    m.regenAmmo(2); // +1.0, normal regen now applies
    expect(m.weapons()[0].ammo).toBeCloseTo(1, 5);
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('cooldown is scoped to only the affected slot — other mounted weapons keep firing/regenerating normally', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');  // ammoMax 4, regen 0.5/s
    m.mount('rightArm', 'autocannon');   // ammoMax 12, unaffected
    m.consumeAmmo('leftArm', 0, 4); // drains leftArm to 0, starts ITS cooldown only
    m.consumeAmmo('rightArm', 0, 3); // rightArm just fires normally, no cooldown
    m.regenAmmo(2);

    const left = m.weapons().find((w) => w.location === 'leftArm');
    const right = m.weapons().find((w) => w.location === 'rightArm');
    expect(left.ammo).toBe(0); // still locked out, regen suppressed
    expect(left.ready).toBe(false);
    expect(right.ammo).toBeCloseTo(11, 5); // 12 - 3 spent + 2s * 1.0/s regen ticking normally
    expect(right.ready).toBe(true);
  });

  it('repeatedly firing an already-dry weapon does not keep resetting the cooldown timer', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, 4); // drains to 0, cooldown starts at full
    m.regenAmmo(1); // cooldown ticks down
    m.consumeAmmo('leftArm', 0, 1); // still 0 ammo, a no-op drain — must not reset the timer
    expect(m.weapons()[0].cooldown).toBeCloseTo(AMMO_EMPTY_COOLDOWN - 1, 5);
  });

  it('repairAll clears an active cooldown along with topping ammo back up', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, 4);
    expect(m.weapons()[0].cooldown).toBeGreaterThan(0);
    m.repairAll();
    expect(m.weapons()[0].cooldown).toBe(0);
    expect(m.weapons()[0].ready).toBe(true);
  });
});

describe('Mech.repairArmor (#60 Armor Patch — whole-mech proportional armor repair)', () => {
  it('restores a fraction of each damaged location\'s missing armor, leaving structure alone', () => {
    const m = new Mech({ chassisId: 'medium' });
    const ct = m.parts.leftTorso;
    // Knock armor down (stay within armor so structure is untouched).
    m.applyDamage('leftTorso', Math.min(ct.maxArmor, 20));
    const missing = ct.maxArmor - ct.armor;
    const structureBefore = ct.structure;
    const restored = m.repairArmor(0.5);
    expect(ct.armor).toBeCloseTo(ct.maxArmor - missing + missing * 0.5);
    expect(ct.structure).toBe(structureBefore);   // patches plating only
    expect(restored).toBeGreaterThan(0);
  });

  it('never exceeds max armor and is a no-op on a pristine mech', () => {
    const m = new Mech({ chassisId: 'light' });
    expect(m.repairArmor(0.5)).toBe(0);
    for (const loc of Object.keys(m.parts)) {
      expect(m.parts[loc].armor).toBeLessThanOrEqual(m.parts[loc].maxArmor);
    }
  });
});

describe('Mech.boostHealth (#69 deploy survivability buffer — must not compound)', () => {
  it('multiplies chassis base max armor/structure by exactly mult', () => {
    const m = new Mech({ chassisId: 'medium' });
    const baseArmor = m.parts.leftTorso.maxArmor;
    const baseStructure = m.parts.leftTorso.maxStructure;
    m.boostHealth(100);
    expect(m.parts.leftTorso.maxArmor).toBe(Math.round(baseArmor * 100));
    expect(m.parts.leftTorso.maxStructure).toBe(Math.round(baseStructure * 100));
    expect(m.parts.leftTorso.armor).toBe(m.parts.leftTorso.maxArmor);
    expect(m.parts.leftTorso.structure).toBe(m.parts.leftTorso.maxStructure);
  });

  it('calling boostHealth twice in a row (simulating repeated redeploys) is idempotent, not compounding', () => {
    const m = new Mech({ chassisId: 'medium' });
    const baseArmor = m.parts.leftTorso.maxArmor;
    const baseStructure = m.parts.leftTorso.maxStructure;

    m.boostHealth(100);
    const afterFirst = { armor: m.parts.leftTorso.maxArmor, structure: m.parts.leftTorso.maxStructure };

    m.boostHealth(100);
    const afterSecond = { armor: m.parts.leftTorso.maxArmor, structure: m.parts.leftTorso.maxStructure };

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.armor).toBe(Math.round(baseArmor * 100));
    expect(afterSecond.structure).toBe(Math.round(baseStructure * 100));
  });

  it('repairAll (deploy refill) between boosts does not cause boostHealth to compound', () => {
    const m = new Mech({ chassisId: 'medium' });
    const baseArmor = m.parts.leftTorso.maxArmor;

    // Simulate the ArenaScene deploy path across three sorties: repairAll() then
    // boostHealth(100) each time.
    for (let i = 0; i < 3; i++) {
      m.repairAll();
      m.boostHealth(100);
    }

    expect(m.parts.leftTorso.maxArmor).toBe(Math.round(baseArmor * 100));
  });
});

describe('Mech mounting: one copy of a weapon at a time (#84)', () => {
  it('mounting an already-mounted weapon into a new slot MOVES it, not duplicates it', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'autocannon');
    expect(m.mounts.leftArm).toEqual(['autocannon']);

    const res = m.mount('rightArm', 'autocannon');
    expect(res.ok).toBe(true);
    expect(m.mounts.leftArm).toEqual([]);          // old slot vacated
    expect(m.mounts.rightArm).toEqual(['autocannon']); // new slot holds it
    // Exactly one location holds it, never two.
    const holders = ['leftArm', 'rightArm', 'leftTorso', 'rightTorso'].filter(
      (loc) => m.mounts[loc].includes('autocannon'),
    );
    expect(holders).toEqual(['rightArm']);
  });

  it('the moved weapon keeps a fresh magazine (ammo array stays in sync with the move)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'autocannon');
    m.mount('rightArm', 'autocannon');
    expect(m.ammo.leftArm).toEqual([]);
    expect(m.ammo.rightArm).toHaveLength(1);
  });

  it('locationOf reports where an item currently lives, or null if unmounted', () => {
    const m = new Mech({ chassisId: 'medium' });
    expect(m.locationOf('autocannon')).toBeNull();
    m.mount('leftTorso', 'autocannon');
    expect(m.locationOf('autocannon')).toBe('leftTorso');
    m.mount('rightTorso', 'autocannon');
    expect(m.locationOf('autocannon')).toBe('rightTorso');
  });

  it('re-mounting into the SAME slot it already occupies is a no-op move (stays put, no loss)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'autocannon');
    m.mount('leftArm', 'autocannon');
    expect(m.mounts.leftArm).toEqual(['autocannon']);
  });

  it('moving a weapon does not disturb an unrelated slot holding a different weapon', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'autocannon');
    m.mount('leftTorso', 'pulseLaser');
    m.mount('rightArm', 'autocannon');   // moves autocannon leftArm -> rightArm
    expect(m.mounts.leftTorso).toEqual(['pulseLaser']);
  });

});

describe('Mech serialization', () => {
  it('round-trips chassis, mounts, and battle damage', () => {
    const m = new Mech({ chassisId: 'heavy', name: 'Old Faithful' });
    m.mount('rightArm', 'autocannon');
    m.applyDamage('rightTorso', 10);
    const restored = new Mech(m.toJSON());
    expect(restored.chassisId).toBe('heavy');
    expect(restored.name).toBe('Old Faithful');
    expect(restored.mounts.rightArm).toEqual(['autocannon']);
    expect(restored.parts.rightTorso.armor).toBe(m.parts.rightTorso.armor);
  });
});
