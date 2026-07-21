// #388 — the pure sequential 1–4 player Garage flow. This is the merge gate for phase 4b: the
// join/handoff/deploy-set logic is entirely here, so the tab-row + per-builder-pad wiring on top
// of it in GarageScene is thin enough to verify by playing.
import { describe, it, expect } from 'vitest';
import {
  PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, mechKeyForPlayer, makeGarageSession, playerCount,
  isSoloSession, canJoin, sessionEditingKey, sessionMechKeys, joinPlayer, advanceEditing,
  garageAction, garageActionLabel, garageStatusText, playerTabs, joinerBuild, isUsableBuild,
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

describe('solo (one joined player) is untouched', () => {
  const solo = makeGarageSession();

  it('starts at a count of one', () => {
    expect(playerCount(solo)).toBe(1);
    expect(isSoloSession(solo)).toBe(true);
  });

  it('edits mech1 and deploys mech1 alone', () => {
    expect(sessionEditingKey(solo)).toBe('mech1');
    expect(sessionMechKeys(solo)).toEqual(['mech1']);
  });

  it('has a plain Deploy button with no handoff step', () => {
    expect(garageAction(solo)).toBe('deploy');
    expect(garageActionLabel(solo)).toBe('▶ DEPLOY');
  });

  it('shows no co-op status chrome', () => {
    expect(garageStatusText(solo)).toBe('');
  });

  it('treats a missing/garbage session as solo rather than throwing', () => {
    expect(playerCount(null)).toBe(1);
    expect(isSoloSession(undefined)).toBe(true);
    expect(sessionEditingKey(null)).toBe('mech1');
    expect(sessionMechKeys(undefined)).toEqual(['mech1']);
    expect(garageAction(null)).toBe('deploy');
    expect(garageStatusText(null)).toBe('');
  });
});

describe('joining grows the count 1→2→3→4 and no further', () => {
  it('adds one player per join up to the cap', () => {
    let s = makeGarageSession();
    expect(playerCount(s)).toBe(1);
    s = joinPlayer(s); expect(playerCount(s)).toBe(2);
    s = joinPlayer(s); expect(playerCount(s)).toBe(3);
    s = joinPlayer(s); expect(playerCount(s)).toBe(4);
    // A fifth join is refused — the count is pinned at the cap.
    expect(canJoin(s)).toBe(false);
    s = joinPlayer(s); expect(playerCount(s)).toBe(4);
  });

  it('canJoin flips off exactly at the cap', () => {
    expect(canJoin(makeGarageSession({ count: 1 }))).toBe(true);
    expect(canJoin(makeGarageSession({ count: 3 }))).toBe(true);
    expect(canJoin(makeGarageSession({ count: 4 }))).toBe(false);
  });

  it('leaves editing where it was — joining mid-build does not steal control', () => {
    // Player 1 is building (editing 0); player 2 joins → still player 1's turn.
    const s = joinPlayer(makeGarageSession({ count: 1, editing: 0 }));
    expect(s.editing).toBe(0);
    expect(sessionEditingKey(s)).toBe('mech1');
    expect(garageStatusText(s)).toBe('PLAYER 1 BUILDING');
  });

  it('grows the deploy set with the count', () => {
    expect(sessionMechKeys(makeGarageSession({ count: 1 }))).toEqual(['mech1']);
    expect(sessionMechKeys(makeGarageSession({ count: 2 }))).toEqual(['mech1', 'mech2']);
    expect(sessionMechKeys(makeGarageSession({ count: 3 }))).toEqual(['mech1', 'mech2', 'mech3']);
    expect(sessionMechKeys(makeGarageSession({ count: 4 }))).toEqual(['mech1', 'mech2', 'mech3', 'mech4']);
  });
});

describe('control advances P1→…→last, and the last START deploys', () => {
  it('walks a two-player session: P1 building → P2 building → deploy', () => {
    let s = joinPlayer(makeGarageSession());   // count 2, editing 0
    expect(sessionEditingKey(s)).toBe('mech1');
    expect(garageStatusText(s)).toBe('PLAYER 1 BUILDING');
    expect(garageAction(s)).toBe('handoff');
    expect(garageActionLabel(s)).toBe('▶ P1 READY');

    s = advanceEditing(s);                     // editing 1 — the last player
    expect(sessionEditingKey(s)).toBe('mech2');
    expect(garageStatusText(s)).toBe('PLAYER 2 BUILDING');
    expect(garageAction(s)).toBe('deploy');
    expect(garageActionLabel(s)).toBe('▶ DEPLOY');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2']);
  });

  it('walks a full four-player session end to end', () => {
    let s = makeGarageSession();
    for (let i = 0; i < 3; i++) s = joinPlayer(s);   // four players joined
    expect(playerCount(s)).toBe(4);
    // P1, P2, P3 each hand off (not last); P4 deploys.
    for (let p = 0; p < 3; p++) {
      expect(s.editing).toBe(p);
      expect(garageAction(s)).toBe('handoff');
      expect(garageActionLabel(s)).toBe(`▶ P${p + 1} READY`);
      s = advanceEditing(s);
    }
    expect(s.editing).toBe(3);
    expect(garageAction(s)).toBe('deploy');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2', 'mech3', 'mech4']);
  });

  it('a mid-build join extends the flow — a would-be last player hands off to the newcomer', () => {
    // Two players; player 1 hands off, so player 2 is now the last → their button is DEPLOY.
    let s = advanceEditing(joinPlayer(makeGarageSession()));
    expect(garageAction(s)).toBe('deploy');
    // A third player joins while player 2 is building: player 2 is no longer last.
    s = joinPlayer(s);
    expect(playerCount(s)).toBe(3);
    expect(s.editing).toBe(1);
    expect(garageAction(s)).toBe('handoff');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2', 'mech3']);
  });

  it('advanceEditing clamps at the last player rather than indexing off the end', () => {
    let s = joinPlayer(makeGarageSession());   // count 2
    s = advanceEditing(advanceEditing(advanceEditing(s)));
    expect(s.editing).toBe(1);
    expect(sessionEditingKey(s)).toBe('mech2');
    expect(garageAction(s)).toBe('deploy');
  });

  it('is a no-op in solo — one player can never be handed off to nobody', () => {
    const s = advanceEditing(makeGarageSession());
    expect(playerCount(s)).toBe(1);
    expect(s.editing).toBe(0);
    expect(garageAction(s)).toBe('deploy');
  });

  it('leaves the session object it was given untouched (pure)', () => {
    const s = joinPlayer(makeGarageSession());
    const snapshot = { ...s };
    advanceEditing(s);
    joinPlayer(s);
    expect(s).toEqual(snapshot);
  });
});

describe('the player-tab row model', () => {
  it('solo shows P1 occupied+active plus one trailing ADD tab', () => {
    expect(playerTabs(makeGarageSession())).toEqual([
      { index: 0, occupied: true, active: true },
      { index: 1, occupied: false, active: false },
    ]);
  });

  it('grows an occupied tab per join and moves the active flag with editing', () => {
    const s = advanceEditing(joinPlayer(joinPlayer(makeGarageSession())));  // 3 players, editing 1
    expect(playerTabs(s)).toEqual([
      { index: 0, occupied: true, active: false },
      { index: 1, occupied: true, active: true },
      { index: 2, occupied: true, active: false },
      { index: 3, occupied: false, active: false },  // still room for a 4th
    ]);
  });

  it('drops the ADD tab once every slot is seated', () => {
    const full = makeGarageSession({ count: 4, editing: 0 });
    const tabs = playerTabs(full);
    expect(tabs).toHaveLength(4);
    expect(tabs.every((t) => t.occupied)).toBe(true);
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
