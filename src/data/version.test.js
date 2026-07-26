// #523: the pause menu's version-number readout. `formatBuildTime` is the pure, directly
// testable half (plain strings in, no Vite `define`/env plumbing).
import { describe, it, expect } from 'vitest';
import { formatBuildTime } from './version.js';

describe('formatBuildTime', () => {
  it('formats a real ISO build timestamp as "YYYY-MM-DD HH:MM UTC"', () => {
    expect(formatBuildTime('2026-07-25T18:51:00.000Z')).toBe('2026-07-25 18:51 UTC');
  });

  it('formats a timestamp with no milliseconds the same way', () => {
    expect(formatBuildTime('2026-01-02T03:04:05Z')).toBe('2026-01-02 03:04 UTC');
  });

  it('falls back to a plain dev-build label for the "dev" sentinel', () => {
    expect(formatBuildTime('dev')).toBe('DEV BUILD');
  });

  it('falls back to a plain dev-build label for a non-ISO string', () => {
    expect(formatBuildTime('not-a-timestamp')).toBe('DEV BUILD');
  });

  it('never throws on a non-string input', () => {
    expect(() => formatBuildTime(undefined)).not.toThrow();
    expect(formatBuildTime(undefined)).toBe('DEV BUILD');
    expect(formatBuildTime(null)).toBe('DEV BUILD');
    expect(formatBuildTime(12345)).toBe('DEV BUILD');
  });
});
