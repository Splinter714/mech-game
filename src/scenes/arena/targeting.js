// Arena targeting mixin (#31) — the two always-on aiming systems and the queries they need:
//  • Soft-lock (indirect fire: missiles, lobs): locks the enemy nearest the aim *line*, charges
//    amber→red over LOCK_TIME while held, and that enemy is what homing rounds seek / lobs land
//    on. The lock is sticky (ACQUIRE cone to grab, wider RELEASE cone to drop) so it doesn't
//    flicker. This is the only "true aim assist".
//  • Convergence (direct fire: lasers, autocannons): _fireAngle angles off-centre muzzles inward
//    to a forward point at the locked target's range (or CONVERGE_DIST when nothing's locked), so
//    shots land where the turret points. Purely geometric — never curves toward the enemy.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import Phaser from 'phaser';

const ACQUIRE_CONE = 0.35;        // radians half-angle to grab a new soft-lock
const RELEASE_CONE = 0.55;        // wider half-angle before an existing lock is dropped
const ASSIST_RANGE = 620;         // px the enemy must be within
const LOCK_TIME = 0.6;            // seconds of holding a target in-cone to charge amber→red
const CONVERGE_DIST = 450;        // px convergence range for direct fire when nothing is locked

export const TargetingMixin = {
  // Soft-lock (#31): lock the enemy nearest the aim line. The lock is sticky — kept until it
  // leaves the (wider) RELEASE cone or range, swapped only when another enemy is clearly more
  // centred — so it doesn't flicker. While a target is held the lock charges amber→red over
  // LOCK_TIME (`lockProgress`); it bleeds back down when nothing is locked. Indirect weapons
  // (homing/lob) seek `lockEnemy`; `_drawLockReticle` shows the charge.
  _updateLock(dt) {
    this.registry.set('assistOn', this.assistOn);
    if (!this.assistOn) { this.lockEnemy = null; this.lockProgress = 0; return; }

    // Angular offset of an enemy from the turret line (smaller = more centred on the aim).
    const aimOff = (e) => Math.abs(Phaser.Math.Angle.Wrap(Math.atan2(e.y - this.py, e.x - this.px) - this.turretAngle));
    const inRange = (e) => !e.mech.isDestroyed() && Math.hypot(e.x - this.px, e.y - this.py) <= ASSIST_RANGE;

    // The best fresh candidate: in range, within the ACQUIRE cone, nearest the aim line.
    let cand = null, candOff = ACQUIRE_CONE;
    for (const e of this.enemies) {
      if (!inRange(e)) continue;
      const off = aimOff(e);
      if (off < candOff) { candOff = off; cand = e; }
    }

    // Stickiness: keep the current lock while it stays in range and inside the RELEASE cone,
    // unless a fresh candidate is meaningfully more centred (hysteresis margin).
    const keep = this.lockEnemy && inRange(this.lockEnemy) && aimOff(this.lockEnemy) < RELEASE_CONE;
    const prev = this.lockEnemy;
    if (keep && (!cand || cand === this.lockEnemy || aimOff(this.lockEnemy) - candOff < 0.12)) {
      // hold existing lock
    } else {
      this.lockEnemy = cand;
    }

    // Charge amber→red over time while a target is held (reset on a fresh target); bleed down
    // when nothing is locked.
    if (!this.lockEnemy) { this.lockProgress = Math.max(0, this.lockProgress - dt / LOCK_TIME); return; }
    if (this.lockEnemy !== prev) this.lockProgress = 0;
    this.lockProgress = Math.min(1, this.lockProgress + dt / LOCK_TIME);
  },

  // The closest living enemy to a point, within `maxDist` (default: any). Used for
  // aim-assist, homing, hitscan target selection, and burning-ground ticks.
  _nearestEnemy(x, y, maxDist = Infinity) {
    let best = null, bd = maxDist;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  },

  // Soft-lock reticle (#31): corner brackets that close in and brighten from amber→red as the
  // lock charges over time (`p` is 0→1 lockProgress). Full charge adds a ring to read "locked"
  // — the point indirect weapons commit their seek to. Drawn each frame on the live enemy.
  _drawLockReticle(x, y, p) {
    const locked = p >= 0.999;
    const col = locked ? 0xe2533a : 0xefc14a;
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

  _toggleAssist() {
    this.assistOn = !this.assistOn;
    this._floatText(this.px, this.py - 30, this.assistOn ? 'ASSIST ON' : 'ASSIST OFF', this.assistOn ? '#5ec8e0' : '#7c8794');
  },

  // The direction a weapon fires (#40, #31). Two regimes:
  //  • Indirect (homing/lob) & melee: fire straight along the turret facing — their targeting
  //    happens downrange (homing seek / lob lead), not by bending the launch angle.
  //  • Direct (lasers, autocannons): converge — aim the (off-centre) muzzle at a forward point
  //    on the turret line at the locked target's range (or CONVERGE_DIST), so shots land where
  //    the turret points. Purely geometric; never curves toward the enemy's lateral position.
  _fireAngle(w, m) {
    const d = w.weapon.delivery;
    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') return this.turretAngle;
    const dist = this.lockEnemy ? Math.hypot(this.lockEnemy.x - this.px, this.lockEnemy.y - this.py) : CONVERGE_DIST;
    const cx = this.px + Math.cos(this.turretAngle) * dist;
    const cy = this.py + Math.sin(this.turretAngle) * dist;
    return Math.atan2(cy - m.y, cx - m.x);
  },
};
