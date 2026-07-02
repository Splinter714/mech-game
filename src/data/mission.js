// Mission model — pure objective + win/lose logic, no Phaser. A Mission is a data-configured
// objective the arena evaluates each frame against a small state snapshot. Adding a mission
// type = one entry in MISSION_TYPES (mirrors the weapon/chassis data-driven convention); the
// arena decides how to fill the state snapshot each type reads.

export const MISSION_TYPES = {
  // #66: destroy a designated enemy structure (one of the world's destructible outposts).
  assault: {
    id: 'assault',
    name: 'Assault',
    objective: 'Destroy the enemy outpost',
    // Won the moment the objective structure is rubble.
    isComplete: (s) => !!s.objectiveDestroyed,
  },
  // Future entries (each is one object here + the arena filling its state fields):
  //   elimination — all enemies dead:            isComplete: (s) => s.enemiesTotal > 0 && s.enemiesAlive === 0
  //   survival    — hold for a timer / N waves:  isComplete: (s) => s.elapsed >= s.holdFor
  //   escort/extraction — reach/protect a point.
};

export const DEFAULT_MISSION = 'assault';

export function makeMission(typeId = DEFAULT_MISSION) {
  const type = MISSION_TYPES[typeId];
  if (!type) throw new Error(`unknown mission type: ${typeId}`);
  return { typeId, name: type.name, objective: type.objective, status: 'active' };
}

// Pure transition: given a mission and a state snapshot, return the resulting status
// ('active' | 'complete' | 'failed'). A terminal status is sticky (never re-opens).
//
// Objective-only for now (#66): the model DOES fail a mission on player death, but the arena
// doesn't feed a real death yet — the deploy survivability buffer keeps the player alive, and
// tuning that (so 'failed' can actually fire) is deferred to the run loop (#64).
export function evaluateMission(mission, state = {}) {
  if (mission.status !== 'active') return mission.status;
  if (state.playerDead) return 'failed';
  const type = MISSION_TYPES[mission.typeId];
  if (type && type.isComplete(state)) return 'complete';
  return 'active';
}
