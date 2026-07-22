// Arena projectiles mixin — the travelling-round simulation (advance, cover, hit/land,
// draw), plus the persistent-beam and burning-ground passes. Methods use `this` (the
// ArenaScene); composed onto the prototype via Object.assign.
import { drawProjectileBody, drawBeam, drawGroundFire } from '../../art/index.js';
import { livePlayersOf, otherLivePlayers, targetPlayerFor } from './players.js';
import { stepProjectile, leadAngle, segmentPointDistance, resolveSeekPoint, arcHomingBlend, arcLoft, arcForeshorten, salvoConvergeFalloff, stepWeakSeek, withinWeakSeekRadius, homingShouldGiveUp, homingGiveUpTurnScale, HOMING_GIVEUP_BLEND_SEC } from '../../data/delivery.js';
import { hexesWithinPixelRadius, hexToPixel, axialKey } from '../../data/hexgrid.js';
import { isSoftCover } from '../../data/terrain.js';

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
    // #347: every player's own hex is transparent to player-owned rounds (a round leaving a
    // mech standing in forest must not self-detonate at its own muzzle) — one Set covering all
    // of them, which for one player is the same single entry as before.
    const playerTransparent = new Set(
      livePlayersOf(this).map((pl) => this._hexKeyAt(pl.x, pl.y)));
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
      // #347: an enemy round chases the player NEAREST TO THE ROUND. A round fired at a
      // specific player already carries that player as its live `seekTarget` handle (set in
      // enemies.js `_updateEnemyLock`, mutated in place so it keeps tracking); this nearest
      // fallback is for the dumb-fire rounds that have none. With one player both resolve to
      // the same target, so the hit test is unchanged.
      const hitPlayer = enemyShot ? targetPlayerFor(this, p) : null;
      const targetGone = enemyShot ? !hitPlayer || hitPlayer.mech.isDestroyed() : !hitEnemy;
      const tx = enemyShot ? hitPlayer?.x : (hitEnemy ? hitEnemy.x : p.x);
      const ty = enemyShot ? hitPlayer?.y : (hitEnemy ? hitEnemy.y : p.y);

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
      const turnFull = p.turn;   // the round's true, undamped turn rate — always restored after stepProjectile
      let turnScale = 1;
      let seekerLive = homingActive;   // #418: an arcing lob's seeker isn't engaged during ballistic ascent
      if (homingActive && p.arc) {
        const blend = arcHomingBlend(p.dist / p.maxDist, p.blendStart);
        if (blend <= 0) { seekerLive = false; turnScale = 0; }
        else if (blend < 1) { turnScale = blend; }
      }
      // #418 follow-up: once a failed pass has triggered give-up, ease turn authority to zero
      // over HOMING_GIVEUP_BLEND_SEC instead of snapping straight — see homingGiveUpTurnScale.
      if (homingActive && p.homingGivingUp) {
        turnScale *= homingGiveUpTurnScale(p.homingGiveUpElapsed, HOMING_GIVEUP_BLEND_SEC);
      }
      if (turnScale !== 1) p.turn = turnFull * turnScale;
      // #377 follow-up — SALVO SEPARATION. A round carrying its own `aimOffset` steers at a
      // point pushed slightly sideways off the true target (perpendicular to its own line to
      // it), so the six rounds of a Swarm Rack salvo hold visible separation instead of all
      // collapsing onto one aim point the moment the seeker goes live. The offset fades to
      // zero over the converge window (salvoConvergeFalloff — full authority through cruise,
      // gone before impact), so they tighten onto the real target at the last moment and all
      // still connect. Applied BEFORE leadAngle so the intercept solution is computed against
      // the offset point, and left out of `tx/ty` entirely so hit detection is untouched.
      if (p.aimOffset && homingActive) {
        const dx = hx - p.x, dy = hy - p.y;
        const len = Math.hypot(dx, dy);
        // Keyed to REMAINING DISTANCE, never to flight fraction — see salvoConvergeFalloff.
        // A fraction would make the tightening start further out on a long shot than a short
        // one; this way it looks identical at every range.
        // #434: a `salvoNoConverge` round (Plasma Arc's saturating volley) keeps its offset at full
        // authority the whole way in — it is meant to LAND spread across an area, not converge — so
        // it never calls salvoConvergeFalloff.
        const f = p.salvoNoConverge ? 1 : (len > 1e-6 ? salvoConvergeFalloff(len) : 0);
        if (f > 0) {
          const off = p.aimOffset * f;
          hx += (-dy / len) * off;
          hy += (dx / len) * off;
        }
      }
      // Steer toward an INTERCEPT point (#77): lead a live moving enemy so the round commits to a
      // clean converging line instead of trailing it and curving in lazily. A fixed blind-lob point
      // has no velocity, so leadAngle degrades to the straight bearing there.
      let desiredAngle = null;
      if (homingActive) {
        desiredAngle = leadAngle(p.x, p.y, p.speed, hx, hy, seekVx, seekVy);
      }
      // Weak seek (#213 — Plasma Lance): a bolt with no lock at all still gets a tiny bias
      // toward whatever living enemy is nearest to ITS OWN current position this frame — not
      // the player's locked target (this fires even with no lock/hitEnemy scoped target) and
      // not a target fixed at spawn. Reuses the same per-frame spatial index the hit-detection
      // nearest-enemy lookup above already built, so this costs nothing extra to look up. Only
      // applies to player-fired rounds — an enemy's only possible "nearest enemy" is the player
      // itself, which its aim/targeting already handles.
      if (p.weakSeek && !enemyShot) {
        const seekEnemy = enemyIndex.nearest(p.x, p.y);
        if (seekEnemy && withinWeakSeekRadius(p, seekEnemy.x, seekEnemy.y)) {
          stepWeakSeek(p, dt, seekEnemy.x, seekEnemy.y);
        }
      }
      const prevX = p.x, prevY = p.y;   // #77: for swept hit detection (fast rounds can tunnel)
      stepProjectile(p, dt, desiredAngle);
      p.turn = turnFull;   // always restore — arc-blend and give-up scaling are both per-frame only
      // #418 FAILED-PASS GIVE-UP: a guided round that has overshot its target — begun receding
      // from its closest approach past the give-up margin — stops steering here and eases its
      // turn authority to zero over HOMING_GIVEUP_BLEND_SEC (rather than snapping straight
      // instantly, which read as a visible kink) so it carries to ground/terrain or max range
      // and detonates instead of orbiting the target forever hunting another pass. Only guided
      // rounds whose seeker is actually live (an arcing lob mid-ascent is approaching, not
      // orbiting, and always lands at maxDist regardless); dumbfire rounds never reach here.
      // Turn authority only ever decreases across the blend — it never re-engages homing.
      if (seekerLive && !targetGone) {
        if (!p.homingGivingUp && homingShouldGiveUp(p, Math.hypot(tx - p.x, ty - p.y))) {
          p.homingGivingUp = true;
          p.homingGiveUpElapsed = 0;
        } else if (p.homingGivingUp) {
          p.homingGiveUpElapsed += dt;
        }
        if (p.homingGivingUp && p.homingGiveUpElapsed >= HOMING_GIVEUP_BLEND_SEC) {
          p.homing = false;
        }
      }
      // Cover: a round that flies into a wall detonates there (arcing rounds lob over). #41: if
      // that wall is a destructible outpost — or #72 a soft-cover hex — the round chips its HP
      // (and may flatten it to rubble; flame rounds chew soft cover extra fast). #72 own-hex
      // transparency: hexes holding something this round can hit, plus the round's own origin
      // hexes, don't count as walls — so a unit standing in forest is hittable, and a unit
      // firing OUT of forest doesn't detonate its own shot at the muzzle. #316 reverses
      // #245/#257: rounds used to carry an `ignoresCover` stamp exempting a FLYING enemy's shots
      // (and the player's shots aimed AT a flyer) from this check entirely. That stamp is gone —
      // cover is cover for every shooter and every target. Only an ARCING round still lobs over,
      // which it always did on its own trajectory merits, unrelated to who fired it.
      // #338 RESTORES a NARROW form of that stamp — narrow in a way #245/#257's never was. It is no
      // longer a property of the SHOOTER (a flying enemy's rounds passing through walls); it is the
      // shot half of the ONE predicate that also decides what may be locked (data/visibility.js
      // `targetCoverExempt`), stamped player-side at spawn only while the locked target is airborne.
      // Cover is still cover for every enemy shooter and for every ground target — this exists so
      // that a helicopter the targeting rules let you lock over a base wall is a helicopter you can
      // actually hit, rather than lock saying yes and the shot saying no.
      if (!p.arc && !p.ignoresCover) {
        // #288: base wall spans live on the boundaries BETWEEN hexes, so there's no tile under the
        // round to look up — and a fast round covers far more ground in one step than the wall's
        // ~14px thickness, so a point check at the step's endpoint could step clean over it. Test
        // the whole step as a SEGMENT against the wall line (same swept principle as the
        // `segmentPointDistance` target check just below), and detonate at the exact crossing point
        // so the impact FX lands on the wall's face rather than somewhere past it.
        // #310 (2026-07-19): the round's target may BE a wall turret, which since the mounts were
        // centred stands on its span's CENTRELINE — so the gun and the wall occupy the same point,
        // this wall test runs first, and without an exception the gun would be literally
        // unhittable, leaving its 200hp span as the only way to silence it (4x what #310 shipped).
        //
        // The exception is deliberately narrow on THREE axes, because a wall you can shoot through
        // is a much worse bug than a gun you cannot shoot. It applies only to the one span the
        // target gun stands on, only on the step where the round is genuinely landing on that gun
        // (`hittingItsGun` — the same swept HIT_RADIUS test that resolves the hit a few lines
        // below), AND (#426) only when the round was fired from the span's EXPOSED (outward) side
        // — a round fired from behind the turret's own wall (inside the compound) gets no pass and
        // detonates on the wall exactly like any other round at any other span. A round merely
        // passing near an armed span still detonates on the wall, exactly as it always did, so
        // `enemyIndex.nearest` happening to name a wall turret can never open a hole in the
        // perimeter.
        const wallHit0 = this._wallEdgeHit?.(prevX, prevY, p.x, p.y);
        const hittingItsGun = !!(wallHit0 && hitEnemy && !enemyShot && wallHit0.edge.key === hitEnemy.spanKey
          && segmentPointDistance(prevX, prevY, p.x, p.y, hitEnemy.x, hitEnemy.y) < HIT_RADIUS + p.splash);
        const wallHit = hittingItsGun ? null : wallHit0;
        if (wallHit) {
          p.dead = true;
          p.stopTrajectorySfx?.();
          this._damageWallEdge(wallHit.edge, p.damage);
          this._impactFx(wallHit.x, wallHit.y, p.color, p.kind, p.splash, p.weaponId);
          continue;
        }
        // #427 (supersedes #412's targeted-open-gate pip): an OPEN gate is now solid to a round via
        // `blocksShot`, so `_wallEdgeHit` above already detonates the round on it and routes the
        // damage to the span's HP (the `wallHit` branch), exactly like any other span. No locked-pip
        // proximity test is needed — the gate's parted leaves leave it always solid enough to hit.
        // #317 THE TARGETED-HEX RULE: a round whose TARGET is a destructible hex impacts that hex
        // the moment it enters it, regardless of whether that terrain would normally stop a ray.
        // This is checked BEFORE the cover test and is deliberately independent of it — soft cover
        // correctly does NOT block a mech's ray (and since #374 blocks nobody's), so
        // `_isWallForRound` below
        // returns false for a forest hex and the round used to sail straight over the very tile the
        // reticle was locked on. The own-hex `transparent` exemption could never rescue this: it
        // makes a hex MORE see-through, which for soft cover was already a no-op.
        //
        // Scoped as tightly as possible so the soft tier keeps its whole point: it fires only for
        // the ONE hex this round was aimed at (`targetHexKey`, stamped at spawn from the live
        // converge/lock pick), and only while that hex is still standing. A round merely flying
        // PAST other foliage on its way to a distant enemy is untouched and still sails over it.
        if (p.targetHexKey
            && this._hexKeyAt(p.x, p.y) === p.targetHexKey
            && this._destructibleStandingAt?.(p.targetHexKey)) {
          p.dead = true;
          p.stopTrajectorySfx?.();
          this._damageBuildingAt(p.x, p.y, p.damage, { flame: isFlameKind(p.kind) });
          this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
          continue;
        }
        const sharedTransparent = enemyShot ? playerTransparent : enemyTransparent;
        // #310: the point-sampled form of the same narrow exemption, gated on the same condition
        // — the sampled band test would otherwise stop the round a few px short of the gun even
        // once the swept test above has let it through.
        if (this._isWallForRound(p.x, p.y, sharedTransparent, p.originHexes,
          hittingItsGun ? hitEnemy.spanKey : null)) {
          p.dead = true;
          p.stopTrajectorySfx?.();   // #56: stop this round's in-flight loop the instant it dies
          this._damageBuildingAt(p.x, p.y, p.damage, { flame: isFlameKind(p.kind) });
          this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
          continue;
        }
      }
      // #374 REWORK — IN-FLIGHT soft-cover pass-through. Every soft-cover hex a round ENTERS has
      // its own flat 10% chance of the foliage eating it, rolled ONCE on entry (never re-rolled
      // while the round sits in the hex across frames). This is what makes a shot fired into empty
      // woods, with no target at all, visibly puff and die in the trees. Exemptions:
      //   • the muzzle's own hexes (`p.originHexes`) — the #72/#279 brawling rule (a shooter in
      //     forest firing OUT is not eaten at its own muzzle);
      //   • the CURRENT target's own hex — left to the tier-bumped resolution roll below so it is
      //     never rolled twice;
      //   • an AIR-aimed shot (`p.airTarget`) — the flyer exemption, whole lane;
      //   • an ARCING lob — it flies over the canopy, exactly as it lobs over walls (`!p.arc`), and
      //     still takes its resolution own-hex roll where it comes down.
      // The round plays its OWN normal impact FX at the exact point it was caught (p.x, p.y),
      // reading as the shot being stopped right there. Symmetric — enemy rounds obey it identically.
      if (!p.arc && !p.airTarget && !p.dead) {
        const curKey = this._hexKeyAt(p.x, p.y);
        if (curKey !== p._lastHexKey) {
          p._lastHexKey = curKey;
          const victim = enemyShot ? hitPlayer : hitEnemy;
          const isOwn = !!victim && this._hexKeyAt(victim.x, victim.y) === curKey;
          const isMuzzle = !!p.originHexes && p.originHexes.includes(curKey);
          if (!isOwn && !isMuzzle && isSoftCover(this.terrain.get(curKey)) && this._softCoverHexEats?.()) {
            p.dead = true;
            p.stopTrajectorySfx?.();
            // #374: the round dies where it was actually caught — its own normal impact FX at the
            // exact in-flight stop position (p.x, p.y), NOT a puff at the hex centre — just no damage.
            this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
            // #405: the shot the foliage CAUGHT chips this hex's clear-HP (may flatten it to open
            // ground). This is the headline "blast a firing lane through the woods" case.
            this._damageSoftCoverHex?.(curKey);
            continue;
          }
        }
      }
      // #348 FRIENDLY FIRE (Jackson: ON): a PLAYER-fired round can hit another player. Checked
      // here, on the same swept segment the enemy hit test uses, and checked BEFORE that test so
      // a teammate standing between the shooter and an enemy actually eats the round rather than
      // it passing through them. The shooter is never a candidate for their own shot
      // (`p.shooter`, stamped at spawn) — walking into your own muzzle is not the mechanic.
      if (!enemyShot && !p.dead) {
        let ally = null, allyD = Infinity;
        for (const other of otherLivePlayers(this, p.shooter)) {
          const d = segmentPointDistance(prevX, prevY, p.x, p.y, other.x, other.y);
          if (d < HIT_RADIUS && d < allyD) { ally = other; allyD = d; }
        }
        if (ally) {
          p.dead = true;
          p.stopTrajectorySfx?.();
          // #374 REWORK: the resolution roll — a teammate standing in soft cover may have this
          // round eaten by the trees on their OWN hex (the tier bump). The intervening lane hexes
          // were already rolled in flight above, so this is the own-hex roll only. A blocked round
          // plays its OWN normal impact FX at the stop point (p.x, p.y) and deals nothing; an
          // unblocked round is unchanged — damage + the normal impact splash at the teammate.
          const block = this._softCoverStopsShot?.(ally, p.originHexes);
          if (block) {
            this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
            // #405: caught on the teammate's own foliage hex — chip it.
            this._damageSoftCoverHex?.(this._hexKeyAt(ally.x, ally.y));
          } else {
            const dmg = Math.max(1, Math.round(p.damage * this._rangeFactor(p.range, p.dist)));
            this._damagePlayerAt(dmg, ally, { weaponId: p.weaponId });   // #423: friendly fire — no enemy kind
            this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
          }
          continue;
        }
      }
      // #426: HIT_RADIUS (32px) is wider than a wall span's own painted band (14px), and a wall
      // turret sits exactly ON its span's centreline — so a round aimed straight at the gun from
      // BEHIND its wall gets "close enough" to trigger the swept-distance hit test below well
      // before its per-step segment ever physically crosses the (much thinner) wall band, and the
      // `hittingItsGun` crossing-exemption a few lines up never even gets exercised. This is the
      // coarser second half of the same rule: a round whose target is a wall turret it is NOT
      // exposed to never registers close enough to hit it (`toTarget` stays Infinity), so it keeps
      // flying on its existing line — which, since it is still steering at the gun's position,
      // carries it into the wall band moments later and the ordinary `wallHit0` crossing test above
      // catches it there instead. Enemy-fired rounds never target a wall turret, so `enemyShot` is
      // always false on this branch already; the explicit check just keeps the intent readable.
      // #426 (revised): wall turrets are always hittable (flying-unit rule) — never blocked by
      // their own wall from any side.
      const turretBlocked = false;
      // Swept distance (#77): closest approach of THIS step's segment to the target, not just the
      // end point — so a fast round that passes clean through the target in one frame still detonates.
      const toTarget = (targetGone || turretBlocked) ? Infinity : segmentPointDistance(prevX, prevY, p.x, p.y, tx, ty);
      const landed = p.dist >= p.maxDist;
      if (toTarget < HIT_RADIUS || landed) {
        p.dead = true;
        p.stopTrajectorySfx?.();   // #56: ditto — impact/landing is the other death site
        if (toTarget < HIT_RADIUS + p.splash) {
          // #374 REWORK: the RESOLUTION roll — the TARGET's OWN hex only (the tier bump: 25% for a
          // non-mech ground unit, 10% for a mech, air exempt). The intervening lane hexes the round
          // crossed were already rolled IN FLIGHT above (per step, as it entered each), so this
          // rolls just the one hex the target stands in — no hex is rolled twice. Every round of a
          // salvo asks independently, so a volley loses SOME of its missiles rather than all or
          // none. Identical for `enemyShot` — the rule reads the target, never the shooter.
          const victim = enemyShot ? hitPlayer : hitEnemy;
          // #374 block-visual: a truthy result means the foliage ate this round — it plays its OWN
          // normal impact FX at the stop point (p.x, p.y) and deals nothing. Skip the rest of the
          // impact resolution (destructible-hex damage, the normal splash, any fire patch).
          const block = this._softCoverStopsShot?.(victim, p.originHexes);
          if (block) {
            this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
            // #405: caught on the target's own foliage hex — chip it (wears cover down around a
            // unit you're shooting at while it's standing in the trees).
            if (victim) this._damageSoftCoverHex?.(this._hexKeyAt(victim.x, victim.y));
            continue;
          }
          const dmg = Math.max(1, Math.round(p.damage * this._rangeFactor(p.range, p.dist)));
          if (enemyShot) this._damagePlayerAt(dmg, hitPlayer, { enemyKind: p._statKind ?? null, weaponId: p.weaponId, shotId: p._statShotId ?? null, spawnerKind: p._spawnerKind ?? null });
          else if (hitEnemy) this._damageEnemyAt(hitEnemy, p.x, p.y, dmg, p.color, false, { weaponId: p.weaponId, pullId: p.pullId ?? null });
        }
        // #317: an ARCING round (missile/mortar) locked onto a destructible hex lobs OVER cover by
        // design — it never runs the in-flight wall test at all — so it used to land on a targeted
        // forest/outpost hex and do nothing but play an impact puff. If this round came down inside
        // the hex it was aimed at, it damages it. Same tight scoping as the direct-fire rule above:
        // only its own target hex, only while standing.
        if (p.targetHexKey
            && this._hexKeyAt(p.x, p.y) === p.targetHexKey
            && this._destructibleStandingAt?.(p.targetHexKey)) {
          this._damageBuildingAt(p.x, p.y, p.damage, { flame: isFlameKind(p.kind) });
        }
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
        // #319: the patch carries NO owner on purpose — burning ground is a hazard that
        // burns whoever stands in it, including whoever lit it (see _updateFirePatches).
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
    let foreshorten = 1;
    if (p.arc) {
      const t = p.dist / p.maxDist;
      // #377: the loft EASING is now per-weapon (delivery.arcProfile -> p.arcProfile, curve in
      // data/delivery.js arcLoft). 'lob' is the original symmetric parabola and stays the
      // default for every arcing weapon; Swarm Rack alone opts into 'steepDrop' — pop up fast,
      // cruise flat, then plunge in the last fifth of flight.
      const h = arcLoft(t, p.arcProfile);                      // 0..1 height fraction
      // Constant apex: every lob peaks at the same height regardless of range, so a near
      // toss looks like a steep high pop and a far shot looks flat and skimming.
      const bump = p.arcBump ?? 0.6;                         // peak size gain at apex — per-weapon (delivery.arcBump), subtle grow-then-shrink
      scale = 1 + h * bump;
      const sw = 8 - h * 4;                                   // shadow tightens with height
      g.fillStyle(0x000000, 0.28 - h * 0.16).fillEllipse(p.x, p.y, sw, sw * 0.42);
      // #377: derive a sprite PITCH from where we are in the arc. arcForeshorten reads the arc's
      // vertical velocity (dh/dt of the same loft curve) — steep while climbing off the muzzle
      // and while plunging onto the target, ~flat across the apex — and returns an along-axis
      // length scale. So the top-down sprite squashes end-on as it points up, stretches full
      // side-on at the flat cruise, then squashes again as it noses down onto the enemy.
      foreshorten = arcForeshorten(t, p.arcProfile);
    }
    // The round body itself is shared art (so the garage icon matches); it's drawn flat to
    // its true heading (p.angle) — `foreshorten` compresses only its length to fake pitch —
    // and `p.dist` drives the flame flicker.
    drawProjectileBody(g, p.x, p.y, p.angle, p.kind, p.color, scale * (p.scale || 1), p.dist, foreshorten);
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
        const tick = Math.max(1, Math.round(fp.dps * 0.5));
        // #319: burning ground is INDISCRIMINATE — it belongs to nobody and burns whatever
        // stands in it, owner included. The bug was that the loop damaged only enemies and
        // never called `_damagePlayerAt`, so enemy-fired napalm (the artillery mech's entire
        // payload) burned its own escort and left the player untouched — which is what the
        // playtest reported. Rather than scope the burn to the opposing side, the owner's
        // call is that fire is a ground hazard: your own napalm hurts you too, and an
        // artillery mech that lobs it into its own crowd cooks that crowd. So there is
        // deliberately no owner on a patch — this is the whole fix.
        // #347: burning ground burns EVERY player standing in it, each taking its own tick —
        // the indiscriminate-hazard rule above applied per player rather than to "the" player.
        for (const pl of livePlayersOf(this)) {
          if (Math.hypot(pl.x - fp.x, pl.y - fp.y) < fp.r) this._damagePlayerAt(tick, pl);
        }
        // #87: iterate a SNAPSHOT — a killing tick tears the enemy down and splices it out
        // of `this.enemies` synchronously, which would otherwise skip whichever enemy
        // shifts into the removed slot mid-iteration.
        for (const e of [...this.enemies]) {
          if (!e.mech.isDestroyed() && Math.hypot(e.x - fp.x, e.y - fp.y) < fp.r) {
            this._damageEnemyAt(e, e.x, e.y, tick, 0xff7a18);
          }
        }
        // Cover burns the same way — flame clears foliage whoever lit it.
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
