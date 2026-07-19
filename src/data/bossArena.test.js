// #240 boss-arena layout tests — it's a hand-authored set-piece, so the guarantees worth
// locking in are structural: it's closed, the boss has a clear floor, and the cover is genuinely
// MIXED (some permanent, some destructible) rather than all one or the other.
import { describe, it, expect } from 'vitest';
import { axialKey, distance } from './hexgrid.js';
import {
  bossArenaLayout, BOSS_ARENA_RADIUS, CORE_CLEAR_R, BOSS_HEX, PLAYER_SPAWN_HEX,
} from './bossArena.js';

const at = (k) => { const [q, r] = k.split(',').map(Number); return { q, r }; };

describe('#240 boss arena layout', () => {
  const L = bossArenaLayout();

  it('is a closed pit — the floor is a disc with an impassable rim around it', () => {
    expect(L.floorKeys.has(axialKey(0, 0))).toBe(true);
    expect(L.boundaryKeys.size).toBeGreaterThan(0);
    for (const k of L.boundaryKeys) {
      expect(L.floorKeys.has(k)).toBe(false);
      expect(distance(at(k), BOSS_HEX)).toBe(BOSS_ARENA_RADIUS + 1);
    }
  });

  it('gives the boss a clear firing floor — no cover inside the core disc', () => {
    for (const k of [...L.hardKeys, ...L.softKeys]) {
      expect(distance(at(k), BOSS_HEX)).toBeGreaterThan(CORE_CLEAR_R);
    }
  });

  it('is MIXED cover — real amounts of both permanent and destructible', () => {
    expect(L.hardKeys.size).toBeGreaterThan(4);
    expect(L.softKeys.size).toBeGreaterThan(4);
    // No hex is both.
    for (const k of L.hardKeys) expect(L.softKeys.has(k)).toBe(false);
  });

  it('leaves gaps in both rings, so neither is a solid wall you can hide behind forever', () => {
    // A full ring of radius n has 6n hexes; both cover rings must occupy well under all of it.
    const hardRingSize = 6 * 7;
    const softRingSize = 6 * 10;
    expect(L.hardKeys.size).toBeLessThan(hardRingSize * 0.75);
    expect(L.softKeys.size).toBeLessThan(softRingSize * 0.75);
  });

  it('every cover piece sits on real floor, and the player spawns clear of everything', () => {
    for (const k of [...L.hardKeys, ...L.softKeys]) expect(L.floorKeys.has(k)).toBe(true);
    const spawn = axialKey(PLAYER_SPAWN_HEX.q, PLAYER_SPAWN_HEX.r);
    expect(L.floorKeys.has(spawn)).toBe(true);
    expect(L.hardKeys.has(spawn)).toBe(false);
    expect(L.softKeys.has(spawn)).toBe(false);
  });

  it('is deterministic — the same set-piece every single time', () => {
    const b = bossArenaLayout();
    expect([...b.hardKeys].sort()).toEqual([...L.hardKeys].sort());
    expect([...b.softKeys].sort()).toEqual([...L.softKeys].sort());
  });
});
