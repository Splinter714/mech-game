// #423 — Plain-text run report. Pure: takes a reduced run (runStats.reduce()) and returns a
// clean, sectioned, column-aligned string Jackson copies out of the stats screen and pastes
// back for tuning discussion. No Phaser, no clipboard — phase 2 owns the Copy button.
//
// #440 readability pass: the original single mega-wide table per section (15 cryptically
// abbreviated columns like eBurst/tSust/ToKind) was hard to read at a glance and hard to paste
// into chat. Each section is now TWO narrower tables with FULLY SPELLED-OUT headers — an
// "at a glance" table (what happened) and a "damage math" table (the DPS/tuning numbers) — so a
// reader doesn't need the header comment to know what a column means.

import { splitBroodSubsets, displayName } from './runStatsEnemies.js';
import { enemyWeaponInfo, enemyRealHp, enemyWeaponLabel } from './enemyStatsMeta.js';

function fmt(n, dp = 1) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(dp);
}
const pct = (r) => (r == null || !Number.isFinite(r) ? '-' : `${(r * 100).toFixed(0)}%`);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// #440: indented label for a spawner sub-row, e.g. `  └ spawned drones`. Mirrors the brood
// subset's `  └ …` indentation; lower-cased + pluralised kind name reads as a plain-English line.
function spawnedRowLabel(child) {
  return `  └ spawned ${displayName(child.spawnedKind ?? child.kind).toLowerCase()}s`;
}

// Render a table: header row + body rows, each an array of cells. Columns are left-padded to
// the widest cell (first column left-aligned, the rest right-aligned like a stat sheet).
function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => String(r[c] ?? '').length)));
  const line = (r) => r
    .map((cell, c) => {
      const s = String(cell ?? '');
      return c === 0 ? s.padEnd(widths[c]) : s.padStart(widths[c]);
    })
    .join('  ')
    .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function globalSection(run) {
  const m = run.meta ?? {};
  const agg = run.runCount != null;   // #432: the pooled ALL-RUNS view
  const lines = ['SUMMARY'];
  if (agg) {
    lines.push(`  Runs pooled:       ${run.runCount}`);
  } else {
    lines.push(
      `  Biome:             ${m.biome ?? '-'}`,
      `  Chassis:           ${m.chassis ?? '-'}`,
      `  Loadout:           ${(m.loadout && m.loadout.length) ? m.loadout.join(', ') : '-'}`,
    );
  }
  lines.push(
    `  Duration:          ${secs(run.durationMs)}  (in combat ${secs(run.combatTimeMs)})`,
    `  Damage dealt:      ${fmt(run.totalDealt)}`,
    `  Damage taken:      ${fmt(run.totalTaken)}`,
    `  Accuracy:          ${pct(run.accuracy)}  (${run.hits} hits / ${run.shotsFired} shots fired)`,
    `  Deaths:            ${run.deaths}  (Respawns: ${run.respawns})`,
  );
  const pu = Object.entries(run.powerups ?? {});
  lines.push(`  Powerups picked up: ${pu.length ? pu.map(([k, v]) => `${k} x${v}`).join(', ') : 'none'}`);
  return lines.join('\n');
}

function weaponsSection(run) {
  const weapons = Object.values(run.weapons ?? {});
  if (!weapons.length) return 'WEAPONS\n  (none fired)';

  const outputHeader = ['Weapon', 'Shots Fired', 'Hits', 'Accuracy', 'Damage Dealt', 'Overkill'];
  const outputRows = weapons.map((w) => [
    w.name, w.shotsFired, w.hits, pct(w.accuracy), fmt(w.damageDealt), fmt(w.overkill),
  ]);

  // "Real" DPS is USEFUL damage (total minus overkill) actually measured this run; "Max possible"
  // is the stat-sheet number assuming every shot lands — the gap between them (Landing %) is what
  // to look at first when deciding whether a weapon needs a damage nerf/buff, is wasting damage
  // to overkill, or just needs to be EASIER TO HIT WITH.
  const dpsHeader = [
    'Weapon', 'Time Firing', 'Reloads', 'Time Reloading',
    'Real DPS (Burst)', 'Real DPS (Sustained)', 'Real DPS (In Combat)',
    'Max DPS (Burst)', 'Max DPS (Sustained)', 'Landing %',
  ];
  const dpsRows = weapons.map((w) => [
    w.name, secs(w.firingTimeMs), w.reloads, secs(w.reloadTimeMs),
    fmt(w.effectiveBurstDps), fmt(w.effectiveSustainedDps), fmt(w.effectiveCombatDps),
    fmt(w.theoreticalBurstDps), fmt(w.theoreticalSustainedDps), pct(w.landingRatio),
  ]);

  return [
    'WEAPONS — what happened',
    table(outputHeader, outputRows),
    '',
    'WEAPONS — damage-per-second (Real = useful damage this run [total minus overkill], Max = stat-sheet if every shot hit)',
    table(dpsHeader, dpsRows),
  ].join('\n');
}

// #440: brood/base pooling now lives in runStatsEnemies.js (shared with the interactive overlay).
// splitBroodSubsets returns the POOLED parent as base[kind] and the brood-only SUBSET as
// brood[kind]; see that module for the accounting-bug fix.

function enemiesSection(run) {
  const { base, brood } = splitBroodSubsets(run.enemies ?? {});
  const entries = Object.entries(base);
  if (!entries.length) return 'ENEMIES\n  (none encountered)';

  // #440: an enemy kind that fires a TUNED VARIANT of the player's base weapon (a weaponOverride)
  // gets a `*` on its name; a legend line below flags what that means. The `*` also lands on the
  // brood subset line, since it's the same kind.
  let anyOverride = false;
  const nameOf = (kind) => {
    const marked = enemyWeaponInfo(kind).hasOverride;
    if (marked) anyOverride = true;
    return displayName(kind) + (marked ? ' *' : '');
  };

  const encounterHeader = ['Enemy', 'Seen', 'Killed', 'Avg. Time-to-Kill'];
  const encounterRows = [];
  for (const [kind, e] of entries) {
    encounterRows.push([nameOf(kind), e.spawned, e.killed, secs(e.avgTtkMs)]);
    const b = brood[kind];
    if (b) {
      encounterRows.push([
        `  └ of which brood-spawned`, b.spawned, b.killed, secs(b.avgTtkMs),
      ]);
    }
    // #440: spawner sub-rows — the units this kind spawned, attributed to it (info, not a total).
    for (const c of e.spawnedChildren ?? []) {
      encounterRows.push([spawnedRowLabel(c), c.spawned, c.killed, secs(c.avgTtkMs)]);
    }
  }

  const threatHeader = [
    'Enemy', 'Effective HP', 'Real HP', 'Their Accuracy', 'Their DPS',
    'Damage to You', 'Threat Share', 'Threat/unit', 'Spawned Dmg', 'Your Damage to Them', 'Your Overkill',
  ];
  const threatRows = [];
  for (const [kind, e] of entries) {
    const realHp = enemyRealHp(kind);
    threatRows.push([
      nameOf(kind), fmt(e.effectiveHp), fmt(realHp), pct(e.weaponAccuracy), fmt(e.effectiveDps),
      fmt(e.damageToYou), pct(e.threatShare), pct(e.threatPerUnit), fmt(e.spawnedDamage), fmt(e.damageToKind), fmt(e.overkill),
    ]);
    const b = brood[kind];
    if (b) {
      threatRows.push([
        `  └ of which brood-spawned`, fmt(b.effectiveHp), fmt(realHp), pct(b.weaponAccuracy),
        fmt(b.effectiveDps),
        fmt(b.damageToYou), pct(b.threatShare), pct(b.threatPerUnit), fmt(b.spawnedDamage), fmt(b.damageToKind), fmt(b.overkill),
      ]);
    }
    // #440: spawner sub-rows — attributed threat of the units this kind spawned (info, not a total).
    for (const c of e.spawnedChildren ?? []) {
      const cRealHp = enemyRealHp(c.spawnedKind);
      threatRows.push([
        spawnedRowLabel(c), fmt(c.effectiveHp), fmt(cRealHp), pct(c.weaponAccuracy),
        fmt(c.effectiveDps),
        fmt(c.damageToYou), pct(c.threatShare), pct(c.threatPerUnit), fmt(c.spawnedDamage), fmt(c.damageToKind), fmt(c.overkill),
      ]);
    }
    // #440: per-weapon threat sub-rows — which of this kind's weapons hurt you most (only when it
    // used 2+). Only the damage/threat columns apply; the rest are blank.
    for (const w of e.weaponSubs ?? []) {
      const wl = enemyWeaponLabel(kind, w.weaponId);
      if (wl.hasOverride) anyOverride = true;
      threatRows.push([
        `  └ ${wl.name}${wl.hasOverride ? ' *' : ''}`, '-', '-', '-', '-',
        fmt(w.damageToYou), pct(w.threatShare), pct(w.threatPerUnit), '-', '-', '-',
      ]);
    }
  }

  const out = [
    'ENEMIES — encounters',
    table(encounterHeader, encounterRows),
    '',
    'ENEMIES — how much they hurt you vs. how much you hurt them',
    table(threatHeader, threatRows),
  ];
  if (anyOverride) {
    out.push('', '  * enemy fires a tuned variant of the weapon (see in-game tooltip for the override)');
  }
  return out.join('\n');
}

export function runReportText(run) {
  if (!run) return '';
  // #432: the pooled ALL-RUNS view carries `runCount` and gets its own header.
  const header = run.runCount != null
    ? `=== ALL RUNS (${run.runCount}) ===`
    : '=== RUN REPORT ===';
  return [
    header,
    globalSection(run),
    weaponsSection(run),
    enemiesSection(run),
  ].join('\n\n') + '\n';
}

// #432: alias for the pooled aggregate — same renderer, kept as a named entry point so callers
// reading intent (the overlay's Copy on ALL RUNS) don't have to know it shares runReportText.
export const aggregateReportText = runReportText;

// #440: the interactive overlay renders the WEAPONS/ENEMIES tables itself but reuses this exact
// SUMMARY block (single source of truth for the header stats). Returns the same lines the Copy
// export shows, sans the section title's own "SUMMARY" label handling done by the caller.
export function runSummaryText(run) {
  return run ? globalSection(run) : '';
}

// #440: the overlay builds its interactive enemy rows from the SAME pooled parents/subsets the
// text export uses. Re-exported so the overlay has one import surface for the stats text layer.
export { splitBroodSubsets, displayName };
