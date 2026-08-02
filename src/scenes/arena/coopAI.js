// #604: the AI brain that drives a co-op player's mech once its own controller disconnects, so
// the mech keeps fighting — full real loadout, abilities included — instead of standing frozen
// or despawning (#579's earlier "quick fix", which this replaces). Scene wiring (coop.js
// `_aiIntentFor`) gathers this player's own live enemies + nearest human teammate each frame and
// hands them to the pure functions below; this file is the actual decision math, split out
// alongside enemyAiTuning.js's own pure AI helpers (same "no Phaser, review/tune" shape) rather
// than folded into coop.js directly, since coop.js is already a large scene-wiring mixin.
//
// Targeting and the "am I hurt?" ability gate deliberately reuse the SAME primitives the real
// enemy AI (enemies.js) and the Friendly Drone Launcher (data/friendlyDroneAI.js) already lean
// on, rather than inventing new ones — see each import below for which:
//   - `meanOpt`/`STANDOFF_FRAC`/`STANDOFF_MIN`/`STANDOFF_MAX` (enemyAiTuning.js) derive an
//     engagement standoff from THIS PLAYER'S OWN real loadout, exactly the way an enemy mech's
//     tactical AI derives its own standoff from its own rolled weapons.
//   - `lethalHealth` (enemyAiTuning.js) is the same "am I hurt?" signal the enemy AI's own
//     cover-seeking decision reads (COVER_HEALTH_TRIGGER); reused here to gate the
//     mobility/defensive ability heuristic.
//   - `nearestInterceptTarget` (data/interceptor.js) is the same generic "nearest candidate
//     within range" scan Anti-Missile Defense and the Friendly Drone Launcher both already use
//     for target selection — called here with `range: Infinity` to get an UNCONDITIONAL nearest,
//     which is the same "nearest, full stop" rule `targetPlayerFor` (data/players.js) uses for
//     how an enemy picks which PLAYER to hunt, just pointed at `this.enemies` instead.
//
// Movement is the one genuinely new piece — see `aiMoveVector`'s own header note: enemy AI only
// ever needs to hunt A player, never to also stay close to an ALLY.
import {
  meanOpt, STANDOFF_FRAC, STANDOFF_MIN, STANDOFF_MAX, clamp, lethalHealth,
} from './enemyAiTuning.js';
import { nearestInterceptTarget } from '../../data/interceptor.js';
import { getAbility, ABILITY_TYPES } from '../../data/abilities.js';
import { canActivate } from '../../data/abilityState.js';
import { ABILITY_SLOTS } from '../../data/anatomy.js';

// How far this AI lets itself drift from the nearest living human teammate before its movement
// decision starts biasing back toward them instead of purely chasing its own target — the
// owner's "sticks close to the active players" answer (#604), expressed as a distance dial.
// Comfortably inside the shared-camera leash's own hard-stop (data/leash.js LEASH_RADIUS=280,
// i.e. up to 560px between two players before the leash itself intervenes), so this bias is what
// keeps an AI-driven mech inside the leashed frame naturally — the leash stays a rarely-hit
// backstop, not something this fights against. PLAYTEST DIAL, starting number.
export const AI_HOME_RADIUS = 220;

// Lethal-part health fraction below which the AI treats itself as "taking heavy damage" and
// prefers a mobility/defensive ability over an offensive one. Mirrors enemyAiTuning.js's own
// COVER_HEALTH_TRIGGER (0.45) — the same threshold the real enemy AI uses to decide "am I hurt
// enough to want cover". PLAYTEST DIAL.
export const AI_HURT_HEALTH_FRAC = 0.45;

// Multiplier over this player's own engagement standoff that decides "is my target close enough
// to actually shoot at" — a bit past standoff so it doesn't hold fire right at the edge of its
// preferred range. PLAYTEST DIAL.
export const AI_FIRE_RANGE_MULT = 1.5;

// This player's own preferred engagement distance, derived from ITS OWN mounted loadout — same
// role/standoff math (STANDOFF_FRAC of the mean weapon optimum range, clamped to
// [STANDOFF_MIN, STANDOFF_MAX]) an enemy mech's tactical AI derives for itself from its own
// rolled weapons (enemies.js `_spawnMech`).
export function aiStandoff(mech) {
  return clamp(meanOpt(mech) * STANDOFF_FRAC, STANDOFF_MIN, STANDOFF_MAX);
}

// Nearest live enemy to (x, y), or null if none remain. See the file header for why this is
// `nearestInterceptTarget` with an unconditional range rather than a new scan.
export function pickAiTarget(x, y, liveEnemies) {
  return nearestInterceptTarget(x, y, Infinity, liveEnemies);
}

// One frame of this AI's move-INTENT vector — magnitude <= 1, the same shape Controls.read()
// reports for `move`. `target` is the enemy it's engaging (or null); `home` is the nearest living
// human teammate's `{x,y}` (or null when there is nobody to stay close to — e.g. every other
// player is also AI-controlled or down). Blends two pulls:
//   - ENGAGE: close the distance while short of `standoff`, back off once well past it, hold
//     still in the band between — a single-band simplification of enemyAiTuning.js's own
//     TOO_CLOSE/TOO_FAR bands (deliberately not a full PRESS/KITE/FLANK/COVER state machine —
//     see the module header on not over-building this).
//   - HOME: once further than `homeRadius` from the nearest human, pull back toward them, RAMPING
//     in over one more `homeRadius` of distance (not snapping) so the mech doesn't visibly
//     whiplash between "fighting" and "returning" right at the boundary.
// The home pull's weight fully replaces the engage pull as it ramps to 1, which is what makes
// "stay close" win over "keep fighting" the owner's answer asked for, without the AI abandoning
// an engagement the instant the boundary is crossed.
export function aiMoveVector({ x, y, target, standoff, home, homeRadius = AI_HOME_RADIUS }) {
  let ex = 0, ey = 0;
  if (target) {
    const dx = target.x - x, dy = target.y - y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    if (dist > standoff * 1.15) { ex = ux; ey = uy; }        // too far — close in
    else if (dist < standoff * 0.75) { ex = -ux; ey = -uy; } // too close — back off
    // else: sweet spot — no engagement-driven movement this frame.
  }

  let hx = 0, hy = 0, homeWeight = 0;
  if (home) {
    const dx = home.x - x, dy = home.y - y;
    const distHome = Math.hypot(dx, dy);
    if (distHome > homeRadius) {
      const ux = dx / (distHome || 1), uy = dy / (distHome || 1);
      hx = ux; hy = uy;
      homeWeight = Math.min(1, (distHome - homeRadius) / homeRadius);
    }
  }

  const mx = ex * (1 - homeWeight) + hx * homeWeight;
  const my = ey * (1 - homeWeight) + hy * homeWeight;
  const mag = Math.hypot(mx, my);
  if (mag <= 0.0001) return { x: 0, y: 0 };
  return mag > 1 ? { x: mx / mag, y: my / mag } : { x: mx, y: my };
}

// The two mountable ABILITY_SLOTS (Y/X), decided by the simplest heuristic that reads as
// intentional rather than random (deliberately simple — see the module header): an OFFENSE
// ability fires when off cooldown and engaged; a MOBILITY or DEFENSE ability fires when off
// cooldown and this player is taking heavy damage (lethal-part health under
// `AI_HURT_HEALTH_FRAC`, the same "am I hurt?" signal enemyAiTuning.js's own `lethalHealth`
// feeds the real enemy AI's cover-seeking decision). No sequencing, no choosing among several
// simultaneously-ready abilities beyond "whichever slot holds which type" — real tactical
// ability play is a much deeper problem than this issue asks for.
export function aiAbilityIntent({ mech, abilityStates, engaged }) {
  const hurt = lethalHealth(mech) < AI_HURT_HEALTH_FRAC;
  const out = {};
  for (const slot of ABILITY_SLOTS) {
    out[slot] = false;
    const abilityId = mech?.abilityMounts?.[slot];
    const def = abilityId && getAbility(abilityId);
    if (!def) continue;
    const state = abilityStates?.[slot];
    if (!state || !canActivate(state)) continue;
    const type = ABILITY_TYPES[abilityId];
    if (type === 'Offense' && engaged) out[slot] = true;
    else if ((type === 'Mobility' || type === 'Defense') && hurt) out[slot] = true;
  }
  return out;
}
