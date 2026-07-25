import { describe, it, expect } from 'vitest';
import { nearestInterceptTarget } from './interceptor.js';

describe('nearestInterceptTarget', () => {
  it('picks the nearest candidate within range', () => {
    const candidates = [{ id: 'far', x: 100, y: 0 }, { id: 'near', x: 20, y: 0 }];
    expect(nearestInterceptTarget(0, 0, 150, candidates).id).toBe('near');
  });

  it('ignores candidates outside range', () => {
    const candidates = [{ x: 500, y: 0 }];
    expect(nearestInterceptTarget(0, 0, 150, candidates)).toBe(null);
  });

  it('returns null with no candidates at all', () => {
    expect(nearestInterceptTarget(0, 0, 150, [])).toBe(null);
  });
});
