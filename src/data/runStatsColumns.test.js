// #440 — column descriptors + sort comparator for the interactive stats tables.
import { describe, it, expect } from 'vitest';
import {
  WEAPON_COLUMNS, ENEMY_COLUMNS, compareRows, defaultDir,
} from './runStatsColumns.js';

describe('runStatsColumns (#440)', () => {
  it('every column has a key, label, fmt, and a one-line definition', () => {
    for (const col of [...WEAPON_COLUMNS, ...ENEMY_COLUMNS]) {
      expect(col.key).toBeTruthy();
      expect(col.label).toBeTruthy();
      expect(['str', 'int', 'num', 'pct', 'secs']).toContain(col.fmt);
      expect(typeof col.def).toBe('string');
      expect(col.def.length).toBeGreaterThan(10);
    }
  });

  it('column keys are unique within each table', () => {
    const wKeys = WEAPON_COLUMNS.map((c) => c.key);
    const eKeys = ENEMY_COLUMNS.map((c) => c.key);
    expect(new Set(wKeys).size).toBe(wKeys.length);
    expect(new Set(eKeys).size).toBe(eKeys.length);
  });

  it('each table leads with exactly one string (name) column', () => {
    expect(WEAPON_COLUMNS[0].fmt).toBe('str');
    expect(ENEMY_COLUMNS[0].fmt).toBe('str');
    expect(WEAPON_COLUMNS.filter((c) => c.fmt === 'str')).toHaveLength(1);
    expect(ENEMY_COLUMNS.filter((c) => c.fmt === 'str')).toHaveLength(1);
  });

  it('numeric columns sort numerically, ascending and descending', () => {
    const col = { key: 'damageDealt', fmt: 'num' };
    const rows = [{ damageDealt: 10 }, { damageDealt: 3 }, { damageDealt: 100 }];
    const asc = [...rows].sort((a, b) => compareRows(a, b, col, 1)).map((r) => r.damageDealt);
    const desc = [...rows].sort((a, b) => compareRows(a, b, col, -1)).map((r) => r.damageDealt);
    expect(asc).toEqual([3, 10, 100]);
    expect(desc).toEqual([100, 10, 3]);
  });

  it('numeric sort is not lexicographic (100 > 20)', () => {
    const col = { key: 'x', fmt: 'int' };
    expect(compareRows({ x: 100 }, { x: 20 }, col, 1)).toBeGreaterThan(0);
  });

  it('the name column sorts alphabetically', () => {
    const col = { key: 'name', fmt: 'str' };
    const rows = [{ name: 'Shotgun' }, { name: 'Autocannon' }, { name: 'Laser' }];
    const asc = [...rows].sort((a, b) => compareRows(a, b, col, 1)).map((r) => r.name);
    expect(asc).toEqual(['Autocannon', 'Laser', 'Shotgun']);
  });

  it('non-finite / missing numeric values sink to the bottom in BOTH sort directions', () => {
    const col = { key: 'v', fmt: 'num' };
    // A real value always ranks ABOVE (before) a missing/NaN one, ascending or descending.
    expect(compareRows({ v: 5 }, {}, col, 1)).toBeLessThan(0);
    expect(compareRows({ v: 5 }, {}, col, -1)).toBeLessThan(0);
    expect(compareRows({ v: NaN }, { v: 5 }, col, 1)).toBeGreaterThan(0);
    expect(compareRows({ v: NaN }, { v: 5 }, col, -1)).toBeGreaterThan(0);
    // Two missing values tie.
    expect(compareRows({}, { v: NaN }, col, 1)).toBe(0);
  });

  it('defaultDir: names asc, numbers desc', () => {
    expect(defaultDir({ fmt: 'str' })).toBe(1);
    expect(defaultDir({ fmt: 'num' })).toBe(-1);
    expect(defaultDir({ fmt: 'pct' })).toBe(-1);
  });

  it('a null column is a no-op comparator', () => {
    expect(compareRows({ a: 1 }, { a: 2 }, null, 1)).toBe(0);
  });
});
