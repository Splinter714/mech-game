// Run model (#64) — pure roguelite run-loop state, no Phaser. A Run sequences a fixed
// number of escalating STAGES: each stage is one mission (currently always 'assault', per
// data/mission.js) fought against a squad that gets both BIGGER and TOUGHER as the run goes
// on. The arena mixin (scenes/arena/run.js) owns the Phaser-side wiring (spawning the squad,
// building the mission, timers for the transition banners); this file only computes WHAT
// stage N looks like and tracks the run's status/currency, mirroring the mission.js style:
// small, data-driven, fully unit-tested in isolation.

import { ENEMY_ROTATION } from './enemies.js';

// Total stages in one run. Completing the final stage's mission WINS the run. Kept modest
// (a few minutes of play per stage) so a full run is a reasonably-sized session.
export const STAGE_COUNT = 5;

// ── Escalation curve ─────────────────────────────────────────────────────────────────────
// "Both more AND tougher" (owner's call, #64): squad SIZE grows with stage, and the POOL of
// unit ids a stage draws from skews toward harder kinds at higher stages. Rather than one
// flat rotation (ENEMY_ROTATION, used by the debug spawn-more control), stages pull from a
// tiered pool: easy stages draw mostly from EARLY_POOL (the softer raider/turret/drone-ish
// openers), late stages draw mostly from LATE_POOL (snipers/artillery/tanks/helicopters/swarms
// — the harder mech roles + toughest non-mech kinds). The mix is a straight lerp by stage
// index so the curve is easy to eyeball and retune.
// #75: gunships appear more often across a run. Helicopter is added to EARLY_POOL (so it can
// show up even in early stages) AND listed twice in LATE_POOL (so it's weighted heavier among
// the hard kinds). It's the only id shared by both pools — see run.test.js, which discriminates
// the early/late skew on each pool's EXCLUSIVE ids, not on the shared helicopter.
export const EARLY_POOL = ['raider', 'skirmisher', 'turret', 'tank', 'helicopter'];
export const LATE_POOL = ['sniper', 'artillery', 'helicopter', 'helicopter', 'swarm'];

// Squad size at stage 0 and the growth per stage (rounded). Stage N has
// `SQUAD_BASE + Math.round(N * SQUAD_GROWTH)` units. 3 → 3,4,5,6,7 across 5 stages.
const SQUAD_BASE = 3;
const SQUAD_GROWTH = 1;

// Currency earned for CLEARING a stage (banked into the run total immediately on advance),
// scaling up with stage index so later, harder stages pay out more. A flat base plus a
// per-stage bonus keeps the curve simple and readable.
const CURRENCY_BASE = 50;
const CURRENCY_PER_STAGE = 25;

// Fraction of the tiered pool draw taken from LATE_POOL at a given stage index (0-based),
// ramping linearly from 0 (stage 0, all-early) to 1 (final stage, all-late).
function lateFraction(stageIndex) {
  if (STAGE_COUNT <= 1) return 0;
  return stageIndex / (STAGE_COUNT - 1);
}

// Deterministic-enough squad composition for a stage: pick `size` ids, each independently
// drawn from LATE_POOL with probability `lateFraction(stageIndex)`, else EARLY_POOL. Uses
// Math.random() (matches the rest of the arena's enemy-rotation/spawn-point randomness —
// this is flavour, not something the smoke test needs to pin down) but always returns a
// full-length array so the composition is exactly as escalating-in-SIZE as designed.
export function squadForStage(stageIndex) {
  const size = SQUAD_BASE + Math.round(stageIndex * SQUAD_GROWTH);
  const frac = lateFraction(stageIndex);
  const squad = [];
  for (let i = 0; i < size; i++) {
    const pool = Math.random() < frac ? LATE_POOL : EARLY_POOL;
    squad.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return squad;
}

// Full descriptor for stage N: mission type + squad composition + a display label. Currently
// every stage is an 'assault' (the only registered mission type, per data/mission.js); this
// is the single seam a future mission-type rotation would extend.
export function stageDescriptor(stageIndex) {
  return {
    stageIndex,
    missionTypeId: 'assault',
    squad: squadForStage(stageIndex),
    label: `STAGE ${stageIndex + 1}/${STAGE_COUNT}`,
  };
}

// Currency awarded for clearing `stageIndex`.
export function currencyForStage(stageIndex) {
  return CURRENCY_BASE + CURRENCY_PER_STAGE * stageIndex;
}

// ── Run lifecycle ────────────────────────────────────────────────────────────────────────
// A fresh run, stage 0, active, no currency banked yet.
export function makeRun() {
  return { stageIndex: 0, currency: 0, status: 'active' };
}

// Pure transition: clear the CURRENT stage — bank its currency and advance to the next
// stage index, or WIN the run if that was the final stage. No-ops (returns the run
// unchanged) if the run isn't active (sticky terminal status, mirrors mission.js).
export function advanceStage(run) {
  if (run.status !== 'active') return run;
  const earned = currencyForStage(run.stageIndex);
  const currency = run.currency + earned;
  const nextIndex = run.stageIndex + 1;
  if (nextIndex >= STAGE_COUNT) {
    return { ...run, currency, status: 'won' };
  }
  return { ...run, currency, stageIndex: nextIndex, status: 'active' };
}

// Pure transition: the player died — end the run as a loss. Sticky/no-op once terminal.
export function endRunOnDeath(run) {
  if (run.status !== 'active') return run;
  return { ...run, status: 'dead' };
}

export function isRunOver(run) {
  return run.status === 'won' || run.status === 'dead';
}

// Reference export for callers that want the raw rotation the debug spawn control uses,
// kept alongside the tiered pools above for discoverability (not used by this file itself).
export const DEBUG_ROTATION = ENEMY_ROTATION;
