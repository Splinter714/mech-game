import { describe, it, expect, vi } from 'vitest';
import { Mech, AMMO_EMPTY_COOLDOWN } from './Mech.js';
import { LOCATIONS } from './anatomy.js';
import { WEAPONS } from './weapons.js';

// #372 retuned every weapon's magazine (ammoMax/ammoRegen) so a held trigger runs dry in
// ~6s. These ammo tests are about the generic Mech MECHANICS (spend, regen, cap, per-slot
// empty-cooldown), not about any particular weapon's balance, so they read the catalog's
// live numbers instead of hard-coding them — a future retune can't silently break them.
// PC = the slow cycled weapon under test, AC = a second, independent weapon in another slot.
const PC = WEAPONS.plasmaCannon;      // ammoMax/ammoRegen read live
const AC = WEAPONS.autocannon;

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
    expect(ct.hp).toBe(ct.maxHp - 5);
    expect(m.isPartDestroyed('leftTorso')).toBe(false);
  });

  it('destroys a part once structure reaches 0', () => {
    const m = new Mech({ chassisId: 'light' });
    const arm = m.parts.leftArm;
    const res = m.applyDamage('leftArm', arm.maxArmor + arm.maxHp + 10);
    expect(arm.hp).toBe(0);
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
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxHp + 50);

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
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxHp + 50);

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
    m.applyDamage('leftArm', m.parts.leftArm.maxArmor + m.parts.leftArm.maxHp + 10);
    expect(m.onlineWeapons()).toHaveLength(0);
    expect(m.weapons()[0].online).toBe(false);
  });
});

describe('Mech weapon ammo (self-regenerating magazines)', () => {
  it('starts a mounted weapon with a full magazine', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon');
    expect(m.weapons()[0].ammo).toBe(AC.ammoMax);
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('firing spends ammo and an empty weapon is not ready', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    for (let i = 0; i < PC.ammoMax; i++) m.consumeAmmo('leftArm', 0, 1);
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].ready).toBe(false);
    expect(m.readyWeapons()).toHaveLength(0);
  });

  it('regenAmmo refills over time but never past the magazine size (partial drain, no cooldown)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, PC.ammoMax - 1); // leaves exactly 1 — a PARTIAL drain, not a
    // full empty, so #238's empty-cooldown never engages here; regen proceeds immediately.
    m.regenAmmo(2);
    expect(m.weapons()[0].ammo).toBeCloseTo(1 + PC.ammoRegen * 2, 5);
    m.regenAmmo(1000); // would overshoot the magazine many times over
    expect(m.weapons()[0].ammo).toBe(PC.ammoMax);
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
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, 1); // cycleMult defaults to 1 outside Overdrive
    expect(m.weapons()[0].ammo).toBe(PC.ammoMax - 1);
  });

  it('consumeAmmo spends only 0.5 ammo/shot when passed Overdrive\'s cycleMult (0.5)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, 0.5); // as fireWeapon would call it during Overdrive
    expect(m.weapons()[0].ammo).toBe(PC.ammoMax - 0.5);
    m.consumeAmmo('leftArm', 0, 0.5);
    expect(m.weapons()[0].ammo).toBe(PC.ammoMax - 1); // fractional consumption accumulates cleanly
  });

  it('Overdrive is net-neutral: N shots at 2x fire rate / 0.5 cost each drain the same total '
    + 'ammo as N shots at normal rate / 1 cost each', () => {
    // "Net-neutral" is a claim about a WINDOW OF TIME, not about a shot count: in the same
    // real seconds, Overdrive gets TWICE the shots out (cycleMult 0.5 halves the fire
    // interval) at half the cost each. So the fair comparison is N shots at 1.0 vs 2N shots
    // at 0.5 — not N vs N, which would trivially drain half as much.
    //
    // (The pre-#372 version of this test compared N vs N with N=10 against a 4-round
    // magazine: BOTH mechs bottomed out at consumeAmmo's 0 floor and the assertion passed on
    // the clamp rather than on the economy. #372's smaller magazines exposed that, hence the
    // rewrite. `shots` is now sized to stay strictly inside the magazine so neither mech
    // touches the floor and the arithmetic is actually being measured.)
    const shots = Math.max(1, Math.floor(PC.ammoMax / 2));

    const normal = new Mech({ chassisId: 'medium' });
    normal.mount('leftArm', 'plasmaCannon');
    for (let i = 0; i < shots; i++) normal.consumeAmmo('leftArm', 0, 1);

    const overdrive = new Mech({ chassisId: 'medium' });
    overdrive.mount('leftArm', 'plasmaCannon');
    for (let i = 0; i < shots * 2; i++) overdrive.consumeAmmo('leftArm', 0, 0.5);

    // Neither mech may have hit the 0 floor, or the comparison below is meaningless.
    expect(normal.weapons()[0].ammo).toBeGreaterThan(0);
    expect(overdrive.weapons()[0].ammo).toBeGreaterThan(0);

    const normalDrained = PC.ammoMax - normal.weapons()[0].ammo;
    const overdriveDrained = PC.ammoMax - overdrive.weapons()[0].ammo;
    // Same total ammo drained per shot fired, regardless of how fast those shots came out —
    // Overdrive fires twice as often in real time but costs half as much per shot, so over
    // the same span of seconds the economy nets out identical instead of draining faster.
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
    m.consumeAmmo('rightArm', 0, AC.ammoMax);
    expect(m.weapons()[0].ammo).toBe(0);
    m.repairAll();
    expect(m.weapons()[0].ammo).toBe(AC.ammoMax);
  });
});

// #238: a fully-drained weapon slot enters a cooldown lockout (AMMO_EMPTY_COOLDOWN
// seconds) — it can't fire and doesn't regen until the timer expires, scoped to only
// that one slot.
describe('Mech per-slot ammo-empty cooldown (#238)', () => {
  it('draining a magazine to exactly 0 starts that slot\'s cooldown', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, PC.ammoMax);
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].cooldown).toBeCloseTo(AMMO_EMPTY_COOLDOWN, 5);
    expect(m.weapons()[0].ready).toBe(false);
  });

  it('firing is blocked while a slot is on cooldown (ready stays false even if ammo were topped up)', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, PC.ammoMax);
    // Still well inside the cooldown window.
    m.regenAmmo(AMMO_EMPTY_COOLDOWN / 2);
    expect(m.weapons()[0].ready).toBe(false);
    expect(m.readyWeapons()).toHaveLength(0);
  });

  it('regenAmmo does not tick ammo up during the cooldown window — it only counts the timer down', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, PC.ammoMax);
    m.regenAmmo(2); // would tick ammo up if regen applied, but the cooldown blocks it
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].cooldown).toBeCloseTo(AMMO_EMPTY_COOLDOWN - 2, 5);
  });

  it('once the cooldown expires, normal regen resumes exactly as before', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.consumeAmmo('leftArm', 0, PC.ammoMax);
    // Tick past the cooldown window in one call (dt exceeds AMMO_EMPTY_COOLDOWN): the
    // remaining time after the timer hits 0 should NOT also count toward regen in the same
    // tick (each regenAmmo call spends its dt on cooldown OR regen, never splits mid-call) —
    // so drain it in two ticks: first clears the cooldown, second regenerates.
    m.regenAmmo(AMMO_EMPTY_COOLDOWN);
    expect(m.weapons()[0].cooldown).toBe(0);
    expect(m.weapons()[0].ammo).toBe(0); // cooldown just expired, no regen yet this tick
    expect(m.weapons()[0].ready).toBe(false); // still empty, but no longer on cooldown
    // Regen for however long it takes this weapon to earn back one full round — #372 made
    // the cycled weapons' regen much slower, so a fixed 2s no longer reaches `ready`.
    m.regenAmmo(1 / PC.ammoRegen);
    expect(m.weapons()[0].ammo).toBeCloseTo(1, 5);
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('cooldown is scoped to only the affected slot — other mounted weapons keep firing/regenerating normally', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon');
    m.mount('rightArm', 'autocannon');   // unaffected by the other slot's lockout
    m.consumeAmmo('leftArm', 0, PC.ammoMax); // drains leftArm to 0, starts ITS cooldown only
    m.consumeAmmo('rightArm', 0, 1); // rightArm just fires normally, no cooldown
    m.regenAmmo(2);

    const left = m.weapons().find((w) => w.location === 'leftArm');
    const right = m.weapons().find((w) => w.location === 'rightArm');
    expect(left.ammo).toBe(0); // still locked out, regen suppressed
    expect(left.ready).toBe(false);
    expect(right.ammo).toBeCloseTo(Math.min(AC.ammoMax, AC.ammoMax - 1 + AC.ammoRegen * 2), 5);
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
    const hpBefore = ct.hp;
    const restored = m.repairArmor(0.5);
    expect(ct.armor).toBeCloseTo(ct.maxArmor - missing + missing * 0.5);
    expect(ct.hp).toBe(hpBefore);   // patches plating only
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

// #324: `Mech.boostHealth` (and the per-part baseMaxArmor/baseMaxHp capture it needed) was
// deleted along with its only call site. The player-only 7x deploy buffer it existed to apply is
// now plain chassis data (data/chassis/mediumPlayer.js: 2100 armor + 1400 hp = the same 3500),
// which balance.test.js pins directly — so there is nothing left here to test for compounding.

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

// #246: full-mech shield — one pool covering the whole mech, absorbing BEFORE any per-location
// armor/hp is touched. A mech built with no `data.shield` at all (every existing enemy mech
// entry in data/enemies.js) has no shield — these tests are the config-driven opt-in path.
describe('Mech full-mech shield (#246)', () => {
  it('a mech with no shield config has none — applyDamage behaves exactly as before (no shield fields active)', () => {
    const m = new Mech({ chassisId: 'medium' });
    expect(m.hasShield()).toBe(false);
    const res = m.applyDamage('leftArm', 10);
    expect(res.shielded).toBe(false);
    expect(res.shieldAbsorbed).toBe(0);
    expect(res.applied).toBe(10);
  });

  it('a configured shield absorbs an entire hit before armor/hp are touched at all', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 50, regenPerSec: 0, pauseMs: 500 } });
    const arm = m.parts.leftArm;
    const armorBefore = arm.armor, hpBefore = arm.hp;
    const res = m.applyDamage('leftArm', 20);
    expect(res.shielded).toBe(true);
    expect(res.shieldAbsorbed).toBe(20);
    expect(res.applied).toBe(0);
    expect(arm.armor).toBe(armorBefore);
    expect(arm.hp).toBe(hpBefore);
    expect(m.shield.hp).toBe(30);
  });

  it('a hit exceeding the shield breaks it and the OVERFLOW lands on armor/hp normally', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 20, regenPerSec: 0, pauseMs: 500 } });
    const arm = m.parts.leftArm;
    const armorBefore = arm.armor;
    const res = m.applyDamage('leftArm', 34);
    expect(res.shielded).toBe(false);          // broke through, not a full-absorb hit
    expect(res.shieldAbsorbed).toBe(20);
    expect(res.applied).toBe(14);              // the overflow, same semantics as before shields
    expect(m.shield.hp).toBe(0);
    expect(arm.armor).toBe(armorBefore - 14);  // overflow ate armor, exactly like a normal hit
  });

  it('tickShield regenerates passively but pauses briefly right after a hit', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 50, regenPerSec: 10, pauseMs: 1000 } });
    m.applyDamage('leftArm', 10);        // shield -> 40, pause starts at 1000ms
    m.tickShield(0.5);                   // 500ms of pause burned, no regen yet
    expect(m.shield.hp).toBe(40);
    m.tickShield(0.5);                   // pause clears exactly here
    expect(m.shield.hp).toBe(40);
    m.tickShield(1);                     // regen now applies: +10
    expect(m.shield.hp).toBeCloseTo(50, 5);
  });

  // ── #381: TEMPORARY shield pool (D&D temp HP) — replaces #246/#271's capacity+regen multiplier.
  // The Shield powerup now grants an expendable pool ON TOP of base max: spent first, never
  // regenerating, never lifting the regen ceiling, and PERSISTING UNTIL SPENT by damage (no
  // time-expiry). Callers may still opt into a finite `durationMs` (the retained optional path).
  it('#381: grantTempShield adds an expendable pool ON TOP of base max — base max/regen/hp untouched, total grows', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    m.grantTempShield(150, 10000);
    expect(m.shield.max).toBe(40);            // base capacity is NEVER raised
    expect(m.shield.regenPerSec).toBe(2);     // …nor the regen rate
    expect(m.shield.hp).toBe(40);             // base filled to full
    expect(m.shield.temp).toBe(150);          // the expendable pool sits alongside
    expect(m.shieldTotalHp()).toBe(190);      // what the HUD/glow read: base + temp
    expect(m.shieldTotalMax()).toBe(190);
  });

  it('#381: damage spends the temporary pool FIRST, then base hp, then overflows to armor', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 0, pauseMs: 500 } });
    m.grantTempShield(50, 10000);             // temp 50 on top of base 40 (total 90)
    const arm = m.parts.leftArm;
    const armorBefore = arm.armor;

    let res = m.applyDamage('leftArm', 30);   // eats temp only: 50 -> 20
    expect(res.shielded).toBe(true);
    expect(m.shield.temp).toBe(20);
    expect(m.shield.hp).toBe(40);             // base untouched while temp remains
    expect(arm.armor).toBe(armorBefore);

    res = m.applyDamage('leftArm', 30);       // eats the last 20 temp, then 10 of base
    expect(m.shield.temp).toBe(0);
    expect(m.shield.hp).toBe(30);             // base now dipped into
    expect(arm.armor).toBe(armorBefore);

    res = m.applyDamage('leftArm', 40);       // 30 base left, 10 overflows to armor
    expect(m.shield.temp).toBe(0);
    expect(m.shield.hp).toBe(0);
    expect(res.applied).toBe(10);
    expect(arm.armor).toBe(armorBefore - 10);
  });

  it('#381: the temporary pool NEVER regenerates — regen only refills base hp up to base max', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 10, pauseMs: 0 } });
    m.grantTempShield(60, 10000);             // total 100
    m.applyDamage('leftArm', 80);             // temp 60 -> 0, base 40 -> 20
    expect(m.shield.temp).toBe(0);
    expect(m.shield.hp).toBe(20);

    m.tickShield(10);                         // plenty of regen time
    expect(m.shield.temp).toBe(0);            // spent temp does NOT come back
    expect(m.shield.hp).toBe(40);             // base refilled ONLY to base max, no higher
    expect(m.shieldTotalMax()).toBe(40);      // ceiling is back to base once temp is gone
  });

  it('#381: regen never lifts the ceiling — with temp still present, base hp caps at base max', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 10, pauseMs: 0 } });
    m.grantTempShield(60, 10000);
    m.applyDamage('leftArm', 20);             // eats temp only: 60 -> 40; base stays 40 (full)
    expect(m.shield.hp).toBe(40);
    m.tickShield(5);                          // base is already at max; regen can't push past it
    expect(m.shield.hp).toBe(40);
    expect(m.shield.temp).toBe(40);           // temp is untouched by regen
  });

  it('#381: the powerup grant (no durationMs) PERSISTS UNTIL SPENT — ticking past any window leaves it intact', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    m.grantTempShield(60);                     // powerup path: no expiry
    expect(m.shield.tempExpiryMs).toBe(Infinity);
    m.tickShield(60);                          // tick well past any 10s window, no damage
    m.tickShield(60);
    expect(m.shield.temp).toBe(60);            // pool is fully intact — it never time-decays
    m.applyDamage('leftArm', 60);              // …and it is still spent by damage
    expect(m.shield.temp).toBe(0);
    m.tickShield(10);
    expect(m.shield.temp).toBe(0);             // once depleted it stays gone
  });

  it('#381: a caller may still opt into a FINITE window, and an unspent pool expires with it', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    m.grantTempShield(60, 8000);
    m.tickShield(7.999);                      // just under the window
    expect(m.shield.temp).toBe(60);           // still there
    expect(m.tempShieldRemainingMs).toBeCloseTo(1, 0);

    m.tickShield(0.002);                      // window elapses
    expect(m.shield.temp).toBe(0);            // unspent pool gone
    expect(m.tempShieldRemainingMs).toBe(0);
    expect(m.shield.hp).toBe(40);             // base is unaffected by temp expiry
  });

  it('#381: a duplicate grant refreshes the pool to the same size (magnitude never compounds) and extends the window', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    m.grantTempShield(60, 5000);
    m.applyDamage('leftArm', 30);             // temp 60 -> 30
    expect(m.shield.temp).toBe(30);

    m.grantTempShield(60, 8000);              // duplicate — refills the pool to 60, NOT 90
    expect(m.shield.temp).toBe(60);
    expect(m.tempShieldRemainingMs).toBe(8000);
    expect(m.shield.max).toBe(40);            // base still never touched
  });

  it('#381: grantTempShield can shield a chassis with no native shield, and it still drains first', () => {
    const m = new Mech({ chassisId: 'medium' });   // no shield config: max 0
    expect(m.hasShield()).toBe(false);
    m.grantTempShield(50, 10000);
    expect(m.shield.temp).toBe(50);
    const res = m.applyDamage('leftArm', 20);      // temp absorbs even without a base pool
    expect(res.shielded).toBe(true);
    expect(m.shield.temp).toBe(30);
  });

  it('repairAll refills the shield and clears any lingering temporary pool from a prior sortie', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    m.grantTempShield(150, 5000);
    m.applyDamage('leftArm', 10);
    m.repairAll();
    expect(m.shield.max).toBe(40);            // base config intact
    expect(m.shield.hp).toBe(40);             // full
    expect(m.shield.temp).toBe(0);            // temp pool wiped
    expect(m.tempShieldRemainingMs).toBe(0);
    expect(m.shield.pauseRemaining).toBe(0);
  });
});
