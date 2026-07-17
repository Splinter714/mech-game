// Arena targeting mixin (#31, #62) — the two always-on aiming systems and the queries they need.
// Aim-assist as a toggle is retired (#62): the lock is always available. Two clean systems remain:
//  • Convergence (direct fire: lasers, autocannons): _fireAngle angles off-centre muzzles inward
//    to a forward point at the LIVE most-aimed enemy's range (`aimEnemy`) — or CONVERGE_DIST when
//    none — so shots land where the turret points. Purely geometric; decoupled from the lock so a
//    blind lock behind cover never drags laser convergence around.
//  • Indirect-fire lock (missiles, lobs): the enemy the player clearly MEANS (pickLockCandidate:
//    angular offset blended with proximity, plus stickiness) is charged amber→red over LOCK_TIME;
//    once red the lock MAINTAINS — it survives the target leaving the cone / LOS
//    being broken for LOCK_MAINTAIN seconds (refreshed whenever we have LOS). While blind, homing/
//    arcing rounds arc onto the target's last-known + dead-reckoned predicted position. The pure
//    lifecycle lives in data/targetlock.js so it's unit-tested; here we feed it the live queries.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import Phaser from 'phaser';
import { stepLock, dropLock, isFullLock, predictedTarget, pickLockCandidate } from '../../data/targetlock.js';
import { CONVERGE_DIST, convergedFireAngle } from './shared.js';

// #77 tuning follow-up: bumped from 620 alongside the 3-4x missile range increase (weapons.js)
// so the lock can still be held at the weapon's own new effective range — kept comfortably
// above the longest missile range.max (swarmRack, 1750) with the same margin ratio as before.
const ASSIST_RANGE = 2200;        // px the enemy must be within to lock / stay locked
// The acquire cone + candidate scoring/stickiness now live in data/targetlock.js (unit-tested).

// #144 playtest correction on #140 ("turn off the aiming dotted line for now, not loving it"):
// disabled without deleting the implementation, so it's easy to re-enable later if revisited.
const AIM_LINE_ENABLED = false;

export const TargetingMixin = {
  // Advance the indirect-fire lock (#62) plus the separate live convergence reference:
  //  • `this.lock` (data/targetlock.js) — acquire amber→red on the enemy nearest the aim line,
  //    then MAINTAIN through cover using last-known + predicted position. Indirect weapons seek it.
  //  • `this.aimEnemy` — the enemy most-centred on the aim line right now (in range), used ONLY by
  //    direct-fire convergence. Decoupled from the maintained lock so a blind lock never bends it.
  _updateLock(dt) {
    // Angular offset of an enemy from the turret line (smaller = more centred on the aim).
    const aimOff = (e) => Math.abs(Phaser.Math.Angle.Wrap(Math.atan2(e.y - this.py, e.x - this.px) - this.turretAngle));
    const inRange = (e) => !e.mech.isDestroyed() && Math.hypot(e.x - this.px, e.y - this.py) <= ASSIST_RANGE;

    // Two derived things from the same sweep:
    //  • aimEnemy (convergence): nearest the aim LINE, in range, no cone gate — direct fire just
    //    wants "whatever I'm pointing closest to."
    //  • cand (lock candidate, #77): chosen by pickLockCandidate, which blends angular offset with
    //    PROXIMITY (so a near roughly-aimed enemy beats a distant dead-centred one) and gives the
    //    current lock a small stickiness discount (so a tiny aim jitter never flicks the pick).
    let aimE = null, aimOffBest = Infinity;
    const cands = [];
    for (const e of this.enemies) {
      if (!inRange(e)) continue;
      const off = aimOff(e);
      if (off < aimOffBest) { aimOffBest = off; aimE = e; }
      cands.push({ handle: e, ang: off, dist: Math.hypot(e.x - this.px, e.y - this.py) });
    }
    this.aimEnemy = aimE;
    const cand = pickLockCandidate(cands, this.lock.enemy, ASSIST_RANGE);

    // Feed the pure lock state machine. The current locked target's validity + LOS + live position
    // are computed here (Phaser side) and handed in; the transitions/prediction live in targetlock.js.
    const tgt = this.lock.enemy;
    const valid = !!tgt && inRange(tgt);
    let hasLos = false, targetPos = null;
    if (tgt && !tgt.mech.isDestroyed()) {
      const d = Math.hypot(tgt.x - this.px, tgt.y - this.py);
      const ang = Math.atan2(tgt.y - this.py, tgt.x - this.px);
      // #72 own-hex transparency: the target's own soft-cover hex (and the player's) doesn't
      // break the lock's LOS — an enemy standing in forest is visible and lockable. #167: a
      // single PLAYER-side raycast per frame (not per-enemy), so it stays fresh — just routed
      // through the allocation-free raycast to drop its per-call Set + per-step key strings.
      hasLos = this._wallDistanceLos(this.px, this.py, ang, d, tgt.x, tgt.y) === Infinity;
      targetPos = { x: tgt.x, y: tgt.y, vx: tgt.vx || 0, vy: tgt.vy || 0 };
    }
    stepLock(this.lock, { dt, cand, hasLos, targetPos, valid });

    // Track seconds-since-LOS so blind fire can dead-reckon the target the right distance ahead.
    this._lockBlindAge = this.lock.blind ? (this._lockBlindAge || 0) + dt : 0;

    // Legacy fields some code/registry still reads — kept in sync so nothing dangles.
    this.lockEnemy = this.lock.enemy;
    this.lockProgress = this.lock.progress;
  },

  // Drop the current lock (R3 / keyboard) so a fresh amber→red re-lock can be re-acquired by
  // re-aiming at whatever the player points at next.
  _dropLock() {
    if (!this.lock.enemy) return;
    dropLock(this.lock);
    this.lockEnemy = null; this.lockProgress = 0; this._lockBlindAge = 0;
  },

  // The point indirect (homing/arcing) player fire should seek this frame — only when the lock is
  // fully charged (red). While the holder has LOS it's the live target; while blind it's the
  // dead-reckoned last-known + predicted position, so rounds arc over cover onto it. Null = no lock.
  //
  // IMPORTANT: with LOS this returns the LIVE enemy handle itself (`e`, carrying `.mech`/`.x`/`.y`/
  // `.vx`/`.vy`), not a `{x,y}` copy taken right now. A round's `seekTarget` is stashed once at
  // spawn (firing.js) and then re-read every frame in _updateProjectiles (projectiles.js) — the
  // `.mech` presence is exactly how that per-frame code tells "live enemy, keep following it" apart
  // from "fixed point, a blind-fire dead-reckoned guess." Returning a fresh `{x,y}` snapshot here
  // used to make every homing round steer at the target's spawn-instant position forever, even
  // with a full unbroken LOS lock — the round would fly to where the target WAS, not where it IS.
  _lockAimPoint() {
    if (!isFullLock(this.lock)) return null;
    if (this.lock.blind) return predictedTarget(this.lock, this._lockBlindAge || 0);
    const e = this.lock.enemy;
    return e && !e.mech.isDestroyed() ? e : predictedTarget(this.lock, this._lockBlindAge || 0);
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

  // Lock reticle (#31, #62): corner brackets that close in and brighten from amber→red as the lock
  // charges (`p` = lockProgress). Full charge adds a ring to read "locked." When a maintained lock
  // goes BLIND (no LOS), it's drawn at the last-known/predicted position in a distinct "firing
  // blind" colour so the player sees they're lobbing from memory. Drawn each frame.
  _drawLockReticle(x, y, p, blind = false) {
    const locked = p >= 0.999;
    const col = blind ? 0x9a6cff : locked ? 0xe2533a : 0xefc14a;   // blind = violet, locked = red, charging = amber
    const r = 34 - 14 * p;              // brackets draw inward as the lock charges
    const len = 8;
    const g = this.projFx.lineStyle(2, col, 0.6 + 0.4 * p);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * r, cy = y + sy * r;
      g.lineBetween(cx, cy, cx - sx * len, cy);
      g.lineBetween(cx, cy, cx, cy - sy * len);
    }
    if (locked) this.projFx.lineStyle(1.5, col, 0.9).strokeCircle(x, y, r + 4);
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
  //    the turret line at the LIVE most-aimed enemy's range (`aimEnemy`, or CONVERGE_DIST), so
  //    shots land where the turret points. Purely geometric; decoupled from the maintained lock.
  _fireAngle(w, m) {
    const d = w.weapon.delivery;
    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') return this.turretAngle;
    // Converge on a point at the aimed enemy's range (or CONVERGE_DIST when none), but floored
    // to MIN_CONVERGE_DIST inside convergedFireAngle so point-blank can't cross the muzzles (#74).
    const dist = this.aimEnemy ? Math.hypot(this.aimEnemy.x - this.px, this.aimEnemy.y - this.py) : CONVERGE_DIST;
    return convergedFireAngle(this.px, this.py, this.turretAngle, dist, m.x, m.y);
  },
};
