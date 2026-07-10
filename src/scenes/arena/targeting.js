// Arena targeting mixin (#31, #62) — the two always-on aiming systems and the queries they need.
// Aim-assist as a toggle is retired (#62): the lock is always available. Two clean systems remain:
//  • Convergence (direct fire: lasers, autocannons): _fireAngle angles off-centre muzzles inward
//    to a forward point at the LIVE most-aimed enemy's range (`aimEnemy`) — or CONVERGE_DIST when
//    none — so shots land where the turret points. Purely geometric; decoupled from the lock so a
//    blind lock behind cover never drags laser convergence around.
//  • Indirect-fire lock (missiles, lobs): the enemy nearest the aim *line* is charged amber→red
//    over LOCK_TIME; once red the lock MAINTAINS — it survives the target leaving the cone / LOS
//    being broken for LOCK_MAINTAIN seconds (refreshed whenever we have LOS). While blind, homing/
//    arcing rounds arc onto the target's last-known + dead-reckoned predicted position. The pure
//    lifecycle lives in data/targetlock.js so it's unit-tested; here we feed it the live queries.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import Phaser from 'phaser';
import { stepLock, dropLock, isFullLock, predictedTarget } from '../../data/targetlock.js';
import { CONVERGE_DIST, convergedFireAngle } from './shared.js';

const ACQUIRE_CONE = 0.35;        // radians half-angle to grab a new lock candidate
const ASSIST_RANGE = 620;         // px the enemy must be within to lock / stay locked

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

    // Live most-aimed enemy (convergence): nearest the aim line, in range, no cone gate needed —
    // convergence just wants "whatever I'm pointing closest to." Also serves as the lock candidate
    // when it falls inside the ACQUIRE cone.
    let aimE = null, aimOffBest = Infinity;
    for (const e of this.enemies) {
      if (!inRange(e)) continue;
      const off = aimOff(e);
      if (off < aimOffBest) { aimOffBest = off; aimE = e; }
    }
    this.aimEnemy = aimE;
    const cand = aimE && aimOffBest < ACQUIRE_CONE ? aimE : null;

    // Feed the pure lock state machine. The current locked target's validity + LOS + live position
    // are computed here (Phaser side) and handed in; the transitions/prediction live in targetlock.js.
    const tgt = this.lock.enemy;
    const valid = !!tgt && inRange(tgt);
    let hasLos = false, targetPos = null;
    if (tgt && !tgt.mech.isDestroyed()) {
      const d = Math.hypot(tgt.x - this.px, tgt.y - this.py);
      const ang = Math.atan2(tgt.y - this.py, tgt.x - this.px);
      hasLos = this._wallDistance(this.px, this.py, ang, d) === Infinity;
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
    this._floatText(this.px, this.py - 30, 'LOCK DROPPED', '#7c8794');
  },

  // The point indirect (homing/arcing) player fire should seek this frame — only when the lock is
  // fully charged (red). While the holder has LOS it's the live target; while blind it's the
  // dead-reckoned last-known + predicted position, so rounds arc over cover onto it. Null = no lock.
  _lockAimPoint() {
    if (!isFullLock(this.lock)) return null;
    if (this.lock.blind) return predictedTarget(this.lock, this._lockBlindAge || 0);
    const e = this.lock.enemy;
    return e && !e.mech.isDestroyed() ? { x: e.x, y: e.y } : predictedTarget(this.lock, this._lockBlindAge || 0);
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
