import { describe, it, expect } from 'vitest';
import { orderByLock } from './catalogOrder.js';

describe('orderByLock (#78 — locked items sort to the bottom)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('returns the given order untouched when no isLocked predicate is given (identity)', () => {
    expect(orderByLock(ids, null)).toEqual(ids);
    expect(orderByLock(ids, undefined)).toEqual(ids);
    // a fresh array, not the same reference (safe to mutate the caller's list)
    expect(orderByLock(ids, null)).not.toBe(ids);
  });

  it('puts unlocked first (canonical order) then locked at the bottom (canonical order)', () => {
    const locked = new Set(['b', 'd']);
    expect(orderByLock(ids, (id) => locked.has(id))).toEqual(['a', 'c', 'e', 'b', 'd']);
  });

  it('keeps locked items in their canonical relative order among themselves', () => {
    const locked = new Set(['a', 'c', 'e']);
    expect(orderByLock(ids, (id) => locked.has(id))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('is identity when nothing is locked', () => {
    expect(orderByLock(ids, () => false)).toEqual(ids);
  });

  it('promotes a newly-unlocked item back into its canonical slot among the unlocked', () => {
    const locked = new Set(['b', 'd']);
    expect(orderByLock(ids, (id) => locked.has(id))).toEqual(['a', 'c', 'e', 'b', 'd']);
    locked.delete('b');   // unlock 'b' → it snaps back between 'a' and 'c'
    expect(orderByLock(ids, (id) => locked.has(id))).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('handles all-locked and empty lists', () => {
    expect(orderByLock(ids, () => true)).toEqual(ids);
    expect(orderByLock([], () => true)).toEqual([]);
  });
});
