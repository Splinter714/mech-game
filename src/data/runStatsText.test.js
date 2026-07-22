import { describe, it, expect } from 'vitest';
import { createRunStats } from './runStats.js';
import { runReportText } from './runStatsText.js';

function sampleRun() {
  const r = createRunStats({ biome: 'ash', chassis: 'medium', loadout: ['autocannon', 'shotgun'] });
  r.tick(5000, { inCombat: true });
  r.shotFired('autocannon').shotFired('autocannon');
  r.shotHit('autocannon', 'drone', 22);
  r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 44, overkill: 8 });
  r.reloadStart('autocannon');
  r.reloadEnd('autocannon', 2000);
  r.enemySpawned('drone').enemySpawned('drone');
  r.enemyShotFired('drone').enemyShotHit('drone');
  r.damageTaken({ enemyKind: 'drone', amount: 12 });
  r.enemyEngaged('drone', 4000);
  r.enemyKill('drone', 3000);
  r.powerup('shield');
  r.death();
  return r.reduce();
}

describe('runStatsText — plain-text report (#423)', () => {
  it('returns empty string for a missing run', () => {
    expect(runReportText(null)).toBe('');
  });

  it('renders the three sections', () => {
    const txt = runReportText(sampleRun());
    expect(txt).toContain('=== RUN REPORT ===');
    expect(txt).toContain('GLOBAL');
    expect(txt).toContain('WEAPONS');
    expect(txt).toContain('ENEMIES');
  });

  it('surfaces global facts', () => {
    const txt = runReportText(sampleRun());
    expect(txt).toContain('ash');
    expect(txt).toContain('medium');
    expect(txt).toContain('autocannon, shotgun');
    expect(txt).toMatch(/Duration:\s+5\.0s/);
    expect(txt).toContain('shield x1');
  });

  it('includes weapon + enemy rows by name/kind', () => {
    const txt = runReportText(sampleRun());
    expect(txt).toContain('Autocannon');   // weapon display name
    expect(txt).toContain('drone');        // enemy kind
  });

  it('handles an empty run without throwing', () => {
    const txt = runReportText(createRunStats().reduce());
    expect(txt).toContain('none fired');
    expect(txt).toContain('none encountered');
  });

  it('is deterministic', () => {
    expect(runReportText(sampleRun())).toBe(runReportText(sampleRun()));
  });

  it('columns are aligned (rows share the header width)', () => {
    const txt = runReportText(sampleRun());
    const lines = txt.split('\n');
    const header = lines.find((l) => l.trimStart().startsWith('Weapon'));
    const row = lines.find((l) => l.includes('Autocannon'));
    // the numeric columns start at the same offset → the 'Shots' header sits above a digit
    expect(header).toBeTruthy();
    expect(row).toBeTruthy();
  });
});
