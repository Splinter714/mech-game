// #423 — Plain-text run report. Pure: takes a reduced run (runStats.reduce()) and returns a
// clean, sectioned, column-aligned string Jackson copies out of the stats screen and pastes
// back for tuning discussion. No Phaser, no clipboard — phase 2 owns the Copy button.
//
// #440 readability pass: the original single mega-wide table per section (15 cryptically
// abbreviated columns like eBurst/tSust/ToKind) was hard to read at a glance and hard to paste
// into chat. Each section is now TWO narrower tables with FULLY SPELLED-OUT headers — an
// "at a glance" table (what happened) and a "damage math" table (the DPS/tuning numbers) — so a
// reader doesn't need the header comment to know what a column means.

function fmt(n, dp = 1) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(dp);
}
const pct = (r) => (r == null || !Number.isFinite(r) ? '-' : `${(r * 100).toFixed(0)}%`);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

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

  // "Real" DPS is what the run actually measured; "Max possible" is the stat-sheet number
  // assuming every shot lands — the gap between them (Landing %) is what to look at first when
  // deciding whether a weapon needs a damage nerf/buff or just needs to be EASIER TO HIT WITH.
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
    'WEAPONS — damage-per-second (Real = measured this run, Max = stat-sheet if every shot hit)',
    table(dpsHeader, dpsRows),
  ].join('\n');
}

// #440: a carrier-deployed unit (e.g. a Broodhauler's drones) is stat-tagged with a "Brood"
// suffix on its kind (see enemies.js `_spawnKind`'s statKind param, wired from
// enemyBehaviors.js `deployNearby`) so its damage can be told apart from its dock-spawned twin
// — #439 confirmed they're otherwise the EXACT SAME unit. Rather than show it as an opaque
// extra row, fold it back under its base kind as an indented "of which: brood-spawned" subset
// line, so the base kind's own row still reads as one coherent total.
const BROOD_SUFFIX = 'Brood';
function splitBroodSubsets(enemies) {
  const base = {};
  const brood = {};
  for (const [kind, e] of Object.entries(enemies)) {
    if (kind.endsWith(BROOD_SUFFIX) && kind.length > BROOD_SUFFIX.length) {
      brood[kind.slice(0, -BROOD_SUFFIX.length)] = e;
    } else {
      base[kind] = e;
    }
  }
  // A brood entry whose base kind never showed up on its own (edge case: only ever encountered
  // carrier-deployed units of that kind) still needs a home — show it as its own top-level row.
  for (const [baseKind, e] of Object.entries(brood)) {
    if (!base[baseKind]) { base[baseKind] = e; delete brood[baseKind]; }
  }
  return { base, brood };
}

function displayName(kind) {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function enemiesSection(run) {
  const { base, brood } = splitBroodSubsets(run.enemies ?? {});
  const entries = Object.entries(base);
  if (!entries.length) return 'ENEMIES\n  (none encountered)';

  const encounterHeader = ['Enemy', 'Seen', 'Killed', 'Avg. Time-to-Kill'];
  const encounterRows = [];
  for (const [kind, e] of entries) {
    encounterRows.push([displayName(kind), e.spawned, e.killed, secs(e.avgTtkMs)]);
    const b = brood[kind];
    if (b) {
      encounterRows.push([
        `  └ of which brood-spawned`, b.spawned, b.killed, secs(b.avgTtkMs),
      ]);
    }
  }

  const threatHeader = [
    'Enemy', 'Effective HP', 'Their Accuracy', 'Their DPS',
    'Damage to You', 'Threat Share', 'Your Damage to Them', 'Your Overkill',
  ];
  const threatRows = [];
  for (const [kind, e] of entries) {
    threatRows.push([
      displayName(kind), fmt(e.effectiveHp), pct(e.weaponAccuracy), fmt(e.effectiveDps),
      fmt(e.damageToYou), pct(e.threatShare), fmt(e.damageToKind), fmt(e.overkill),
    ]);
    const b = brood[kind];
    if (b) {
      threatRows.push([
        `  └ of which brood-spawned`, fmt(b.effectiveHp), pct(b.weaponAccuracy), fmt(b.effectiveDps),
        fmt(b.damageToYou), pct(b.threatShare), fmt(b.damageToKind), fmt(b.overkill),
      ]);
    }
  }

  return [
    'ENEMIES — encounters',
    table(encounterHeader, encounterRows),
    '',
    'ENEMIES — how much they hurt you vs. how much you hurt them',
    table(threatHeader, threatRows),
  ].join('\n');
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
