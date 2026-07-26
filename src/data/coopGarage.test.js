// Shared co-op Garage primitives (#505: the sequential `{count, editing}` session model this
// module used to hold was removed — GarageScene now runs entirely on data/simulGarage.js's
// `{count, ready}` session, see simulGarage.test.js). What's left and tested here is the shared
// ground both the garage and the arena's mid-sortie join build on: the four persistent build
// slots, the join cap, and the mid-sortie joiner's own build-pick rule.
import { describe, it, expect } from 'vitest';
import {
  PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, mechKeyForPlayer, playerCount, canJoin,
  joinerBuild, isUsableBuild,
} from './coopGarage.js';
import { ROSTERS, ACTIVE_MECH_KEY, PLAYER2_MECH_KEY } from './rosters.js';
import { MAX_PLAYERS } from './players.js';
import { Mech } from './Mech.js';

describe('the four persistent build slots', () => {
  it('is exactly four, and the garage cap matches the arena cap', () => {
    expect(PLAYER_MECH_KEYS).toEqual(['mech1', 'mech2', 'mech3', 'mech4']);
    expect(MAX_GARAGE_PLAYERS).toBe(4);
    expect(MAX_GARAGE_PLAYERS).toBe(MAX_PLAYERS);
  });

  it('keeps player 1 on the key single-player has always used', () => {
    expect(mechKeyForPlayer(0)).toBe(ACTIVE_MECH_KEY);
    expect(mechKeyForPlayer(1)).toBe(PLAYER2_MECH_KEY);
  });

  it('maps players 3 & 4 to their own slots', () => {
    expect(mechKeyForPlayer(2)).toBe('mech3');
    expect(mechKeyForPlayer(3)).toBe('mech4');
  });

  it('clamps a stray extra player onto the last real slot rather than returning undefined', () => {
    expect(mechKeyForPlayer(4)).toBe('mech4');
    expect(mechKeyForPlayer(-1)).toBe('mech1');
    expect(mechKeyForPlayer(undefined)).toBe('mech1');
  });

  it('every slot exists in the roster defaults and is a COMPLETE build', () => {
    const defaults = ROSTERS.mech.defaultRoster();
    for (const key of PLAYER_MECH_KEYS) {
      expect(defaults[key], `missing default build for ${key}`).toBeTruthy();
      expect(new Mech(defaults[key]).isComplete()).toBe(true);
    }
  });

  it("gives player 2 its own build, not a copy of player 1's", () => {
    const defaults = ROSTERS.mech.defaultRoster();
    expect(defaults[PLAYER2_MECH_KEY].mounts).not.toEqual(defaults[ACTIVE_MECH_KEY].mounts);
    expect(defaults[PLAYER2_MECH_KEY].name).not.toBe(defaults[ACTIVE_MECH_KEY].name);
  });
});

describe('playerCount / canJoin', () => {
  it('reads a raw/garbage session as solo', () => {
    expect(playerCount(null)).toBe(1);
    expect(playerCount(undefined)).toBe(1);
  });

  it('reads any session shape with a count field (sequential or simultaneous)', () => {
    expect(playerCount({ count: 3 })).toBe(3);
    expect(playerCount({ count: 2, ready: [true, false] })).toBe(2);
  });

  it('clamps into [1, MAX_GARAGE_PLAYERS]', () => {
    expect(playerCount({ count: 0 })).toBe(1);
    expect(playerCount({ count: 99 })).toBe(MAX_GARAGE_PLAYERS);
  });

  it('canJoin flips off exactly at the cap', () => {
    expect(canJoin({ count: 1 })).toBe(true);
    expect(canJoin({ count: 3 })).toBe(true);
    expect(canJoin({ count: 4 })).toBe(false);
  });
});

describe('the mid-sortie joiner picks its mech (#349 keeps both join paths)', () => {
  const host = { chassisId: 'mediumPlayer', name: 'Trooper-01', mounts: { rightArm: ['autocannon'] } };

  it("takes the joiner's OWN saved build when it is complete", () => {
    const saved = { chassisId: 'mediumPlayer', name: 'Trooper-02', mounts: { leftArm: ['pulseLaser'] }, isComplete: () => true };
    expect(joinerBuild(saved, host)).toEqual({
      chassisId: 'mediumPlayer', name: 'Trooper-02', mounts: { leftArm: ['pulseLaser'] },
    });
  });

  it("falls back to phase 2's copy-of-player-1 when the slot is half-built", () => {
    const saved = { chassisId: 'mediumPlayer', name: 'Trooper-02', mounts: {}, isComplete: () => false };
    expect(joinerBuild(saved, host)).toEqual(host);
  });

  it('falls back when there is no saved slot at all', () => {
    expect(joinerBuild(null, host)).toEqual(host);
    expect(joinerBuild(undefined, host)).toEqual(host);
    expect(joinerBuild({}, host)).toEqual(host);
  });

  it('takes a raw build object with no isComplete at face value', () => {
    expect(isUsableBuild({ chassisId: 'mediumPlayer' })).toBe(true);
    expect(isUsableBuild({ name: 'no chassis' })).toBe(false);
    expect(isUsableBuild(null)).toBe(false);
  });

  it("means the shipped mech2 default is what a late joiner actually drives", () => {
    const saved = new Mech(ROSTERS.mech.defaultRoster()[PLAYER2_MECH_KEY]);
    const build = joinerBuild(saved, host);
    expect(build.name).toBe('Trooper-02');
    expect(new Mech(build).isComplete()).toBe(true);
  });
});
