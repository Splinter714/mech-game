// #349 — the pure sequential two-player Garage flow. This is the merge gate for phase 3: the
// slot/handoff logic is entirely here, so the scene wiring on top of it is thin enough to
// verify by playing.
import { describe, it, expect } from 'vitest';
import {
  PLAYER_MECH_KEYS, mechKeyForPlayer, makeGarageSession, sessionMechKey, sessionMechKeys,
  garageAction, garageActionLabel, coopToggleLabel, garageStatusText, beginCoop, endCoop,
  handOff, toggleCoop, joinerBuild, isUsableBuild,
} from './coopGarage.js';
import { ROSTERS, ACTIVE_MECH_KEY, PLAYER2_MECH_KEY } from './rosters.js';
import { Mech } from './Mech.js';

describe('the four persistent build slots', () => {
  it('is exactly four — #387 raised the cap; slots 3 & 4 back the drop-ins', () => {
    expect(PLAYER_MECH_KEYS).toEqual(['mech1', 'mech2', 'mech3', 'mech4']);
  });

  it('keeps player 1 on the key single-player has always used', () => {
    expect(mechKeyForPlayer(0)).toBe(ACTIVE_MECH_KEY);
    expect(mechKeyForPlayer(1)).toBe(PLAYER2_MECH_KEY);
  });

  it('maps players 3 & 4 to their own slots (#387)', () => {
    expect(mechKeyForPlayer(2)).toBe('mech3');
    expect(mechKeyForPlayer(3)).toBe('mech4');
  });

  it('clamps a stray extra player onto the last real slot rather than returning undefined', () => {
    expect(mechKeyForPlayer(4)).toBe('mech4');
    expect(mechKeyForPlayer(-1)).toBe('mech1');
    expect(mechKeyForPlayer(undefined)).toBe('mech1');
  });

  it('both slots exist in the roster defaults, and both are COMPLETE builds', () => {
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

describe('solo is untouched', () => {
  const solo = makeGarageSession();

  it('edits mech1 and deploys mech1 alone', () => {
    expect(sessionMechKey(solo)).toBe('mech1');
    expect(sessionMechKeys(solo)).toEqual(['mech1']);
  });

  it('has a plain Deploy button with no handoff step', () => {
    expect(garageAction(solo)).toBe('deploy');
    expect(garageActionLabel(solo)).toBe('▶ DEPLOY');
  });

  it('shows no co-op status chrome, only the opt-in button', () => {
    expect(garageStatusText(solo)).toBe('');
    expect(coopToggleLabel(solo)).toBe('+ ADD PLAYER 2');
  });

  it('treats a missing/garbage session as solo rather than throwing', () => {
    expect(sessionMechKey(null)).toBe('mech1');
    expect(sessionMechKeys(undefined)).toEqual(['mech1']);
    expect(garageAction(null)).toBe('deploy');
    expect(garageStatusText(null)).toBe('');
  });
});

describe('the sequential handoff', () => {
  it('walks solo -> P1 building -> P2 building -> deploy', () => {
    let s = makeGarageSession();
    expect(garageAction(s)).toBe('deploy');

    s = beginCoop(s);
    expect(sessionMechKey(s)).toBe('mech1');
    expect(garageStatusText(s)).toBe('PLAYER 1 BUILDING');
    expect(garageAction(s)).toBe('handoff');
    expect(garageActionLabel(s)).toBe('▶ P1 READY');

    s = handOff(s);
    expect(sessionMechKey(s)).toBe('mech2');
    expect(garageStatusText(s)).toBe('PLAYER 2 BUILDING');
    expect(garageAction(s)).toBe('deploy');
    expect(garageActionLabel(s)).toBe('▶ DEPLOY');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2']);
  });

  it('the garage flow never advances past the DEPLOY step, so it stays two-player (#387)', () => {
    // After one handoff the button is DEPLOY, not another handoff — the garage UI can never step
    // to player 3 even though four slots now exist. 3 & 4 arrive only as mid-sortie drop-ins;
    // #388 is what makes them pre-buildable in the garage.
    const s = handOff(beginCoop(makeGarageSession()));
    expect(s.editing).toBe(1);
    expect(garageAction(s)).toBe('deploy');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2']);
  });

  it('handOff still clamps to the last real slot rather than indexing off the end', () => {
    // Pure safety: even if called past the flow, editing can never index a nonexistent slot.
    const s = handOff(handOff(handOff(handOff(beginCoop(makeGarageSession())))));
    expect(sessionMechKey(s)).toBe('mech4');
  });

  it('is a no-op in solo — one player can never be handed off to nobody', () => {
    const s = handOff(makeGarageSession());
    expect(s.coop).toBe(false);
    expect(sessionMechKey(s)).toBe('mech1');
    expect(garageAction(s)).toBe('deploy');
  });

  it('leaves the session object it was given untouched (pure)', () => {
    const s = beginCoop(makeGarageSession());
    const snapshot = { ...s };
    handOff(s);
    toggleCoop(s);
    expect(s).toEqual(snapshot);
  });
});

// #387 raised PLAYER_MECH_KEYS to four for the mid-sortie drop-ins, but the garage build flow is
// still sequential two-player — a garage co-op deploy must put exactly the slots it built on the
// field, never all four, or four mechs would spawn from a two-player garage session.
describe('a garage co-op deploy stays two-player even with four slots (#387)', () => {
  it('deploys only the slots the sequential flow reached, not the whole array', () => {
    // Player 2 at the Deploy button (editing = 1) — the only state a co-op deploy happens in.
    const s = handOff(beginCoop(makeGarageSession()));
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2']);
    // Solo is one key, unchanged.
    expect(sessionMechKeys(makeGarageSession())).toEqual(['mech1']);
  });
});

describe('the one co-op toggle button', () => {
  it('opts in from solo', () => {
    const s = toggleCoop(makeGarageSession());
    expect(s.coop).toBe(true);
    expect(s.editing).toBe(0);
  });

  it('backs all the way out while player 1 is still building', () => {
    const s = toggleCoop(beginCoop(makeGarageSession()));
    expect(s.coop).toBe(false);
    expect(sessionMechKeys(s)).toEqual(['mech1']);
    expect(coopToggleLabel(s)).toBe('+ ADD PLAYER 2');
  });

  it('steps BACK to player 1 while player 2 is building — a premature handoff is recoverable', () => {
    const p2 = handOff(beginCoop(makeGarageSession()));
    expect(coopToggleLabel(p2)).toBe('◀ BACK TO P1');
    const back = toggleCoop(p2);
    expect(back.coop).toBe(true);
    expect(sessionMechKey(back)).toBe('mech1');
    expect(garageAction(back)).toBe('handoff');
  });

  it('round-trips: opt in, hand off, step back, hand off again', () => {
    let s = makeGarageSession();
    s = toggleCoop(s); s = handOff(s); s = toggleCoop(s); s = handOff(s);
    expect(sessionMechKey(s)).toBe('mech2');
    expect(sessionMechKeys(s)).toEqual(['mech1', 'mech2']);
  });

  it('endCoop always lands back on player 1', () => {
    const s = endCoop(handOff(beginCoop(makeGarageSession())));
    expect(s).toEqual({ coop: false, editing: 0 });
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
