// Arena targeting mixin (#31, #62, rework #252) — the two always-on aiming systems and the
// queries they need. Aim-assist as a toggle is retired (#62): the lock is always available. Two
// systems remain, and #252 unified them further — indirect fire now simply follows whichever
// target direct-fire convergence has already picked:
//  • Convergence (direct fire: lasers, autocannons): _fireAngle angles off-centre muzzles inward
//    to a forward point at `convergeTarget`'s range — the target `pickConvergeTarget` (shared.js)
//    picks this frame, or CONVERGE_DIST when there is none — so shots land where the turret points.
//    The angle math itself is purely geometric; the SIGHT rule lives one step earlier, in which
//    enemies are offered as candidates at all (#306/#337 — nobody targets what they can't see;
//    flyers exempt). #322 replaced the old ranked "enemy always beats terrain" ordering with ONE
//    rule over ONE pool: within a ~20° cone of the aim direction, NEAREST wins, enemies scored as
//    modestly closer so they still win at comparable range.
//  • Indirect fire (missiles, lobs): #252 made the "lock" a per-frame mirror of `convergeTarget`
//    and #341 finished the job — there is no separate lock object at all now. `convergeTarget` IS
//    the target for direct and indirect fire alike: no amber→red charge-up, no maintain timer, no
//    deliberate-switch dwell, no second eligibility rule. What the reticle draws, what homing
//    rounds seek, and what convergence geometry uses are one decision made in one place
//    (`_updateLock` below). Once picked, an indirect round tracks and fires at that LIVE target
//    straight through cover (#252 playtest follow-up — no dead-reckoned "blind fire" guess, no
//    distinct reticle colour for it). The reticle SLIDES toward the live aim point rather than
//    snapping — purely cosmetic, it never affects what actually gets fired at; that pure easing
//    (`stepReticlePosition`) lives in data/targetlock.js so it stays unit-tested.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { stepReticlePosition } from '../../data/targetlock.js';
import { enemyTargetable } from '../../data/visibility.js';
import { CONVERGE_DIST, convergedFireAngle, pickConvergeTarget } from './shared.js';
import { TARGETING_RANGE } from '../../data/targetingRange.js';
import { primaryPlayerOf } from './players.js';

// #322: the two hand-set targeting ranges are gone. `ASSIST_RANGE` (2200) gated enemies and
// `CONVERGE_DIST` (450) gated terrain — different numbers for the same question, and 2200 was
// PAST the longest weapon in the game, so the player could lock what nothing could reach. Both
// roles are now `TARGETING_RANGE` (data/targetingRange.js), derived from the live WEAPONS table's
// longest `range.max` (1750 today), so retuning a weapon retunes targeting. CONVERGE_DIST is still
// imported above for its OTHER, separate job: the convergence GEOMETRY distance when there is no
// target at all (see `_fireAngle`).

// #144 playtest correction on #140 ("turn off the aiming dotted line for now, not loving it"):
// disabled without deleting the implementation, so it's easy to re-enable later if revisited.
const AIM_LINE_ENABLED = false;

export const TargetingMixin = {
  // Pick THE target for this frame — one decision serving direct-fire convergence, indirect-fire
  // seeking, the reticle, and the HUD alike (#341: there is no second "lock" concept to keep in
  // sync any more):
  //  • `player.convergeTarget` — the live pick (shared.js `pickConvergeTarget`, #322): the nearest
  //    in-cone candidate of any kind — enemy, destructible hex, or wall span — or null. Enemy
  //    candidates ARE sight-gated before scoring (`inRange` below, #306/#337); the cone/nearest
  //    SCORING itself is purely geometric.
  //  • `player.aimEnemy` — that same pick, when it happens to be a live enemy.
  //  • `player.reticlePos` — the drawn reticle's eased position. Presentation only; it never
  //    affects what is fired at.
  // #348: resolves the lock for ONE player. Each player has its own turret, so each picks its
  // own target, converges its own muzzles on it and draws its own reticle — there is nothing
  // left that two players could share here. `player` defaults to the primary so every existing
  // caller and arena test double is unchanged.
  _updateLock(dt, player = primaryPlayerOf(this)) {
    // #306 (confirmed intent): TARGETING RESPECTS LOS. Convergence/lock may not acquire an enemy
    // the player has no sight of, so breaking a sightline genuinely protects a unit and
    // concealment becomes tactically real. `enemyTargetable` (data/visibility.js) is the pure
    // rule; FLYING enemies are exempt — they're above whatever blocks ground-level sight, the
    // same exception #245/#257 already make for flyers and cover when FIRING, which keeps the
    // targeting rule and the rendering rule (flyers draw above the dimming) in agreement.
    //
    // Symmetry note: enemy fire already gates on LOS (`aimAndFire`'s `needLos`, via
    // `_cachedLosToPlayer`), and the visible set is computed with `coverBlocksForRay` — the SAME
    // shared cover decision that raycast uses, with the same #72 own-hex endpoint exemption — so
    // the player can now target exactly the set of ground enemies that can target the player
    // back. This closes an asymmetry rather than creating one.
    const inRange = (e) => !e.mech.isDestroyed()
      && Math.hypot(e.x - player.x, e.y - player.y) <= TARGETING_RANGE
      // #337 v2: the fog's per-enemy rule. Live, `_enemyVisible` is ALWAYS the branch taken (the
      // mixin is unconditional); the `enemyTargetable` fallback survives only for scene doubles in
      // tests that predate the fog. "Nobody targets what they can't see —
      // player and enemies alike" (Jackson chose "Full parity"), and the corollary is that anything
      // the fog DOES show him is lockable: airborne units, wall turrets, and — by symmetry — any
      // enemy with a live firing lane on him. `_enemyVisible` is the single source of truth for
      // both what gets drawn and what may be acquired, so the reticle can never grab a shape that
      // isn't on screen, and a thing shooting him is never un-lockable.
      && (this._enemyVisible ? this._enemyVisible(e)
        : enemyTargetable(e, this.visibleHexes, (x, y) => this._hexKeyAt(x, y)));

    // #322: ONE pool, ONE rule. Enemies and destructible terrain (hexes AND base wall spans,
    // world.js `_destructibleTargetsNear`) are handed to `pickConvergeTarget` together and scored
    // identically — inside a ~20° cone of the aim direction, nearest wins, with enemies given a
    // modest range edge. The terrain scan can no longer be skipped when an enemy exists (the #250
    // shortcut, which was exactly the mechanism that made "enemy always wins" absolute), and it now
    // spans the full TARGETING_RANGE rather than the old 450px stub, so a wall directly in front of
    // you can actually beat a drone way off to the side.
    const enemyCandidates = this.enemies.filter(inRange);
    const terrainCandidates = this._destructibleTargetsNear(player.x, player.y, TARGETING_RANGE);
    player.convergeTarget = pickConvergeTarget(
      player.x, player.y, player.turretAngle, enemyCandidates, terrainCandidates, TARGETING_RANGE);
    // `aimEnemy` stays the "is the current pick a live enemy" view of the same decision (read by
    // the HUD/FX paths that only care about enemy targets), rather than a separately-scored pick.
    player.aimEnemy = player.convergeTarget?.mech ? player.convergeTarget : null;

    // Reticle slide (#252): ease the drawn position toward the live aim point each frame rather
    // than snapping. Null when there's nothing targeted (nothing drawn); a fresh acquisition
    // (no previous position) snaps straight to the new target instead of sliding in from nowhere.
    // Note there is no extra gate between the pick above and what's aimed at: once `pickConvergeTarget`
    // has chosen, indirect fire follows it through cover (#252 playtest follow-up) — the eligibility
    // question is settled entirely in `inRange`/`pickConvergeTarget`.
    const aimPt = this._lockAimPoint(player);
    player.reticlePos = aimPt ? stepReticlePosition(player.reticlePos, aimPt, dt) : null;
  },

  // The point indirect (homing/arcing) player fire should seek this frame: the frame's live
  // `convergeTarget` (#341 — the same single pick everything else uses), LOS or not (#252 playtest
  // follow-up: no dead-reckoned "blind fire" branch, no charge gate). A static (hex/wall) target is
  // just its point. Null = no target at all, or the targeted enemy just died.
  //
  // IMPORTANT: for an enemy target this returns the LIVE enemy handle itself (`t`, carrying
  // `.mech`/`.x`/`.y`/`.vx`/`.vy`), not a `{x,y}` copy taken right now. A round's `seekTarget` is
  // stashed once at spawn (firing.js) and then re-read every frame in _updateProjectiles
  // (projectiles.js) — the `.mech` presence is exactly how that per-frame code tells "live enemy,
  // keep following it" apart from "fixed point." Returning a fresh `{x,y}` snapshot here would make
  // every homing round steer at the target's spawn-instant position forever instead of following
  // it as it moves.
  _lockAimPoint(player = primaryPlayerOf(this)) {
    const t = player.convergeTarget;
    if (!t) return null;
    if (!t.mech) return { x: t.x, y: t.y };   // static hex point — always current
    return t.mech.isDestroyed() ? null : t;
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

  // Target reticle (#31, #62, rework #252, #341): corner brackets + a ring, drawn at `player.reticlePos`
  // (which eases toward the live aim point rather than snapping — see `stepReticlePosition`).
  // There's no more charge phase to show (#252 dropped the amber climb), and the playtest
  // follow-up (#252) dropped the distinct "blind fire" violet colour too (see targetlock.js's
  // file header) — indirect fire always tracks the live target now, so this always draws at
  // full "locked" (red) strength. Drawn each frame.
  // #348: `color` (optional) tints the reticle in a player's identifying colour so two reticles
  // on screen are never ambiguous. Omitted — which is every solo-play frame — it stays the
  // familiar locked red, unchanged.
  _drawLockReticle(x, y, color = null) {
    const col = color ?? 0xe2533a;   // locked = red
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
  // ACTUALLY pointed (`player.turretAngle`, which lags the raw mouse/stick aim via each chassis'
  // turretSlew) — NOT a short "which way is it pointed" nub any more, and deliberately NOT the
  // #129 halo+outline / UI_HIGHLIGHT_COLOR wayfinding language the objective marker and edge-
  // direction arrow use (that reads as "go here"; this should read as a passive sightline
  // overlay, not a UI callout). Drawn as short dashes (Phaser's Graphics has no built-in dashed-
  // line primitive, so this simulates one) in flat greyscale, fading out with distance so a
  // 1000px+ line doesn't end in a harsh cutoff and doesn't visually compete with far-off
  // terrain/enemies the way a uniform-opacity line would.
  _drawAimLine(player = primaryPlayerOf(this)) {
    if (!AIM_LINE_ENABLED) return; // #144: disabled for now, see flag above
    const startDist = 26;     // px forward of the mech centre — clears the hull sprite
    const length = 1100;      // #140: long sightline, well past the extended (#135) weapon ranges
    const dash = 14, gap = 10;
    const color = 0xd7dde4;   // flat light grey — NOT UI_HIGHLIGHT_COLOR/amber, no halo/outline
    const nearAlpha = 0.22;   // already faint at the muzzle...
    const farAlpha = 0;       // ...fading fully out by the far end, not cutting off hard
    const cos = Math.cos(player.turretAngle), sin = Math.sin(player.turretAngle);
    const step = dash + gap;
    for (let d = startDist; d < startDist + length; d += step) {
      const d1 = Math.min(d + dash, startDist + length);
      const t = (d - startDist) / length;          // 0 near the mech .. 1 at the far end
      const alpha = nearAlpha + (farAlpha - nearAlpha) * t;
      if (alpha <= 0.01) break;
      this.projFx.lineStyle(1.5, color, alpha)
        .lineBetween(player.x + cos * d, player.y + sin * d, player.x + cos * d1, player.y + sin * d1);
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
  // #348: `player` is whose weapon this is — its own turret facing and its own converge pick.
  _fireAngle(w, m, player = primaryPlayerOf(this)) {
    const d = w.weapon.delivery;
    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') return player.turretAngle;
    // Converge on a point at the picked target's range (or CONVERGE_DIST when there's none at
    // all), but floored to MIN_CONVERGE_DIST inside convergedFireAngle so point-blank can't cross
    // the muzzles (#74). `convergeTarget` (shared.js `pickConvergeTarget`, set in _updateLock) is
    // #322: scored by ONE rule over one pool — nearest inside a ~20° cone, enemies given a modest
    // range edge. (This supersedes #250's absolute "an enemy always beats terrain" ordering.)
    const t = player.convergeTarget;
    const dist = t ? Math.hypot(t.x - player.x, t.y - player.y) : CONVERGE_DIST;
    return convergedFireAngle(player.x, player.y, player.turretAngle, dist, m.x, m.y);
  },
};
