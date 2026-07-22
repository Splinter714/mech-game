// #423 — Plain-text run report. Pure: takes a reduced run (runStats.reduce()) and returns a
// clean, sectioned, column-aligned string Jackson copies out of the stats screen and pastes
// back for tuning discussion. No Phaser, no clipboard — phase 2 owns the Copy button.

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
  const lines = ['GLOBAL'];
  if (agg) {
    lines.push(`  Runs:       ${run.runCount} pooled`);
  } else {
    lines.push(
      `  Biome:      ${m.biome ?? '-'}`,
      `  Chassis:    ${m.chassis ?? '-'}`,
      `  Loadout:    ${(m.loadout && m.loadout.length) ? m.loadout.join(', ') : '-'}`,
    );
  }
  lines.push(
    `  Duration:   ${secs(run.durationMs)}   (combat ${secs(run.combatTimeMs)})`,
    `  Damage:     dealt ${fmt(run.totalDealt)}   taken ${fmt(run.totalTaken)}`,
    `  Accuracy:   ${pct(run.accuracy)}   (${run.hits}/${run.shotsFired} pulls)`,
    `  Deaths:     ${run.deaths}   Respawns: ${run.respawns}`,
  );
  const pu = Object.entries(run.powerups ?? {});
  lines.push(`  Powerups:   ${pu.length ? pu.map(([k, v]) => `${k} x${v}`).join(', ') : 'none'}`);
  return lines.join('\n');
}

function weaponsSection(run) {
  const rows = Object.values(run.weapons ?? {}).map((w) => [
    w.name,
    w.shotsFired, w.hits, pct(w.accuracy),
    fmt(w.damageDealt), fmt(w.overkill),
    secs(w.firingTimeMs), w.reloads, secs(w.reloadTimeMs),
    fmt(w.effectiveBurstDps), fmt(w.effectiveSustainedDps), fmt(w.effectiveCombatDps),
    fmt(w.theoreticalBurstDps), fmt(w.theoreticalSustainedDps),
    pct(w.landingRatio),
  ]);
  const header = [
    'Weapon', 'Shots', 'Hits', 'Acc', 'Dmg', 'Over',
    'Fire', 'Rel', 'RelT',
    'eBurst', 'eSust', 'eCombat', 'tBurst', 'tSust', 'Land',
  ];
  return `WEAPONS\n${rows.length ? table(header, rows) : '  (none fired)'}`;
}

function enemiesSection(run) {
  const rows = Object.values(run.enemies ?? {}).map((e) => [
    e.kind,
    e.spawned, e.killed, secs(e.avgTtkMs),
    fmt(e.effectiveHp), pct(e.weaponAccuracy), fmt(e.effectiveDps),
    fmt(e.damageToYou), pct(e.threatShare),
    fmt(e.damageToKind), fmt(e.overkill),
  ]);
  const header = [
    'Enemy', 'Seen', 'Kills', 'TTK',
    'effHP', 'Acc', 'DPS',
    'ToYou', 'Threat', 'ToKind', 'Over',
  ];
  return `ENEMIES\n${rows.length ? table(header, rows) : '  (none encountered)'}`;
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
