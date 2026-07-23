// #440 — pure, Phaser-free metadata about an enemy STAT KIND (the key the run-stats enemy buckets
// use — the enemy kind id), for the Garage stats ENEMIES table. Two things the reduced run data
// can't tell you on its own, both read straight from the game's DATA tables:
//
//   1. enemyWeaponInfo(statKind) — does this kind fire a TUNED VARIANT of the player's base weapon
//      (a #243 `weaponOverride`, or a per-slot override in the #305 `weapons:{}` map)? Many enemies
//      mount a weakened/retuned version and that is invisible in the readout. Returns the weapon(s),
//      whether each carries a real override, and a human-readable field-by-field diff (base → enemy).
//
//   2. enemyRealHp(statKind) — the kind's DESIGNED total durability from its data (not the MEASURED
//      damage-to-kill the run recorded). For a non-mech HpBody kind that's structure + armor + shield
//      pool; for a MECH kind it's the summed armor+structure across every body location, plus its
//      shield pool. Jackson compares this against the measured "Eff HP" to see mitigation/overkill waste.
//
// Both map the carrier-brood stat kind (`droneBrood`) back onto the `drone` kind — a brood-spawned
// drone is the same unit as a dock-spawned one (#439), so it fires the same weapon and has the same HP.

import { WEAPONS } from './weapons.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { ENEMIES } from './enemies.js';
import { kindWeaponSlots } from './kindWeapons.js';
import { getChassis } from './chassis/index.js';
import { BROOD_SUFFIX } from './runStatsEnemies.js';

// Map a stat kind to the underlying game kind: strip the carrier-brood suffix so `droneBrood`
// resolves to the real `drone` kind (same unit, #439).
export function baseKind(statKind) {
  if (statKind && statKind.endsWith(BROOD_SUFFIX) && statKind.length > BROOD_SUFFIX.length) {
    return statKind.slice(0, -BROOD_SUFFIX.length);
  }
  return statKind;
}

// ── Weapon overrides ─────────────────────────────────────────────────────────────────────────

function fmtVal(v) {
  if (v == null) return 'none';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }
  return String(v);
}

// Walk the OVERRIDE object's keys (recursing into nested objects like `delivery`/`range`/
// `groundFire`), comparing each leaf against the base weapon. Only fields the override actually
// CHANGES are emitted, as `path: base → enemy` strings — a field overridden to the base's own value
// (e.g. the gunship flank restating Repeater's count: 2) is a no-op and is deliberately not shown.
function diffOverride(base, override, prefix, out) {
  for (const [k, ov] of Object.entries(override ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    const bv = base == null ? undefined : base[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov)) {
      diffOverride(bv, ov, path, out);
    } else if (bv !== ov) {
      out.push(`${path}: ${fmtVal(bv)} → ${fmtVal(ov)}`);
    }
  }
}

function slotInfo(slotName, weaponId, override, isMulti) {
  const base = WEAPONS[weaponId];
  const diffs = [];
  diffOverride(base, override, '', diffs);
  return {
    slot: isMulti ? slotName : null,
    weaponId,
    weaponName: base?.name ?? weaponId,
    hasOverride: diffs.length > 0,
    diffs,
  };
}

// For a given enemy stat kind, return { kind, hasOverride, weapons:[{slot,weaponId,weaponName,
// hasOverride,diffs}] }. Handles single top-level weaponId+weaponOverride kinds, the multi-slot
// `weapons:{}` map, mech-loadout kinds (base weapons, no overrides), and unknown kinds (empty).
export function enemyWeaponInfo(statKind) {
  const kind = baseKind(statKind);
  const weapons = [];
  const kdef = ENEMY_KINDS[kind];
  if (kdef) {
    const isMulti = !!kdef.weapons;
    for (const [slotName, spec] of Object.entries(kindWeaponSlots(kdef))) {
      weapons.push(slotInfo(slotName, spec.weaponId, spec.weaponOverride, isMulti));
    }
  } else {
    const mdef = ENEMIES[kind];
    if (mdef?.mounts) {
      for (const ids of Object.values(mdef.mounts)) {
        for (const wid of ids ?? []) weapons.push(slotInfo(null, wid, null, false));
      }
    }
  }
  return { kind, hasOverride: weapons.some((w) => w.hasOverride), weapons };
}

// Human-readable one-line summary of a kind's overrides, for the ENEMIES-table hover tooltip.
// Single-weapon kind:  "Repeater (enemy variant) — delivery.fireRate: 18 → 1.43"
// Multi-slot kind:      "flank: Repeater — delivery.count: 2 → 1"  (only overriding slots listed)
// No override:          '' (caller shows nothing / the normal tooltip).
// Accepts either a stat-kind string or a pre-computed enemyWeaponInfo object.
export function enemyOverrideSummary(statKind) {
  const info = statKind && typeof statKind === 'object' ? statKind : enemyWeaponInfo(statKind);
  if (!info?.hasOverride) return '';
  const parts = [];
  for (const w of info.weapons) {
    if (!w.hasOverride) continue;
    const label = w.slot ? `${w.slot}: ${w.weaponName}` : `${w.weaponName} (enemy variant)`;
    parts.push(`${label} — ${w.diffs.join(', ')}`);
  }
  return parts.join(';  ');
}

// #440: display label for a per-weapon threat sub-row under an enemy kind. Returns the weapon's
// display NAME and whether THIS kind mounts a TUNED VARIANT of it (any slot carrying that base
// weaponId has an override), so the sub-row can wear the same `*` enemy-variant marker the parent
// row uses. Accepts a stat-kind string or a pre-computed enemyWeaponInfo object.
export function enemyWeaponLabel(statKind, weaponId) {
  const info = statKind && typeof statKind === 'object' ? statKind : enemyWeaponInfo(statKind);
  const matches = (info?.weapons ?? []).filter((w) => w.weaponId === weaponId);
  const name = matches[0]?.weaponName ?? WEAPONS[weaponId]?.name ?? weaponId;
  const hasOverride = matches.some((w) => w.hasOverride);
  return { name, hasOverride };
}

// ── Designed durability (Real HP) ────────────────────────────────────────────────────────────

// Total DESIGNED durability of an enemy kind, from its data tables — the counterpart to the run's
// MEASURED "Eff HP" (average damage-to-kill). Non-mech HpBody kinds: structure (`hp`) + `armor` +
// shield pool. Mech kinds: summed armor+structure across every body location (the chassis' whole
// durability) + shield pool. Returns null for an unknown kind.
export function enemyRealHp(statKind) {
  const kind = baseKind(statKind);
  const kdef = ENEMY_KINDS[kind];
  if (kdef) {
    const structure = Number(kdef.hp) || 0;
    const armor = Number(kdef.armor) || 0;
    const shield = Number(kdef.shield?.max) || 0;
    return structure + armor + shield;
  }
  const mdef = ENEMIES[kind];
  if (mdef) {
    const chassis = getChassis(mdef.chassisId);
    let total = 0;
    for (const loc of Object.values(chassis.locations ?? {})) {
      total += (Number(loc.maxArmor) || 0) + (Number(loc.maxHp) || 0);
    }
    total += Number(mdef.shield?.max) || 0;
    return total;
  }
  return null;
}
