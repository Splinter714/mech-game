// Arena targeting mixin (#31, #62, rework #252) — the two always-on aiming systems and the
// queries they need. Aim-assist as a toggle is retired (#62): the lock is always available. Two
// systems remain, and #252 unified them further — indirect fire now simply follows whichever
// target direct-fire convergence has already picked:
//  • Convergence (direct fire: lasers, autocannons): _fireAngle angles off-centre muzzles inward
//    to a forward point at `convergeTarget`'s range — the LIVE best-scoring enemy (`aimEnemy`,
//    #250 playtest follow-up: angular offset dominant, blended with a proximity term so a
//    meaningfully closer enemy can beat a marginally-better-aimed farther one), or, #250, a nearby
//    standing destructible-terrain hex when no enemy is available, or CONVERGE_DIST
//    when neither exists — so shots land where the turret points. Purely geometric (no LOS check
//    at all); `convergeTarget` (shared.js `pickConvergeTarget`) is the ranked pick: an enemy
//    always wins over a hex.
//  • Indirect-fire lock (missiles, lobs, #252 rework): the lock IS `convergeTarget`, mirrored
//    instantly every frame — no amber→red charge-up, no maintain timer that outlives convergence,
//    no deliberate-switch dwell. Because convergence itself has no LOS gate, its live pick can be
//    a real enemy currently hidden behind cover; when that happens indirect rounds arc onto the
//    target's last-known + dead-reckoned predicted position (blind fire) instead of homing through
//    the wall. The reticle SLIDES toward the live aim point each frame rather than snapping — purely
//    cosmetic, it never affects what actually gets fired at. The pure lock/prediction/slide math
//    lives in data/targetlock.js so it's unit-tested; here we feed it the live queries.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { stepLock, predictedTarget, stepReticlePosition } from '../../data/targetlock.js';
import { CONVERGE_DIST, convergedFireAngle, pickConvergeTarget, pickAimEnemy } from './shared.js';

// #77 tuning follow-up: bumped from 620 alongside the 3-4x missile range increase (weapons.js)
// so the lock can still be held at the weapon's own new effective range — kept comfortably
// above the longest missile range.max (swarmRack, 1750) with the same margin ratio as before.
const ASSIST_RANGE = 2200;        // px the enemy must be within for convergence to consider it

// #144 playtest correction on #140 ("turn off the aiming dotted line for now, not loving it"):
// disabled without deleting the implementation, so it's easy to re-enable later if revisited.
const AIM_LINE_ENABLED = false;

export const TargetingMixin = {
  // Advance BOTH direct-fire convergence and the indirect-fire lock, which #252 made a direct
  // mirror of it:
  //  • `this.aimEnemy` / `this.convergeTarget` — the live convergence pick (shared.js
  //    `pickConvergeTarget`, fed by `pickAimEnemy`'s blended angle+proximity score, #250): the
  //    best-scoring in-range enemy right now, or, #250, a fallback destructible hex, or null.
  //    Purely geometric, no LOS gate.
  //  • `this.lock` (data/targetlock.js) — mirrors `convergeTarget` every frame, instantly (no
  //    charge, no maintain, no switch-dwell). Tracks last-known position/velocity so a target
  //    that's convergence's pick but currently out of LOS can still be fired at blind (dead
  //    reckoned), and drives the reticle-slide position for drawing.
  _updateLock(dt) {
    const inRange = (e) => !e.mech.isDestroyed() && Math.hypot(e.x - this.px, e.y - this.py) <= ASSIST_RANGE;

    // aimEnemy (convergence): the in-range enemy `pickAimEnemy` (shared.js) scores best — angular
    // offset from the aim line dominates, but #250 playtest follow-up: a meaningfully closer
    // enemy can outweigh a modest angular disadvantage, so it's not PURE angle-only any more.
    const aimE = pickAimEnemy(this.px, this.py, this.turretAngle, this.enemies.filter(inRange), ASSIST_RANGE);
    this.aimEnemy = aimE;
    // #250 ("destroyable hexes should be potential convergence targets, but lower priority than
    // enemies"): only bother scanning for a fallback hex when there's no enemy to converge on —
    // pickConvergeTarget returns aimEnemy immediately whenever one exists, so a populated hex
    // list would never even be consulted, let alone preferred. Scoped to CONVERGE_DIST (the same
    // "no target" convergence range, and comfortably past direct-fire's actual optimal ranges) via
    // world.js `_destructibleHexesNear`, which bounds the scan to a local ring rather than
    // walking the whole buildingHp/coverHp maps.
    const hexCandidates = aimE ? [] : this._destructibleHexesNear(this.px, this.py, CONVERGE_DIST);
    this.convergeTarget = pickConvergeTarget(this.px, this.py, this.turretAngle, aimE, hexCandidates);

    // #252: the lock is simply `convergeTarget`, mirrored every frame. Only an ENEMY target needs
    // an LOS check (for blind-fire dead reckoning) — a destructible hex has no `.mech`, never
    // moves, and is always exactly where it is, so it's always treated as "seen."
    const target = this.convergeTarget;
    let hasLos = true, targetPos = null;
    if (target?.mech) {
      if (!target.mech.isDestroyed()) {
        const d = Math.hypot(target.x - this.px, target.y - this.py);
        const ang = Math.atan2(target.y - this.py, target.x - this.px);
        // #72 own-hex transparency: the target's own soft-cover hex (and the player's) doesn't
        // break the lock's LOS — an enemy standing in forest is visible and lockable. #167: a
        // single PLAYER-side raycast per frame (not per-enemy), so it stays fresh — just routed
        // through the allocation-free raycast to drop its per-call Set + per-step key strings.
        hasLos = this._wallDistanceLos(this.px, this.py, ang, d, target.x, target.y) === Infinity;
        targetPos = { x: target.x, y: target.y, vx: target.vx || 0, vy: target.vy || 0 };
      } else {
        hasLos = false;   // defensive — convergeTarget already filters out destroyed enemies
      }
    } else if (target) {
      targetPos = { x: target.x, y: target.y, vx: 0, vy: 0 };   // static hex: always fully known
    }
    stepLock(this.lock, { target, hasLos, targetPos });

    // Track seconds-since-LOS so blind fire can dead-reckon the target the right distance ahead.
    this._lockBlindAge = this.lock.blind ? (this._lockBlindAge || 0) + dt : 0;

    // Reticle slide (#252): ease the drawn position toward the live aim point each frame rather
    // than snapping. Null when there's nothing to lock onto (nothing drawn); a fresh acquisition
    // (no previous position) snaps straight to the new target instead of sliding in from nowhere.
    const aimPt = this._lockAimPoint();
    this._reticlePos = aimPt ? stepReticlePosition(this._reticlePos, aimPt, dt) : null;
  },

  // The point indirect (homing/arcing) player fire should seek this frame — whenever the lock has
  // a target (#252: no charge gate any more). While an enemy target has LOS it's the live target;
  // while blind it's the dead-reckoned last-known + predicted position, so rounds arc over cover
  // onto it. A static (hex) target is just its point. Null = no target at all.
  //
  // IMPORTANT: with LOS this returns the LIVE enemy handle itself (`e`, carrying `.mech`/`.x`/`.y`/
  // `.vx`/`.vy`), not a `{x,y}` copy taken right now. A round's `seekTarget` is stashed once at
  // spawn (firing.js) and then re-read every frame in _updateProjectiles (projectiles.js) — the
  // `.mech` presence is exactly how that per-frame code tells "live enemy, keep following it" apart
  // from "fixed point, a blind-fire dead-reckoned guess." Returning a fresh `{x,y}` snapshot here
  // used to make every homing round steer at the target's spawn-instant position forever, even
  // with a full unbroken LOS lock — the round would fly to where the target WAS, not where it IS.
  _lockAimPoint() {
    const t = this.lock.target;
    if (!t) return null;
    if (!t.mech) return { x: t.x, y: t.y };   // static hex point — always current, never blind
    if (this.lock.blind) return predictedTarget(this.lock, this._lockBlindAge || 0);
    return !t.mech.isDestroyed() ? t : predictedTarget(this.lock, this._lockBlindAge || 0);
  },

  // The closest living enemy to a point, within `maxDist` (default: any). Used for homing/hitscan
  // target selection and burning-ground ticks.
  _nearestEnemy(x, y, maxDist = Infinity) {
    let best = null, bd = maxDist;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  },

  // Lock reticle (#31, #62, rework #252): corner brackets + a ring, drawn at `this._reticlePos`
  // (which eases toward the live aim point rather than snapping — see `stepReticlePosition`).
  // There's no more charge phase to show (#252 dropped the amber climb), so this always draws at
  // full "locked" strength; the only state left to distinguish is BLIND (a maintained-through-
  // convergence enemy target currently without LOS), drawn in a distinct colour so the player sees
  // they're lobbing from memory. Drawn each frame.
  _drawLockReticle(x, y, blind = false) {
    const col = blind ? 0x9a6cff : 0xe2533a;   // blind = violet, locked = red
    const r = 20, len = 8;
    const g = this.projFx.lineStyle(2, col, 1);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * r, cy = y + sy * r;
      g.lineBetween(cx, cy, cx - sx * len, cy);
      g.lineBetween(cx, cy, cx, cy - sy * len);
    }
    this.projFx.lineStyle(1.5, col, 0.9).strokeCircle(x, y, r + 4);
  },

  // #140 (playtest correction on #136 — "looks genuinely horrible... WAAAAY longer... very
  // faint, greyscale, maybe dotted"): a long, faint sightline out along where the turret is
  // ACTUALLY pointed (`this.turretAngle`, which lags the raw mouse/stick aim via each chassis'
  // turretSlew) — NOT a short "which way is it pointed" nub any more, and deliberately NOT the
  // #129 halo+outline / UI_HIGHLIGHT_COLOR wayfinding language the objective marker and edge-
  // direction arrow use (that reads as "go here"; this should read as a passive sightline
  // overlay, not a UI callout). Drawn as short dashes (Phaser's Graphics has no built-in dashed-
  // line primitive, so this simulates one) in flat greyscale, fading out with distance so a
  // 1000px+ line doesn't end in a harsh cutoff and doesn't visually compete with far-off
  // terrain/enemies the way a uniform-opacity line would.
  _drawAimLine() {
    if (!AIM_LINE_ENABLED) return; // #144: disabled for now, see flag above
    const startDist = 26;     // px forward of the mech centre — clears the hull sprite
    const length = 1100;      // #140: long sightline, well past the extended (#135) weapon ranges
    const dash = 14, gap = 10;
    const color = 0xd7dde4;   // flat light grey — NOT UI_HIGHLIGHT_COLOR/amber, no halo/outline
    const nearAlpha = 0.22;   // already faint at the muzzle...
    const farAlpha = 0;       // ...fading fully out by the far end, not cutting off hard
    const cos = Math.cos(this.turretAngle), sin = Math.sin(this.turretAngle);
    const step = dash + gap;
    for (let d = startDist; d < startDist + length; d += step) {
      const d1 = Math.min(d + dash, startDist + length);
      const t = (d - startDist) / length;          // 0 near the mech .. 1 at the far end
      const alpha = nearAlpha + (farAlpha - nearAlpha) * t;
      if (alpha <= 0.01) break;
      this.projFx.lineStyle(1.5, color, alpha)
        .lineBetween(this.px + cos * d, this.py + sin * d, this.px + cos * d1, this.py + sin * d1);
    }
  },

  // The direction a weapon fires (#40, #31). Two regimes:
  //  • Indirect (homing/lob) & melee: fire straight along the turret facing — their targeting
  //    happens downrange (homing seek / lob lead), not by bending the launch angle.
  //  • Direct (lasers, autocannons): converge — aim the (off-centre) muzzle at a forward point on
  //    the turret line at `convergeTarget`'s range (the live most-aimed enemy, or, #250, a nearby
  //    standing destructible hex when no enemy is available, or CONVERGE_DIST when neither), so
  //    shots land where the turret points. Purely geometric — no LOS gate, no lock state at all;
  //    the indirect-fire lock (#252) is simply this SAME `convergeTarget`, mirrored.
  _fireAngle(w, m) {
    const d = w.weapon.delivery;
    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') return this.turretAngle;
    // Converge on a point at the picked target's range (or CONVERGE_DIST when there's none at
    // all), but floored to MIN_CONVERGE_DIST inside convergedFireAngle so point-blank can't cross
    // the muzzles (#74). `convergeTarget` (shared.js `pickConvergeTarget`, set in _updateLock) is
    // already ranked: an enemy always wins over a destructible hex (#250).
    const t = this.convergeTarget;
    const dist = t ? Math.hypot(t.x - this.px, t.y - this.py) : CONVERGE_DIST;
    return convergedFireAngle(this.px, this.py, this.turretAngle, dist, m.x, m.y);
  },
};
