// Arena projectiles mixin — the travelling-round simulation (advance, cover, hit/land,
// draw), plus the persistent-beam and burning-ground passes. Methods use `this` (the
// ArenaScene); composed onto the prototype via Object.assign.
import { drawProjectileBody, drawBeam, drawGroundFire } from '../../art/index.js';
import { stepProjectile, leadAngle, segmentPointDistance, resolveSeekPoint, arcHomingBlend } from '../../data/delivery.js';
import { hexesWithinPixelRadius, hexToPixel, axialKey } from '../../data/hexgrid.js';

const HIT_RADIUS = 32;            // a shot within this of a mech's centre strikes its body

// #72: is a round an incendiary? Flame damage is multiplied against soft cover (terrain.js
// FLAME_COVER_MULT) so the flamethrower ('flame' particles) and napalm ('fire' canisters +
// their burning ground) are the premier forest-clearing tools.
const isFlameKind = (kind) => kind === 'flame' || kind === 'fire';

// Arcing homing missiles (#57): the seeker doesn't engage until the round is past the apex and
// descending — see arcHomingBlend (data/delivery.js) for the ascent/descent blend curve, moved
// there (#77 follow-up) so it's shared, pure, and unit-testable Phaser-free.

export const ProjectilesMixin = {
  _updateProjectiles(dt) {
    this.projFx.clear();
    // #72 own-hex transparency: precompute the hexes occupied by everything a round could HIT
    // this frame — a player round may fly into any living enemy's soft-cover hex (and strike
    // it); an enemy round into the player's. Each round adds its own origin hexes (so firing
    // OUT of soft cover doesn't self-detonate at the muzzle).
    // #168: build ONE shared transparency Set per owner, once per frame, and reuse it across all
    // of that owner's rounds — instead of allocating a fresh Set (seeded with every enemy hex)
    // per non-arcing round per frame. `_isWallForRound` unions the shared set with each round's
    // own tiny originHexes without any per-round allocation. Same outcome, far less work/GC.
    const playerTransparent = new Set([this._hexKeyAt(this.px, this.py)]);
    const enemyTransparent = new Set();
    for (const e of this.enemies) if (!e.mech.isDestroyed()) enemyTransparent.add(this._hexKeyAt(e.x, e.y));
    // #168: a coarse spatial index over the living enemies, rebuilt once per frame, so a
    // dumbfire round's nearest-enemy lookup checks only nearby cells rather than scanning every
    // enemy. `nearest(x,y)` returns the EXACT same enemy the old full `_nearestEnemy` scan would.
    const enemyIndex = this._buildEnemyIndex();
    for (const p of this.projectiles) {
      // Hit detection normally chases the nearest living enemy (enemy rounds always chase the
      // player, the one and only target they can have), so a dumbfire round detonates on
      // whatever it reaches. A round with a LIVE LOCKED target is different (#77 follow-up bug:
      // "tracking missiles should not get blocked by other enemies in the way") — `p.seekTarget`
      // being the actual enemy handle (carries `.mech`, as opposed to a blind-fire dead-reckoned
      // `{x,y}` point with none) means this round was fired at THAT specific enemy, so its hit
      // test must be scoped to that handle, not re-resolved to "whichever enemy is nearest right
      // now." Re-resolving via `_nearestEnemy` every frame let a bystander that merely happened
      // to be closer to the round's current position steal the hit meant for the locked target
      // — reading as the bystander "blocking" the shot. Non-homing rounds and blind-fire lobs
      // (no live handle to scope to) keep the previous any-target-nearby behavior.
      const enemyShot = p.owner === 'enemy';
      const lockedLive = !enemyShot && p.homing && p.seekTarget?.mech ? p.seekTarget : null;
      const hitEnemy = enemyShot
        ? null
        : lockedLive
          ? (lockedLive.mech.isDestroyed() ? null : lockedLive)
          : enemyIndex.nearest(p.x, p.y);
      const targetGone = enemyShot ? this.mech.isDestroyed() : !hitEnemy;
      const tx = enemyShot ? this.px : (hitEnemy ? hitEnemy.x : p.x);
      const ty = enemyShot ? this.py : (hitEnemy ? hitEnemy.y : p.y);

      // Homing steers toward the round's seek target (the lock's aim point, stashed once at fire —
      // firing.js). The target handle itself is either a LIVE enemy record (re-read fresh every
      // frame via resolveSeekPoint, so the round follows it as it moves — the #77-followup fix: it
      // must NOT be a position snapshot frozen at spawn) OR a fixed point — a blind-lock's
      // last-known/predicted position (#62), which has no `.mech` and is steered toward as a static
      // aimpoint. A live enemy that dies mid-flight makes the round go dumb; it does not retarget
      // to the nearest.
      let hx = tx, hy = ty, seekVx = 0, seekVy = 0;
      if (p.homing && p.seekTarget) {
        const resolved = resolveSeekPoint(p.seekTarget);
        if (resolved.alive) { hx = resolved.x; hy = resolved.y; seekVx = resolved.vx; seekVy = resolved.vy; }
        else p.homing = false;
      } else if (p.homing && !enemyShot) {
        p.homing = false;
      }
      // Advance via the shared kinematics — guided rounds steer toward the live target
      // (capped by turn rate); ballistic rounds just integrate velocity. An arcing homing
      // round (#57) doesn't engage its seeker until it's descending — mostly ballistic on the
      // way up (like a missile still climbing out of the tube), then curving onto the target
      // as it comes down. Scale the round's turn rate by that ascent/descent blend rather than
      // hard-gating the desired angle, so the turn-in reads as a smooth curve, not a snap.
      const homingActive = p.homing && !targetGone;
      let restoreTurn = null;
      if (homingActive && p.arc) {
        const blend = arcHomingBlend(p.dist / p.maxDist);
        if (blend <= 0) {
          restoreTurn = p.turn;
          p.turn = 0;
        } else if (blend < 1) {
          restoreTurn = p.turn;
          p.turn = p.turn * blend;
        }
      }
      // Steer toward an INTERCEPT point (#77): lead a live moving enemy so the round commits to a
      // clean converging line instead of trailing it and curving in lazily. A fixed blind-lob point
      // has no velocity, so leadAngle degrades to the straight bearing there.
      let desiredAngle = null;
      if (homingActive) {
        desiredAngle = leadAngle(p.x, p.y, p.speed, hx, hy, seekVx, seekVy);
      }
      const prevX = p.x, prevY = p.y;   // #77: for swept hit detection (fast rounds can tunnel)
      stepProjectile(p, dt, desiredAngle);
      if (restoreTurn != null) p.turn = restoreTurn;
      // Cover: a round that flies into a wall detonates there (arcing rounds lob over). #41: if
      // that wall is a destructible outpost — or #72 a soft-cover hex — the round chips its HP
      // (and may flatten it to rubble; flame rounds chew soft cover extra fast). #72 own-hex
      // transparency: hexes holding something this round can hit, plus the round's own origin
      // hexes, don't count as walls — so a unit standing in forest is hittable, and a unit
      // firing OUT of forest doesn't detonate its own shot at the muzzle.
      if (!p.arc) {
        const sharedTransparent = enemyShot ? playerTransparent : enemyTransparent;
        if (this._isWallForRound(p.x, p.y, sharedTransparent, p.originHexes)) {
          p.dead = true;
          p.stopTrajectorySfx?.();   // #56: stop this round's in-flight loop the instant it dies
          this._damageBuildingAt(p.x, p.y, p.damage, { flame: isFlameKind(p.kind) });
          this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
          continue;
        }
      }
      // Swept distance (#77): closest approach of THIS step's segment to the target, not just the
      // end point — so a fast round that passes clean through the target in one frame still detonates.
      const toTarget = targetGone ? Infinity : segmentPointDistance(prevX, prevY, p.x, p.y, tx, ty);
      const landed = p.dist >= p.maxDist;
      if (toTarget < HIT_RADIUS || landed) {
        p.dead = true;
        p.stopTrajectorySfx?.();   // #56: ditto — impact/landing is the other death site
        if (toTarget < HIT_RADIUS + p.splash) {
          const dmg = Math.max(1, Math.round(p.damage * this._rangeFactor(p.range, p.dist)));
          if (enemyShot) this._damagePlayerAt(dmg);
          else if (hitEnemy) this._damageEnemyAt(hitEnemy, p.x, p.y, dmg, p.color);
        }
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
        if (p.ground) this.firePatches.push({ x: p.x, y: p.y, r: p.ground.radius, dps: p.ground.dps, until: this.time.now + p.ground.duration * 1000, nextTick: this.time.now + 500 });
        continue;
      }
      this._drawProjectile(p);
    }
    if (this.projectiles.some((p) => p.dead)) this.projectiles = this.projectiles.filter((p) => !p.dead);
  },

  // #168: a coarse uniform-grid spatial index over the living enemies, rebuilt once per frame.
  // `nearest(x, y)` returns the closest living enemy to a point — the EXACT same result the old
  // full O(enemies) `_nearestEnemy` scan gave, but by expanding Chebyshev rings of grid cells
  // outward from the query cell and stopping as soon as no unsearched cell could possibly hold
  // a closer enemy. Correctness proof: the query point sits inside its own cell, so a cell that
  // is `m` rings away is separated by at least `(m-1)` full cells, i.e. its nearest point is
  // ≥ `(m-1)*CELL` from the query. After searching every cell within ring `r`, any not-yet-seen
  // enemy lives in a ring ≥ `r+1`, hence ≥ `r*CELL` away — so once the best distance found is
  // ≤ `r*CELL`, nothing farther out can beat it and we stop. No distance is ever truncated, so
  // fast rounds and large-splash rounds still resolve against the true nearest enemy exactly as
  // before; only the average number of enemies inspected shrinks.
  _buildEnemyIndex() {
    const CELL = 160;                        // px per grid cell (~a few hex widths)
    const cells = new Map();                 // "gx,gy" -> array of living enemies
    let minGx = Infinity, maxGx = -Infinity, minGy = Infinity, maxGy = -Infinity;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const gx = Math.floor(e.x / CELL), gy = Math.floor(e.y / CELL);
      if (gx < minGx) minGx = gx;
      if (gx > maxGx) maxGx = gx;
      if (gy < minGy) minGy = gy;
      if (gy > maxGy) maxGy = gy;
      const k = gx + ',' + gy;
      let arr = cells.get(k);
      if (!arr) cells.set(k, (arr = []));
      arr.push(e);
    }
    return {
      nearest(x, y) {
        if (cells.size === 0) return null;
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        // Hard bound: the farthest populated cell from the query cell. Guarantees termination
        // and full coverage if the early-out never trips.
        const maxRing = Math.max(
          Math.abs(cx - minGx), Math.abs(cx - maxGx),
          Math.abs(cy - minGy), Math.abs(cy - maxGy),
        );
        let best = null, bd = Infinity;
        for (let r = 0; r <= maxRing; r++) {
          for (let gx = cx - r; gx <= cx + r; gx++) {
            for (let gy = cy - r; gy <= cy + r; gy++) {
              // Ring SHELL only — interior cells were searched at smaller r.
              if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
              const arr = cells.get(gx + ',' + gy);
              if (!arr) continue;
              for (const e of arr) {
                const dx = e.x - x, dy = e.y - y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < bd) { bd = d; best = e; }
              }
            }
          }
          if (best && bd <= r * CELL) break;   // nothing unsearched can be closer — done
        }
        return best;
      },
    };
  },

  _drawProjectile(p) {
    const g = this.projFx;
    // Arcing rounds fake "up and over" with SIZE alone — no vertical offset and, per #57
    // playtest feedback, NO sprite rotation/pitch. The body grows as the round lofts toward
    // the "camera" and shrinks back down as it descends (a subtle parabolic scale pulse), and
    // the ground shadow tightens beneath it — so the round reads as lofting over an obstacle
    // while staying planted on its true ground position and flat to its heading. The lateral
    // undulation (jostle/weave, applied in stepProjectile) supplies the "arcing" wiggle.
    let scale = 1;
    if (p.arc) {
      const t = p.dist / p.maxDist;
      const h = 4 * t * (1 - t);                              // 0..1 parabolic height fraction
      // Constant apex: every lob peaks at the same height regardless of range, so a near
      // toss looks like a steep mortar pop and a far shot looks flat and skimming.
      const bump = 0.6;                                       // peak size gain at apex — subtle grow-then-shrink
      scale = 1 + h * bump;
      const sw = 8 - h * 4;                                   // shadow tightens with height
      g.fillStyle(0x000000, 0.28 - h * 0.16).fillEllipse(p.x, p.y, sw, sw * 0.42);
    }
    // The round body itself is shared art (so the garage icon matches); it's drawn flat to
    // its true heading (p.angle) — never pitched — and `p.dist` drives the flame flicker.
    drawProjectileBody(g, p.x, p.y, p.angle, p.kind, p.color, scale * (p.scale || 1), p.dist);
  },

  // Persistent hitscan beams: age them, retire expired ones into a brief spark-fade, and
  // redraw the live + dying beams each frame (shared drawBeam art).
  _updateBeams(delta) {
    const SPARK_FADE = 300;
    for (const b of this.beams) { b.ttl -= delta; b.age += delta; }
    for (const b of this.beams) { if (b.ttl <= 0) this.dyingBeams.push({ ...b, fadeAge: 0, fadeTtl: SPARK_FADE }); }
    this.beams = this.beams.filter((b) => b.ttl > 0);
    for (const b of this.dyingBeams) b.fadeAge += delta;
    this.dyingBeams = this.dyingBeams.filter((b) => b.fadeAge < b.fadeTtl);

    this.beamFx.clear();
    for (const b of this.beams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age);
    for (const b of this.dyingBeams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age + b.fadeAge, 1 - b.fadeAge / b.fadeTtl);
  },

  // Burning ground patches (napalm): tick damage to mechs standing in them, with a
  // flickering flame visual, until they burn out. #72: each tick also cooks any destructible
  // SOFT-COVER hex the patch overlaps — the flame multiplier (terrain.js FLAME_COVER_MULT)
  // makes ground fire clear a forest hex in a couple of ticks, far faster than gunfire.
  _updateFirePatches() {
    const now = this.time.now;
    // #99: cleared + redrawn each frame same as the other persistent-graphics layers
    // (beamFx/projFx) — this used to draw straight into `projFx` (shared with in-flight
    // projectiles), which put the burning-ground decal at whatever depth projectiles have
    // (above units) instead of a proper low ground layer. Own graphics object (`groundFx`,
    // DEPTH.GROUND_FX — set in ArenaScene.create()) so it can never render over a mech.
    this.groundFx.clear();
    for (const fp of this.firePatches) {
      if (now >= fp.nextTick) {
        fp.nextTick += 500;
        // #87: iterate a SNAPSHOT — a killing tick now tears the enemy down and splices it out
        // of `this.enemies` synchronously (no more delayed removal), which would otherwise skip
        // whichever enemy shifts into the removed slot mid-iteration.
        for (const e of [...this.enemies]) {
          if (!e.mech.isDestroyed() && Math.hypot(e.x - fp.x, e.y - fp.y) < fp.r) {
            this._damageEnemyAt(e, e.x, e.y, Math.max(1, Math.round(fp.dps * 0.5)), 0xff7a18);
          }
        }
        for (const h of hexesWithinPixelRadius(fp.x, fp.y, fp.r)) {
          if (!this.coverHp.has(axialKey(h.q, h.r))) continue;
          const c = hexToPixel(h.q, h.r);
          this._damageBuildingAt(c.x, c.y, fp.dps * 0.5, { flame: true });
        }
      }
      drawGroundFire(this.groundFx, fp.x, fp.y, fp.r, now);   // shared flame art (matches the lab)
      if (now >= fp.until) fp.dead = true;
    }
    if (this.firePatches.some((f) => f.dead)) this.firePatches = this.firePatches.filter((f) => !f.dead);
  },
};
