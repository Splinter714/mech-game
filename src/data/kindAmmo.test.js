// #375 (redefined) — emplaced-turret ammo now uses the PLAYER reload model (#402): a MAGAZINE that
// drains a round per pull, and once EMPTY locks out for RELOAD_SECONDS then snaps back to FULL —
// no `ammoRegen` trickle. So an emplaced turret suppresses exactly like the player's own gun: dump
// the mag, wait the reload. These tests pin (1) the scope gate (emplaced kinds only), (2) the
// magazine mechanics, and (3) the reload behaviour itself.
import { describe, it, expect } from 'vitest';
import { ENEMY_KINDS } from './enemyKinds.js';
import { kindWeaponSlot, DEFAULT_SLOT } from './kindWeapons.js';
import { resolveWeapon } from './weapons.js';
import { RELOAD_SECONDS } from './Mech.js';
import {
  slotAmmoSpec, initKindAmmo, initKindReload, slotHasAmmo, consumeSlotAmmo, tickKindReload,
} from './kindAmmo.js';

// The kinds that ride the vehicle fire path. Only the two EMPLACED ones are ammo-limited (the
// scope decision recorded in kindAmmo.js's header).
const EMPLACED = ['turret', 'wallTurret'];
const MOBILE = ['tank', 'drone', 'helicopter', 'carrier', 'infantry'];

// Mirrors the production loop for ONE slot: `_updateVehicle` ticks the cooldown and calls
// tickKindReload every frame; `_fireVehicleWeapon` fires when the cooldown has expired AND a whole
// round is available, then spends one round (arming its reload if that emptied the mag) and
// re-arms the cadence. Returns the shot TIMES plus the min ammo seen, so a test can ask "how many
// shots in the opening mag" and "did it actually reach empty".
function simulate(kindId, seconds, stepMs = 20) {
  const def = ENEMY_KINDS[kindId];
  const mount = kindWeaponSlot(def);
  const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
  const interval = weapon.cycleTime;       // every emplaced kind is a single-shot cycleTime weapon
  const ammo = initKindAmmo(def);
  const reload = initKindReload(def);
  const shots = [];
  let cd = 0;
  let minAmmo = Infinity;
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    if (cd <= 0 && slotHasAmmo(ammo, DEFAULT_SLOT)) {
      shots.push(t / 1000);
      consumeSlotAmmo(ammo, DEFAULT_SLOT, 1, reload);
      cd = interval;
    }
    cd = Math.max(0, cd - stepMs);
    tickKindReload(def, ammo, reload, stepMs / 1000);
    minAmmo = Math.min(minAmmo, ammo[DEFAULT_SLOT]);
  }
  return { shots, ammo, reload, interval, minAmmo };
}

describe('#375 scope: ammo limits the EMPLACED kinds only', () => {
  it.each(EMPLACED)('%s opts in and gets a real magazine', (id) => {
    expect(ENEMY_KINDS[id].ammoLimited).toBe(true);
    const ammo = initKindAmmo(ENEMY_KINDS[id]);
    expect(Object.keys(ammo)).toEqual([DEFAULT_SLOT]);
    expect(ammo[DEFAULT_SLOT]).toBeGreaterThan(0);
    // Its magazine size IS the resolved weapon's own ammoMax — same number the player's gun uses.
    const mount = kindWeaponSlot(ENEMY_KINDS[id]);
    const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
    expect(ammo[DEFAULT_SLOT]).toBe(weapon.ammoMax);
  });

  it.each(EMPLACED)('%s starts with no pending reload', (id) => {
    expect(initKindReload(ENEMY_KINDS[id])).toEqual({ [DEFAULT_SLOT]: 0 });
  });

  it.each(MOBILE)('%s is NOT ammo-limited — a mobile enemy pausing mid-fight is out of scope', (id) => {
    expect(ENEMY_KINDS[id].ammoLimited).toBeFalsy();
    expect(initKindAmmo(ENEMY_KINDS[id])).toEqual({});
    expect(initKindReload(ENEMY_KINDS[id])).toEqual({});
  });

  it('a kind with no magazine reads as unlimited everywhere (no behaviour change off the opt-in)', () => {
    const ammo = initKindAmmo(ENEMY_KINDS.tank);
    expect(slotHasAmmo(ammo, DEFAULT_SLOT)).toBe(true);
    consumeSlotAmmo(ammo, DEFAULT_SLOT, 99);
    expect(slotHasAmmo(ammo, DEFAULT_SLOT)).toBe(true);   // still unlimited, still fires
  });

  it('the opt-in flag, not "the weapon happens to have ammoMax", is the gate', () => {
    // The multi-weapon gunship's base weapons carry magazines of their own, but it never opts in.
    expect(initKindAmmo(ENEMY_KINDS.helicopter)).toEqual({});
    const mount = kindWeaponSlot(ENEMY_KINDS.helicopter, 'flank');
    expect(slotAmmoSpec(ENEMY_KINDS.helicopter, mount)).toBeNull();
    // Flip the flag on a copy and the same slot DOES resolve a spec — proving the flag is what
    // decides, and that widening scope later is one field per kind.
    const optedIn = { ...ENEMY_KINDS.helicopter, ammoLimited: true };
    expect(slotAmmoSpec(optedIn, kindWeaponSlot(optedIn, 'flank'))).not.toBeNull();
  });
});

describe('#375 magazine mechanics', () => {
  it('spends one round per TRIGGER PULL and never goes below zero', () => {
    const ammo = { main: 2 };
    consumeSlotAmmo(ammo, 'main', 1);
    expect(ammo.main).toBe(1);
    consumeSlotAmmo(ammo, 'main', 5);
    expect(ammo.main).toBe(0);
  });

  it('needs a WHOLE round to fire — an empty magazine is dry', () => {
    expect(slotHasAmmo({ main: 0 }, 'main')).toBe(false);
    expect(slotHasAmmo({ main: 0.9 }, 'main')).toBe(false);
    expect(slotHasAmmo({ main: 1 }, 'main')).toBe(true);
  });

  it('per-unit magazines, so co-op\'s doubled enemy COUNT (#350) scales volume linearly with no shared pool', () => {
    const def = ENEMY_KINDS.wallTurret;
    const a = initKindAmmo(def);
    const b = initKindAmmo(def);
    consumeSlotAmmo(a, DEFAULT_SLOT, 3);
    expect(b[DEFAULT_SLOT]).toBe(initKindAmmo(def)[DEFAULT_SLOT]);   // b untouched by a's fire
    expect(a[DEFAULT_SLOT]).not.toBe(b[DEFAULT_SLOT]);
  });
});

describe('#375 the RELOAD model — same as the player version of the gun', () => {
  it('draining a mag to empty AUTO-starts the slot reload for RELOAD_SECONDS', () => {
    const ammo = { main: 1 };
    const reload = { main: 0 };
    consumeSlotAmmo(ammo, 'main', 1, reload);
    expect(ammo.main).toBe(0);
    expect(reload.main).toBe(RELOAD_SECONDS);
  });

  it('a pull that does NOT empty the mag arms no reload', () => {
    const ammo = { main: 3 };
    const reload = { main: 0 };
    consumeSlotAmmo(ammo, 'main', 1, reload);
    expect(ammo.main).toBe(2);
    expect(reload.main).toBe(0);
  });

  it('NO trickle: a slot that is not reloading holds its ammo exactly where firing left it', () => {
    const def = ENEMY_KINDS.turret;
    const ammo = { [DEFAULT_SLOT]: 4 };
    const reload = { [DEFAULT_SLOT]: 0 };
    tickKindReload(def, ammo, reload, 30);                 // half a minute idle mid-magazine
    expect(ammo[DEFAULT_SLOT]).toBe(4);                    // unchanged — no between-shots regen
  });

  it('a slot mid-reload stays DRY until the timer elapses, then snaps to a FULL magazine', () => {
    const def = ENEMY_KINDS.wallTurret;
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const ammo = { [DEFAULT_SLOT]: 0 };
    const reload = { [DEFAULT_SLOT]: RELOAD_SECONDS };
    tickKindReload(def, ammo, reload, RELOAD_SECONDS - 0.5);
    expect(ammo[DEFAULT_SLOT]).toBe(0);                    // still reloading, still dry
    expect(slotHasAmmo(ammo, DEFAULT_SLOT)).toBe(false);
    tickKindReload(def, ammo, reload, 0.5);               // reload completes this frame
    expect(reload[DEFAULT_SLOT]).toBe(0);
    expect(ammo[DEFAULT_SLOT]).toBe(max);                 // FULL magazine, not a partial trickle
  });

  it('reload does not over-refill — once full and not reloading, ticking is a no-op', () => {
    const def = ENEMY_KINDS.wallTurret;
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const ammo = { [DEFAULT_SLOT]: max };
    const reload = { [DEFAULT_SLOT]: 0 };
    tickKindReload(def, ammo, reload, 10_000);
    expect(ammo[DEFAULT_SLOT]).toBe(max);
  });

  it('fire a whole mag, then a real reload cycle refills it to full', () => {
    const def = ENEMY_KINDS.turret;
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const ammo = initKindAmmo(def);
    const reload = initKindReload(def);
    for (let i = 0; i < max; i++) consumeSlotAmmo(ammo, DEFAULT_SLOT, 1, reload);
    expect(ammo[DEFAULT_SLOT]).toBe(0);                    // magazine spent
    expect(reload[DEFAULT_SLOT]).toBe(RELOAD_SECONDS);     // reload armed by the emptying shot
    // Reload gate held the whole time, then delivered the ENTIRE magazine at once.
    tickKindReload(def, ammo, reload, RELOAD_SECONDS);
    expect(ammo[DEFAULT_SLOT]).toBe(max);
  });
});

describe('#375 emergent behaviour under sustained contact', () => {
  it.each(EMPLACED)('%s empties its opening magazine, reaching zero before it reloads', (id) => {
    const def = ENEMY_KINDS[id];
    const max = initKindAmmo(def)[DEFAULT_SLOT];
    const sim = simulate(id, 120);
    // It really runs the magazine dry (min ammo hits 0) rather than out-regenerating its own gun.
    expect(sim.minAmmo).toBe(0);
    // First `max` shots are the opening magazine, back-to-back at the free cadence.
    expect(sim.shots.length).toBeGreaterThanOrEqual(max);
    const opening = sim.shots.slice(0, max);
    for (let i = 1; i < opening.length; i++) {
      expect(opening[i] - opening[i - 1]).toBeCloseTo(sim.interval / 1000, 1);
    }
  });

  it.each(EMPLACED)('%s keeps firing after the reload — a magazine swap, not a dead gun', (id) => {
    const { shots } = simulate(id, 120);
    const late = shots.filter((t) => t > 60);
    expect(late.length).toBeGreaterThan(0);               // still shooting a full minute in
  });
});
