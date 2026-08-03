// Arena projectiles mixin — the travelling-round simulation (advance, cover, hit/land,
// draw), plus the persistent-beam and burning-ground passes. Methods use `this` (the
// ArenaScene); composed onto the prototype via Object.assign.
import { drawProjectileBody, HIGH_PROJECTILE_KINDS, drawBeam, drawGroundFire } from '../../art/index.js';
import { drawMineNode, EMP_TRAP_COLOR } from '../../art/abilityFx.js';
import { livePlayersOf, otherLivePlayers, targetPlayerFor } from './players.js';
import { damageInRadius } from '../../data/aoe.js';
import { computeImpulse } from '../../data/force.js';
import { isMobileEnemy } from '../../data/bases.js';
import { stepProjectile, leadAngle, segmentPointDistance, resolveSeekPoint, arcHomingBlend, arcLoft, arcForeshorten, salvoConvergeFalloff, stepWeakSeek, withinWeakSeekRadius, trackHomingSteering, homingGiveUpReason, beginHomingGiveUp, stepHomingGiveUp } from '../../data/delivery.js';
import { hexesWithinPixelRadius, hexToPixel, axialKey } from '../../data/hexgrid.js';
import { isSoftCover } from '../../data/terrain.js';
import { LOS_REFRESH_MS } from './world.js';
import { updateDotOutline, updateDotTint } from './shieldOutline.js';

const HIT_RADIUS = 32;            // a shot within this of a mech's centre strikes its body

// #253: how close a NON-target enemy has to get to a guided round before that round may capture
// it as its new target. Deliberately expressed as a multiple of the hit radius rather than a free
// number: the whole safety argument for this feature is that a round only ever switches to
// something it has effectively already flown into. At 2x, a captured enemy is within a couple of
// frames of flight for every guided round in the game, so a capture reads as the missile picking
// off what it brushed past — not as it abandoning a lock at range.
const RETARGET_RADIUS = HIT_RADIUS * 2;

// #543: a 'field' hazard's (Gravity Well's) visual ring is sampled at this many evenly-spaced
// angles around its centre to find which arcs have a clear line to hard cover — enough to read
// as a smooth cut rather than a jagged polygon at the field's visual radius (~65-210px), while
// staying cheap (each sample is one short `_wallDistanceLos` ray out to `vr`, not the full pull
// radius). Same idea as a fog-of-war vision wedge, just sampled all the way around instead of
// within a forward cone.
const FIELD_VIS_SAMPLES = 24;

// #626: how long one Tesla Pylon zap stays drawn after the pulse that produced it. `groundFx` is
// cleared and redrawn every frame (`_updateFirePatches`), so without a hold the arc would flash
// for a single frame (~16ms) and read as noise rather than a zap. Comfortably shorter than the
// weapon's own `pulseInterval` (0.5s, data/weapons.js) so consecutive ticks still read as
// separate discharges instead of one continuous beam.
const PYLON_ZAP_HOLD = 0.14;

// #72: is a round an incendiary? Flame damage is multiplied against soft cover (terrain.js
// FLAME_COVER_MULT) so the flamethrower ('flame' particles) and napalm ('fire' canisters +
// their burning ground) are the premier forest-clearing tools.
const isFlameKind = (kind) => kind === 'flame' || kind === 'fire';

// Arcing homing missiles (#57): the seeker doesn't engage until the round is past the apex and
// descending — see arcHomingBlend (data/delivery.js) for the ascent/descent blend curve, moved
// there (#77 follow-up) so it's shared, pure, and unit-testable Phaser-free.

// Arc-shadow tuning (2026-08-02) — see `_drawProjectile` for why the shadow moves rather than the
// round. Direction is a fixed SCREEN vector (not per-round), so every lofting projectile on screen
// agrees on where the light is: down-and-right, i.e. lit from the upper left. Offset is 0 at ground
// level and peaks at apex, so a round always meets its own shadow at launch and at impact.
// 2026-08-02 revision (Jackson: "those shadows look horrible, too big, bad shape, and offset
// poorly"). All three, fixed in kind:
//   • SHAPE — it was an axis-aligned squat ellipse (width × 0.42), i.e. a fat blob, under a round
//     that is long and thin. The shadow is now drawn ROTATED to the round's own heading via the
//     same canvas transform `drawProjectileBody` uses for foreshortening, so it's a slim streak
//     lying along the missile rather than a puddle under it.
//   • SIZE — 9→12px wide was as long as the missile itself and several times its width. Now
//     roughly the sprite's own footprint, and missiles just got 20% smaller besides (#638).
//   • OFFSET — 15px at apex threw the shadow most of a hex away from its round. Halved.
const SHADOW_DIR_X = Math.SQRT1_2, SHADOW_DIR_Y = Math.SQRT1_2;   // 45°, down-right
const SHADOW_MAX_OFFSET = 7;      // px the shadow trails behind the round at full apex
const SHADOW_LEN = 8;             // px along the round's heading — about the sprite's own length
const SHADOW_WID = 2.6;           // px across it; thin, matching a missile's silhouette
const SHADOW_GROW = 0.25;         // fraction of extra size at apex — higher reads as slightly bigger
const SHADOW_ALPHA = 0.26;        // flat: the old version faded out exactly when it should read most

export const ProjectilesMixin = {
  _updateProjectiles(dt) {
    this.projFx.clear();
    // The above-units projectile layer (missiles) — same clear-and-repaint-every-frame contract.
    // Optional-chained because the hand-built scene doubles and BaseScene only make `projFx`;
    // `_drawProjectile` falls back to it, so a host without this layer just draws everything low.
    this.projFxHigh?.clear();
    // #494/#546: anti-missile point defense used to run here as an always-on per-frame scan
    // (`_updateInterceptors`, gated on a passive core-slot equip choice). It's now an ACTIVE
    // mountable ability (data/abilities.js's `antiMissile`) ticked alongside every other ability
    // in `scenes/arena/abilities.js` — see `_tickAntiMissile` there for the burst-window scan that
    // replaced this call. `p.dead` still needs the same early-exit guard below (#527) since an
    // intercepted round can still be marked dead earlier this same frame.
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
    // #568: these three (both transparency Sets + the spatial index below) used to be rebuilt
    // from scratch every single frame regardless of whether anything had actually moved — real
    // GC pressure in the hottest loop in the game (every projectile, every frame). Now cached on
    // the scene and only rebuilt when a live player/enemy's HEX actually changed (or the live
    // enemy count changed — a spawn or a kill), via `_syncProjFrameCache` below.
    this._syncProjFrameCache();
    const playerTransparent = this._projPlayerTransparent;
    const enemyTransparent = this._projEnemyTransparent;
    // #168: a coarse spatial index over the living enemies, so a dumbfire round's nearest-enemy
    // lookup checks only nearby cells rather than scanning every enemy. `nearest(x,y)` returns
    // the EXACT same enemy the old full `_nearestEnemy` scan would.
    const enemyIndex = this._projEnemyIndex;
    for (const p of this.projectiles) {
      // #527: a round can already be `dead` walking INTO this loop — currently only the
      // Anti-Missile ability's burst-window scan does this (arena/abilities.js's
      // `_tickAntiMissile`, ticked before `_updateProjectiles` runs each frame), marking a round
      // shot down before it's ever moved/hit-tested this frame. Without this guard, nothing here
      // reads `p.dead` at entry (only a few narrow spots deeper down check it defensively), so an "intercepted"
      // round still fully advanced, could still detonate against its target, and still got
      // drawn as a normal in-flight round — only vanishing on the *next* frame's end-of-loop
      // filter. That's the bug behind #527 ("not seeing it happening") — the round visibly
      // kept flying (and could still hurt you) the very frame it was supposedly shot down.
      if (p.dead) continue;
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
      // #492: continuous area damage WHILE this round is in flight (before it ever detonates),
      // ticked on its own cadence independent of the hit/impact resolution below — a round with
      // no `travelAoe` (every weapon but Caustic Lobber today) never enters this block at all.
      if (p.travelAoe) this._tickTravelAoe(p);
      // #491/#499: continuous push/pull WHILE this round is in flight — player-fired only (no
      // force weapon has been asked for on the enemy side), acting on living enemies only.
      if (p.force && !enemyShot) this._tickTravelForce(p);
      // #488: a fuse detonates the round independent of its normal hit/landing resolution below
      // — skip straight to the next round once it goes off, exactly like a direct hit/landing
      // does (both set p.dead and `continue`).
      if (p.fuse && this._tickFuse(p, dt)) { this._detonateFuse(p); continue; }
      // #253 IN-FLIGHT RETARGET. A guided round is scoped to the enemy it was locked at (the
      // `lockedLive` rule just below, from #77: a bystander must not steal a locked shot). True to
      // that rule and nothing else, a salvo read as guided rails — six missiles ghosting straight
      // THROUGH a clustered garrison to converge on one unit. A round may now CAPTURE a different
      // enemy, but only one it has effectively already flown into: within RETARGET_RADIUS of the
      // warhead right now AND closer than the target it currently holds.
      //
      // Both halves of that gate matter. The distance half is what keeps #77 fixed — a bystander
      // merely NEARER to the round than its target is not enough (re-resolving on "nearest" was
      // exactly the bug where a passer-by read as blocking the shot); it has to be within a
      // missile's length, at which range the round is going to detonate on it a frame or two later
      // anyway. The closer-than-current half means a capture always moves the round toward
      // something, so it can never trade a hit it was about to land for a longer chase.
      //
      // SCOPED TO ROUNDS THAT HAD A LOCK — and a dumb-fired one deliberately gets nothing here,
      // because it already has the behaviour. Since 2026-07-31 an unlocked homing weapon dumb-fires
      // (data/targetlock.js) and `_spawnProjectile` gives that round `homing = false` with no seek
      // handle, so its hit test is ALREADY `enemyIndex.nearest` below: it detonates on whatever it
      // runs into today. Handing it a seeker here is the one version of this feature that really
      // would make the lock meaningless — it would silently upgrade every unlocked missile into a
      // guided one, which is a weapon change, not a retargeting rule.
      //
      // An arcing lob may only capture once its seeker has ENGAGED (past the #57 ascent blend).
      // On the way up it is flying OVER the field by design; a mortar that snapped onto a unit it
      // was lobbing across would be a different weapon. Swarm Rack — the salvo this issue is
      // actually about — arcs too, and spends its whole descent eligible.
      const arcBlend = p.arc ? arcHomingBlend(p.dist / p.maxDist, p.blendStart) : 1;
      if (!enemyShot && p.homing && !p.homingGivingUp && p.seekTarget?.mech && arcBlend > 0) {
        // The per-frame spatial index the dumbfire/weak-seek lookups already use — a locked round
        // did not previously query it, so this is one extra `nearest` per guided round per frame
        // and no new scan of the enemy list.
        const near = enemyIndex.nearest(p.x, p.y);
        if (near && near !== p.seekTarget && !near.mech.isDestroyed()) {
          const d = Math.hypot(near.x - p.x, near.y - p.y);
          if (d < RETARGET_RADIUS && d < Math.hypot(p.seekTarget.x - p.x, p.seekTarget.y - p.y)) {
            p.seekTarget = near;
            // A capture is a NEW engagement, so the per-target DISTANCE bookkeeping resets:
            // `homingMinDist` and the stall window describe closest approach to the OLD target,
            // and carrying them across would read the switch itself as an overshoot or a stall and
            // trigger an instant give-up on a round that is about to connect.
            // The ORBIT and FUEL rails (#418) are deliberately NOT reset — they bound the round's
            // whole flight, and a round allowed to zero its net-turn counter on every capture could
            // circle a tight cluster indefinitely, which is the exact spin this project has already
            // fixed twice.
            p.homingMinDist = null;
            p.homingStallDist = null;
            p.homingStallSince = 0;
          }
        }
      }
      // #418: a round that has GIVEN UP is no longer scoped to its lock — it is a ballistic round
      // now, so it hits whatever it runs into on the way down, like any dumbfire shot.
      const lockedLive = !enemyShot && p.homing && !p.homingGivingUp && p.seekTarget?.mech ? p.seekTarget : null;
      // Playtest pass (Gravity Well/Caustic Lobber, 2026-07-25): `p.ignoresEnemyHit` opts a round
      // out of the "detonate near an enemy" resolution entirely — it never resolves a target here,
      // so it flies past enemies untouched (its real payload — travelAoe's tendril, or the planted
      // hazard below — still finds them independently). It still resolves on cover/landing below.
      const hitEnemy = enemyShot || p.ignoresEnemyHit
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
      //
      // #418 audit — TARGET LOST is one of the ways a guided round can fail to resolve a target,
      // and it must NOT snap the seeker off mid-turn (that was its own little kink, and it left
      // the round frozen on whatever heading it happened to be banking through). Every failure
      // path now routes through the SAME eased give-up as a failed pass: mark the round as giving
      // up, let it coast out of the turn it's in over the blend window, then go plain ballistic.
      // Three ways a target stops resolving here: the seek handle no longer resolves (target
      // destroyed mid-flight, or a stale record with unusable coordinates — resolveSeekPoint), a
      // player round has no lock handle at all, or the hit target is gone (`targetGone`).
      let hx = tx, hy = ty, seekVx = 0, seekVy = 0;
      let targetLost = false;
      if (p.homing && p.seekTarget) {
        const resolved = resolveSeekPoint(p.seekTarget);
        if (resolved.alive) { hx = resolved.x; hy = resolved.y; seekVx = resolved.vx; seekVy = resolved.vy; }
        else targetLost = true;
      } else if (p.homing && !enemyShot) {
        targetLost = true;
      }
      // An enemy round with no seek handle keeps chasing the nearest live player (tx/ty) — that
      // is its designed behaviour, not a lost target; but if there's no live player to chase,
      // there is nothing to steer at either.
      if (p.homing && targetGone) targetLost = true;
      if (p.homing && targetLost) beginHomingGiveUp(p, 'targetLost');
      const givingUp = p.homing && !!p.homingGivingUp;
      // Advance via the shared kinematics — guided rounds steer toward the live target
      // (capped by turn rate); ballistic rounds just integrate velocity. An arcing homing
      // round (#57) doesn't engage its seeker until it's descending — mostly ballistic on the
      // way up (like a missile still climbing out of the tube), then curving onto the target
      // as it comes down. Scale the round's turn rate by that ascent/descent blend rather than
      // hard-gating the desired angle, so the turn-in reads as a smooth curve, not a snap.
      // A round that is giving up no longer steers at ANY target — it coasts out of its turn
      // (stepHomingGiveUp, below), so it can never keep chasing the thing it was circling.
      const homingActive = p.homing && !targetLost && !givingUp;
      const turnFull = p.turn;   // the round's true, undamped turn rate — always restored after stepProjectile
      let turnScale = 1;
      let seekerLive = homingActive;   // #418: an arcing lob's seeker isn't engaged during ballistic ascent
      // #253 hoisted `arcBlend` (computed above, from the same pre-step `p.dist`) rather than
      // calling arcHomingBlend twice a frame for the same round — the retarget gate needs the very
      // same "has this lob's seeker engaged yet" answer this block does.
      if (homingActive && p.arc) {
        if (arcBlend <= 0) { seekerLive = false; turnScale = 0; }
        else if (arcBlend < 1) { turnScale = arcBlend; }
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
      const prevAngle = p.angle;        // #418: for reading how hard the round actually steered
      // #418 GIVE-UP COAST: a round that has quit guiding — for ANY reason (failed pass, orbit,
      // fuel, lost/destroyed target) — eases out of the turn it was in over
      // HOMING_GIVEUP_BLEND_SEC rather than freezing mid-bank (the "visible kink"), then flies
      // dead straight to ground/terrain or max range and detonates there.
      if (givingUp) {
        if (stepHomingGiveUp(p, dt)) p.homing = false;   // blend done — a plain ballistic round now
        stepProjectile(p, dt, null);
      } else {
        stepProjectile(p, dt, desiredAngle);
      }
      p.turn = turnFull;   // always restore — the arc blend is per-frame only
      // #418 GIVE-UP DECISION. A guided round with a live seeker is judged every frame on the
      // three ways it can fail to convert: it OVERSHOT (receded past its closest approach), it is
      // ORBITING (net one-way steering past a 270° swing — the case the recede test is blind to,
      // and the one the owner kept seeing as "missiles spin around chasing their target"), or it
      // is out of seeker FUEL. Any of them starts the same eased give-up. Only rounds whose seeker
      // is actually live (an arcing lob mid-ascent is approaching, not orbiting, and always lands
      // at maxDist regardless); dumbfire rounds never reach here.
      if (seekerLive) {
        trackHomingSteering(p, prevAngle, dt);
        const reason = homingGiveUpReason(p, Math.hypot(tx - p.x, ty - p.y), dt);
        if (reason) beginHomingGiveUp(p, reason);
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
      // Playtest pass: `p.hitsCoverWhileArcing` opts an arcing round OUT of the "arcing rounds lob
      // clean over cover" rule (#316) while keeping its lofted visual — it should still detonate
      // against a wall/destructible hex like a straight-fired round (Gravity Well, 2026-07-25).
      const checksCover = !p.arc || p.hitsCoverWhileArcing;
      if (checksCover && !p.ignoresCover) {
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
          this._igniteBuildingHex(p, p.x, p.y);   // #536: Plasma's dot also catches the hex alight
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
          this._igniteBuildingHex(p, p.x, p.y);   // #536: Plasma's dot also catches the hex alight
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
      if (checksCover && !p.airTarget && !p.dead) {
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
            this._damagePlayerAt(dmg, ally, { weaponId: p.weaponId, dot: p.dot });   // #423: friendly fire — no enemy kind. #560: symmetric DoT.
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
      // #538: a travelAoe round that has spent its whole tendril budget expires right here, the
      // same way a round that flew its full max range does — see `_tickTravelAoe`.
      const landed = p.dist >= p.maxDist || p._tendrilsExhausted;
      // #488/#491: a round carrying `p.hazard` (Timed Charge's mines, Gravity Well's pull field)
      // never runs the normal impact/damage resolution below — instead of detonating, it PLANTS
      // itself where it comes down and becomes a standalone stationary hazard, ticking on its own
      // clock (see `_plantHazard`/`_updateHazards`).
      if (p.hazard && (toTarget < HIT_RADIUS || landed)) {
        p.dead = true;
        p.stopTrajectorySfx?.();
        this._plantHazard(p);
        continue;
      }
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
          if (enemyShot) this._damagePlayerAt(dmg, hitPlayer, { enemyKind: p._statKind ?? null, weaponId: p.weaponId, shotId: p._statShotId ?? null, spawnerKind: p._spawnerKind ?? null, dot: p.dot });   // #560: symmetric DoT
          else if (hitEnemy) this._damageEnemyAt(hitEnemy, p.x, p.y, dmg, p.color, false, { weaponId: p.weaponId, pullId: p.pullId ?? null, dot: p.dot });
          // 2026-07-31: a round carrying `p.splash` also does a REAL multi-target blast against
          // everyone else in radius (plus destructible terrain) — see `_splashDamageAt` below.
          if (p.splash > 0) this._splashDamageAt(p, enemyShot, hitPlayer, hitEnemy);
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
          this._igniteBuildingHex(p, p.x, p.y);   // #536: Plasma's dot also catches the hex alight
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

  // #492: `p.travelAoe` (a weapon's `delivery.travelAoe`) damages everything within radius of
  // the round's CURRENT position on a fixed cadence, for as long as the round is airborne — the
  // targeting/falloff math is the shared pure `damageInRadius` (data/aoe.js), applied here
  // through the same per-owner dispatch every other hit uses. A player round also catches
  // OTHER players in the blast (co-op's friendly-fire-on rule, #348) but never the shooter; an
  // enemy round catches every live player it passes near, matching how burning ground (#319) is
  // an indiscriminate hazard rather than scoped to one target.
  // #538: `travelAoe.maxTendrils` (Caustic Lobber: 15, undefined/unlimited for anything else
  // using travelAoe) caps how many times this round may CONNECT before it's forced to expire —
  // counted per individual tendril (one target hit, drawn as one `_drawAoeTendril` call), not
  // per tick, so a tick that hits 3 enemies at once spends 3 of the budget. A tick with nothing
  // in range draws no tendril and costs nothing. Once the budget is spent the round expires via
  // the exact same path as running out of range (`landed`, in `_updateProjectiles`) rather than
  // a bespoke removal — see `p._tendrilsExhausted` there.
  _tickTravelAoe(p) {
    const now = this.time.now;
    if (p._nextAoeTick == null) p._nextAoeTick = now;
    if (now < p._nextAoeTick) return;
    const { radius, dps, tickMs = 250, maxTendrils } = p.travelAoe;
    p._nextAoeTick = now + tickMs;
    const amount = Math.max(1, Math.round(dps * (tickMs / 1000)));
    const connect = (target, tx, ty) => {
      if (maxTendrils != null && p.tendrilCount >= maxTendrils) return;
      target();
      this._drawAoeTendril(p, tx, ty);
      p.tendrilCount++;
    };
    if (p.owner === 'enemy') {
      for (const pl of livePlayersOf(this)) {
        if (Math.hypot(pl.x - p.x, pl.y - p.y) < radius) {
          connect(() => this._damagePlayerAt(amount, pl, { weaponId: p.weaponId }), pl.x, pl.y);
        }
      }
    } else {
      for (const hit of damageInRadius(p.x, p.y, radius, amount, this.enemies.filter((e) => !e.mech.isDestroyed()))) {
        connect(() => this._damageEnemyAt(hit.target, hit.target.x, hit.target.y, hit.amount, p.color, false, { weaponId: p.weaponId }), hit.target.x, hit.target.y);
      }
      for (const other of otherLivePlayers(this, p.shooter)) {
        if (Math.hypot(other.x - p.x, other.y - p.y) < radius) {
          connect(() => this._damagePlayerAt(amount, other, { weaponId: p.weaponId }), other.x, other.y);
        }
      }
    }
    // #536: the cloud also chews through destructible terrain it passes over, the same way a
    // napalm ground patch's periodic tick does (`_updateFirePatches` below) — indiscriminate, no
    // owner check, since the cloud doesn't care who it belongs to any more than fire does. 2026-07-31:
    // widened from soft-cover-only to any standing destructible hex (buildings too — see
    // `_destructibleHexesInRadius`), matching the live chat ask that Caustic Lobber's cloud should
    // damage structures, not just cover. This does not spend the #538 tendril budget — that's
    // scoped to enemy/player connections.
    for (const hex of this._destructibleHexesInRadius(p.x, p.y, radius)) {
      this._damageBuildingAt(hex.x, hex.y, amount);
    }
    if (maxTendrils != null && p.tendrilCount >= maxTendrils) p._tendrilsExhausted = true;
  },

  // 2026-07-31: every standing destructible hex (a solid `buildingHp` outpost OR a `coverHp` soft-
  // cover tile — `_destructibleStandingAt`, world.js) within `radius` px of a point, as pixel-space
  // impact points ready for `_damageBuildingAt`. Shared by Caustic Lobber's travelAoe tick above and
  // the general splash-damage pass below, so the two don't duplicate the hex-radius geometry.
  // `excludeKey` skips one hex (the round's own locked target hex, if any) so a round that already
  // damaged that hex through the dedicated targeted-hex impact rule (`_updateProjectiles`, #317)
  // doesn't also double-hit it here.
  _destructibleHexesInRadius(x, y, radius, excludeKey = null) {
    const out = [];
    for (const h of hexesWithinPixelRadius(x, y, radius)) {
      const k = axialKey(h.q, h.r);
      if (k === excludeKey || !this._destructibleStandingAt?.(k)) continue;
      const c = hexToPixel(h.q, h.r);
      out.push({ key: k, x: c.x, y: c.y });
    }
    return out;
  },

  // 2026-07-31: the general splash-damage fix. `p.splash` used to only widen the hit-tolerance
  // window and size the impact FX — the round's ACTUAL damage only ever landed on the one locked
  // `hitEnemy`/`hitPlayer`, despite plasmaCannon/napalm already declaring `splash` as if it hit a
  // real area. This is the honest fix: a real multi-target blast (data/aoe.js `damageInRadius`,
  // the same primitive `_detonateFuse`'s real fuse blast already uses) against everyone else in
  // radius, excluding whoever already took the direct hit above (so they're not double-damaged),
  // plus any destructible terrain caught in the same radius. Same owner/friendly-fire branching
  // every other AoE pass in this file already uses (co-op friendly fire ON, never the shooter).
  // Carries the round's `dot` (if any) through to every splash-damaged target too — Plasma Coater's
  // burn should catch everyone in the splash, not just the direct hit.
  //
  // BALANCE NOTE: this generic fix also changes plasmaCannon's and napalm's real behavior for the
  // first time — both already carry `delivery.splash` and describe themselves as splashing in their
  // own comments, but neither actually damaged a second target before this. Flagged for a playtest
  // balance pass; if either reads as over-buffed the narrower fix is to gate this to an explicit
  // opt-in flag (e.g. `delivery.realSplash`) scoped to just plasmaCoater/causticLobber.
  _splashDamageAt(p, enemyShot, directPlayer, directEnemy) {
    const radius = p.splash;
    if (enemyShot) {
      const players = livePlayersOf(this).filter((pl) => pl !== directPlayer);
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, players)) {
        this._damagePlayerAt(hit.amount, hit.target, { weaponId: p.weaponId, dot: p.dot });
      }
    } else {
      const enemies = this.enemies.filter((e) => !e.mech.isDestroyed() && e !== directEnemy);
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, enemies)) {
        this._damageEnemyAt(hit.target, hit.target.x, hit.target.y, hit.amount, p.color, false, { weaponId: p.weaponId, dot: p.dot });
      }
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, otherLivePlayers(this, p.shooter))) {
        this._damagePlayerAt(hit.amount, hit.target, { weaponId: p.weaponId, dot: p.dot });
      }
    }
    for (const hex of this._destructibleHexesInRadius(p.x, p.y, radius, p.targetHexKey)) {
      this._damageBuildingAt(hex.x, hex.y, p.damage, { flame: isFlameKind(p.kind) });
    }
  },

  // #492 playtest follow-up: a brief bolt from a travelAoe round (Caustic Lobber, currently the
  // only weapon using travelAoe) to whatever it just damaged this tick — reads as the cloud
  // "reaching out and striking" its victims instead of damage happening invisibly. Drawn into
  // `projFx`, already cleared/redrawn this frame by `_updateProjectiles` above, so it needs no
  // lifetime/cleanup of its own — it's just gone next frame unless the tick fires again.
  // Playtest follow-up #3 (2026-07-25, #492): "slightly thicker tendrils" — lineStyle width
  // 2 -> 3.
  // Playtest follow-up #4 (2026-07-26, #492): "tendrils should also be purple and should have
  // more range and be more spooky tendrilly." Recolored to the violet palette
  // `art/projectiles/shadow.js` already established for this round and reshaped into two
  // independently-wandering sinuous strands. Range (`p.travelAoe.radius`, tuned in weapons.js)
  // is unaffected either way.
  // Playtest follow-up #5 (2026-07-26, #492): "don't like the new sinuous shape, but do like the
  // color." Reverted the SHAPE back to the pre-#4 single 2-segment jagged line (one midpoint
  // kink, not a multi-segment wandering strand) while keeping the #4 violet recolor — drawn as
  // a soft dark-violet glow underneath plus a bright-violet core on top, both darkened a touch
  // from #4's values, and both lines a bit thicker.
  _drawAoeTendril(p, tx, ty) {
    const g = this.projFx;
    const midX = (p.x + tx) / 2 + (Math.random() - 0.5) * 14;
    const midY = (p.y + ty) / 2 + (Math.random() - 0.5) * 14;
    const GLOW = 0x431364, CORE = 0x8d4db3;   // darker takes on shadow.js's dark-wisp / bright-eye violets

    for (const [width, color, alpha] of [[6, GLOW, 0.28], [3, CORE, 0.85]]) {
      g.lineStyle(width, color, alpha);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(midX, midY);
      g.lineTo(tx, ty);
      g.strokePath();
    }
  },

  // #491/#499: `p.force` (a weapon's `delivery.force`) pushes or pulls every living enemy within
  // radius of the round's CURRENT position, on the same fixed-cadence tick `_tickTravelAoe` uses.
  // Ticks AFTER `_updateEnemies` has already run this frame (see ArenaScene.update's call order),
  // so the nudge visibly sticks for the frame and each enemy's own AI re-paths from wherever it
  // ends up next frame — that tug-of-war is the whole feel, not a bug to smooth over.
  _tickTravelForce(p) {
    const now = this.time.now;
    if (p._nextForceTick == null) p._nextForceTick = now;
    if (now < p._nextForceTick) return;
    const { radius, strength, sign, tickMs = 250 } = p.force;
    p._nextForceTick = now + tickMs;
    const dt = tickMs / 1000;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      // #491 playtest fix: a stationary/emplaced kind (turret/wallTurret, `data/bases.js`
      // `isMobileEnemy` — the same maxSpeed-0 signal `_separateGroundUnits`'s massOf and
      // base-clear's `isMobileEnemy` already use) takes no positional displacement — it can
      // still be damaged, just never dragged off its fixed mount.
      if (!isMobileEnemy(e)) continue;
      const { dx, dy } = computeImpulse(p.x, p.y, radius, strength, sign, e.x, e.y, dt);
      e.x += dx; e.y += dy;
    }
  },

  // #488: has `p.fuse` tripped this frame? 'time' fires once its flight clock reaches
  // `fuse.time` seconds, REGARDLESS of whether it's near anything — a round with nothing to hit
  // still goes off on schedule. 'proximity' fires the instant a valid target (the round's own
  // side's enemy) comes within `fuse.radius`, which can be wider than the normal HIT_RADIUS so it
  // can go off before physically reaching a target.
  _tickFuse(p, dt) {
    const { mode, time, radius } = p.fuse;
    if (mode === 'time') {
      p._fuseElapsed = (p._fuseElapsed ?? 0) + dt;
      return p._fuseElapsed >= time;
    }
    if (mode === 'proximity') {
      if (p.owner === 'enemy') {
        return livePlayersOf(this).some((pl) => Math.hypot(pl.x - p.x, pl.y - p.y) < radius);
      }
      return this.enemies.some((e) => !e.mech.isDestroyed() && Math.hypot(e.x - p.x, e.y - p.y) < radius);
    }
    return false;
  },

  // #488: the fuse's actual detonation — a REAL multi-target blast (data/aoe.js), unlike the
  // normal single-target hit-tolerance splash the impact/landing resolution below uses. Player
  // rounds also catch other players (co-op friendly-fire-on) but never the shooter, same as
  // `_tickTravelAoe`/Shield Burst/Jump Blast.
  _detonateFuse(p) {
    p.dead = true;
    p.stopTrajectorySfx?.();
    const radius = p.fuse.radius || p.splash || 40;
    if (p.owner === 'enemy') {
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, livePlayersOf(this))) {
        this._damagePlayerAt(hit.amount, hit.target, { weaponId: p.weaponId });
      }
    } else {
      const enemies = this.enemies.filter((e) => !e.mech.isDestroyed());
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, enemies)) {
        this._damageEnemyAt(hit.target, hit.target.x, hit.target.y, hit.amount, p.color, false, { weaponId: p.weaponId });
      }
      for (const hit of damageInRadius(p.x, p.y, radius, p.damage, otherLivePlayers(this, p.shooter))) {
        this._damagePlayerAt(hit.amount, hit.target, { weaponId: p.weaponId });
      }
    }
    this._impactFx(p.x, p.y, p.color, p.kind, radius, p.weaponId);
  },

  // #488/#491/#621: a round with `p.hazard` converts, on landing, into a standalone stationary
  // object in `this.hazards` rather than resolving its normal impact. Kinds today:
  //   'mine'  (Timed Charge, shelved #621; also EMP Trap — scenes/arena/abilities.js plants these
  //           directly, bypassing this function entirely since there's no projectile) — arms after
  //           `armDelay`, then waits for a living enemy/player to wander within `radius`,
  //           triggering once — either a real multi-target blast (data/aoe.js) or, if `h.disable`
  //           is set, a DISABLE instead (see `_updateHazards`) — or quietly expires after `life`
  //           seconds if nothing ever wanders in.
  //   'field' (Gravity Well, shelved #621) — arms after `armDelay`, then continuously pulls living
  //           enemies within `radius` (data/force.js) for `life` seconds, then expires with no blast.
  _plantHazard(p) {
    const h = p.hazard;
    this.hazards.push({
      // #491: `caster` — the actual firing entity (an enemy handle for an enemy-owned round,
      // `p.shooter` again for a player-owned one) — so the field's pull loop can exclude the
      // unit that planted it from being dragged toward its own hazard.
      x: p.x, y: p.y, owner: p.owner, shooter: p.shooter, caster: p.caster ?? p.shooter ?? null, kind: h.kind,
      radius: h.radius, color: p.color, weaponId: p.weaponId,
      armIn: h.armDelay ?? 0.25, life: h.life ?? 6,
      damage: h.damage ?? p.damage,
      // Playtest pass (Gravity Well, 2026-07-25): the DRAWN circle can be smaller than the actual
      // pull `radius` — Jackson wants the visual to read as "where things end up" (near the
      // centre, since the pull is strong) rather than depicting the full reach of the field.
      // Defaults to the same value as `radius` for any other 'field' hazard that doesn't opt in.
      visualRadius: h.visualRadius ?? h.radius,
      force: h.force || null,
      // #621: EMP Trap's payload — see `_updateHazards`'s mine branch for what this changes.
      disable: h.disable || null,
      // #626: Tesla Pylons' payload — the static per-weapon numbers (data/weapons.js
      // `linkPylons`, display name "Tesla Pylons"); null/unused for every other hazard kind.
      // `pulseDamage` is a per-tick BUDGET SPLIT among everything in range, not a per-target
      // amount — see `_updatePylons`. (#622/#623/#624 also carried a `pairId` here, the trigger
      // pull that planted the pylon, so the deleted link graph could mesh a volley together;
      // linking is gone, so it is too — nothing else ever read it.)
      pulseDamage: h.pulseDamage ?? null,
      pulseInterval: h.pulseInterval ?? null,
    });
    this._impactFx(p.x, p.y, p.color, p.kind, 10, p.weaponId);
  },

  // Per-frame upkeep for every planted hazard — armed countdown, the mine's proximity check (or
  // the field's continuous pull tick), its own expiry, and its live visual every frame.
  _updateHazards(dt) {
    for (const hz of this.hazards) {
      if (hz.armIn > 0) { hz.armIn -= dt; this._drawHazard(hz); continue; }
      hz.life -= dt;
      if (hz.life <= 0) { hz.dead = true; continue; }
      if (hz.kind === 'mine') {
        // Polish pass: a flying unit (drone/helicopter — `e.flying`, data/enemyKinds.js, the
        // same convention world.js/bases.js use for "ignores ground stuff") is airborne above a
        // ground-planted mine, so it neither triggers one nor takes its blast. Players have no
        // flying state today, so only the enemy side needs the filter — computed once and reused
        // for both the trigger check and the actual damage below.
        const groundEnemies = this.enemies.filter((e) => !e.mech.isDestroyed() && !e.flying);
        const candidates = hz.owner === 'enemy' ? livePlayersOf(this) : groundEnemies;
        const triggered = candidates.some((c) => Math.hypot(c.x - hz.x, c.y - hz.y) < hz.radius);
        if (triggered) {
          hz.dead = true;
          if (hz.owner === 'enemy') {
            for (const hit of damageInRadius(hz.x, hz.y, hz.radius, hz.damage, livePlayersOf(this))) {
              this._damagePlayerAt(hit.amount, hit.target, { weaponId: hz.weaponId });
            }
          } else if (hz.disable) {
            // #621: EMP Trap — a trap-kind hazard applies a DISABLE instead of the normal mine
            // blast. Reuses `damageInRadius` purely as the "who's actually within `radius`" filter
            // (the damage amount it would compute is unused) so this rides the exact same
            // arm/trigger/team-exemption pipeline as a real mine — including the team-exemption
            // just below: only ground ENEMIES are ever candidates for a player-owned hazard
            // (`groundEnemies`, computed above), so no live player — caster included — is ever at
            // risk of triggering or eating their own trap.
            for (const hit of damageInRadius(hz.x, hz.y, hz.radius, 0, groundEnemies)) {
              this._disableEnemy?.(hit.target, hz.disable.duration);
            }
          } else {
            for (const hit of damageInRadius(hz.x, hz.y, hz.radius, hz.damage, groundEnemies)) {
              this._damageEnemyAt(hit.target, hit.target.x, hit.target.y, hit.amount, hz.color, false, { weaponId: hz.weaponId });
            }
            // #488: a player-owned mine is TEAM-exempt, not just placer-exempt — a co-op
            // teammate walking near a mine their partner planted must not eat its blast, so
            // unlike every other player-fired hazard/splash in this file (which only excludes
            // the shooter via otherLivePlayers), a mine excludes every live player outright.
            // (Formerly: for (const hit of damageInRadius(hz.x, hz.y, hz.radius, hz.damage,
            // otherLivePlayers(this, hz.shooter))) this._damagePlayerAt(...) — deliberately removed.)
          }
          // #582: a mine going off is an EXPLOSION, so it asks for the explosive burst by name
          // rather than borrowing the in-flight round's own kind. The charge is thrown as a
          // `plasma`-art round, and that used to reach the orange fireball anyway (the old branch
          // order sent anything with a blast radius there first); now that `_impactFx` reads kind
          // before splash, passing 'plasma' through would turn a 55px mine blast into a plasma
          // splatter. The detonation's look belongs to the hazard, not to the round that planted it.
          this._impactFx(hz.x, hz.y, hz.color, 'missile', hz.radius, hz.weaponId);
          continue;
        }
      } else if (hz.kind === 'field' && hz.force) {
        // Playtest pass (2026-07-25): "make the pull more smooth instead of jerky." This used to
        // apply a quarter-second's worth of displacement in one lump every 250ms — 15 idle frames
        // between each visible nudge at 60fps. Applying the same total impulse continuously, every
        // frame at its own real `dt`, gives the identical net pull over time but reads as a smooth
        // drift instead of a stutter-step.
        for (const e of this.enemies) {
          if (e.mech.isDestroyed()) continue;
          // #491 playtest fix (Jackson: "gravity charge or whatever shouldn't pull stationary
          // units like turrets off of their positions") — same `isMobileEnemy` exclusion as
          // `_tickTravelForce` above; a turret/wallTurret takes the field's damage/status like
          // anything else, it just never gets dragged.
          if (!isMobileEnemy(e)) continue;
          // #491 follow-up (Jackson found live): an enemy mech mounted with Gravity Well pulled
          // ITSELF — the caster is a living, mobile enemy sitting in this same `this.enemies`
          // list its own field pulls, so without this it dragged itself toward its own hazard's
          // centre. Exclude the hazard's own caster from the pull, same as the stationary-unit
          // exclusion just above.
          if (hz.caster && e === hz.caster) continue;
          // #543 (Jackson: "the gravity well visual and effect [should] be blocked by hard
          // cover in that section of the arc"): a wall/destructible hex between the field's own
          // centre and this enemy blocks the pull exactly like it blocks sight — same raycast
          // (`_wallDistanceLos`) every other cover check in this codebase already shares.
          if (this._fieldCoverBlocksPull(hz, e.x, e.y)) continue;
          const { dx, dy } = computeImpulse(hz.x, hz.y, hz.radius, hz.force.strength, hz.force.sign, e.x, e.y, dt);
          e.x += dx; e.y += dy;
        }
      }
      this._drawHazard(hz);
    }
    if (this.hazards.some((hz) => hz.dead)) this.hazards = this.hazards.filter((hz) => !hz.dead);
    this._updatePylons(dt);   // #626: Tesla Pylons' independent per-tower proximity zap
  },

  // #626: TESLA PYLONS — each planted pylon is an INDEPENDENT proximity-zap tower. Nothing links
  // any more: #622/#623/#624's field-wide link graph (the greedy bounded-degree matching, the
  // per-pylon link cap, the max link range, the accepted-pairs list and its per-volley recompute
  // detection) and the pylon-to-pylon connecting lines it drew are all deleted. What survives from
  // that lineage is exactly what was still correct — the per-hazard arm/life/expiry machinery
  // (`_updateHazards` above) and the pylon node visual (`_drawHazard`).
  //
  // Every live, ARMED pylon runs its own pulse clock (`hz.pulseIn`, lazily started the first frame
  // it's armed) and on each tick zaps every live enemy within its OWN `radius` — a plain
  // point-radius test now, no line-segment math. FLYERS INCLUDED, unlike every other hazard kind
  // (#626 playtest: "can tesla hit air units? because it SHOULD be able to") — see the candidate
  // filter below for why an arcing tower is the one case the flying exemption doesn't fit.
  //
  // `pulseDamage` is a per-tick BUDGET SPLIT EVENLY among whoever is standing in the ring, NOT a
  // per-target amount (Jackson, #626: "keep total damage per tick consistent and just spread it
  // among the available targets"). One enemy in range eats the whole budget; five eat a fifth
  // each; nobody in range means no zap at all that tick. The self-balancing consequence is
  // deliberate and must not be "fixed": a single tower can never out-damage its own budget however
  // many enemies crowd it, while several towers placed over time each carry a full budget of their
  // own — stacking overlapping towers is how this weapon is meant to scale up.
  _updatePylons(dt) {
    const now = this.time.now;
    for (const hz of this.hazards) {
      if (hz.kind !== 'pylon' || hz.dead || hz.armIn > 0) continue;

      // Redraw this pylon's most recent zap for `PYLON_ZAP_HOLD` after it fired — same `drawBeam`
      // primitive the deleted links used, now pylon->enemy. Endpoints are snapshotted at pulse
      // time rather than tracked live: over ~0.14s a target barely moves, and a static arc reads
      // as a discharge that already happened instead of a beam that follows you around.
      if (hz.zapFor > 0) {
        hz.zapFor -= dt;
        for (const z of hz.zapTo || []) drawBeam(this.groundFx, hz.x, hz.y, z.x, z.y, hz.color, 1, false, now, 1, 0);
      }

      const interval = hz.pulseInterval ?? 0.5;
      hz.pulseIn = (hz.pulseIn ?? interval) - dt;
      if (hz.pulseIn > 0) continue;
      hz.pulseIn += interval;

      // #626 playtest follow-up (Jackson: "can tesla hit air units? because it SHOULD be able to").
      // Flyers are NOT exempt here, deliberately unlike the mine branch's `!e.flying` filter in
      // `_updateHazards`. That exemption is about a ground-planted BLAST, which has no business
      // catching something flying over it — but an electric arc reaching UP off a tower is exactly
      // the thing that should. This is the one hazard kind where the flying rule doesn't apply.
      const candidates = hz.owner === 'enemy'
        ? livePlayersOf(this)
        : this.enemies.filter((e) => !e.mech.isDestroyed());
      const inRange = candidates.filter((c) => Math.hypot(c.x - hz.x, c.y - hz.y) < hz.radius);
      if (inRange.length === 0) continue;

      const each = (hz.pulseDamage ?? 0) / inRange.length;
      hz.zapTo = inRange.map((c) => ({ x: c.x, y: c.y }));
      hz.zapFor = PYLON_ZAP_HOLD;
      for (const c of inRange) {
        drawBeam(this.groundFx, hz.x, hz.y, c.x, c.y, hz.color, 1, false, now, 1, 0);
        if (hz.owner === 'enemy') this._damagePlayerAt(each, c, { weaponId: hz.weaponId });
        else this._damageEnemyAt(c, c.x, c.y, each, hz.color, false, { weaponId: hz.weaponId });
        // One flash per TARGET (#624 flashed one per link segment): the zap lands on the enemy,
        // so that's where the discharge should read from.
        this._impactFx(c.x, c.y, hz.color, 'beam', 0, hz.weaponId);
      }
    }
  },

  // #543 (Jackson: "the gravity well visual and effect [should] be blocked by hard cover in
  // that section of the arc"): does a wall/destructible hex sit between the field's own centre
  // and the point being pulled? Same raycast every other cover check in this file already uses
  // (`_wallDistanceLos`, world.js) — `!== Infinity` means something blocked it before reaching
  // the target. Optional-chained the same way `_computePlayerSight` guards it: a hand-rolled
  // scene double without WorldMixin (most of this file's tests) just never blocks.
  _fieldCoverBlocksPull(hz, tx, ty) {
    if (!this._wallDistanceLos) return false;
    const dx = tx - hz.x, dy = ty - hz.y;
    const d = Math.hypot(dx, dy);
    if (d <= 1) return false;
    return this._wallDistanceLos(hz.x, hz.y, Math.atan2(dy, dx), d, tx, ty) !== Infinity;
  },

  // #543: which of the field's `FIELD_VIS_SAMPLES` angular slices — sampled at the drawn
  // `vr` (visual) radius, all the way around the circle like a fog-of-war vision wedge but for
  // the full 360° — have a clear line back to the hazard's own centre. Cached on the hazard
  // object and recomputed on the same staggered LOS_REFRESH_MS cadence (world.js) every other
  // per-frame raycast cache in this file uses, with a random first-touch phase (same trick as
  // `_playerSightClear`) so a batch of fields planted on the same frame doesn't all recompute
  // together. Dies with the hazard; no separate bookkeeping needed.
  _fieldVisMask(hz, vr) {
    const now = this.time.now;
    if (hz._visMask === undefined || now >= hz._visNextAt) {
      hz._visNextAt = now + (hz._visMask === undefined ? Math.random() * LOS_REFRESH_MS : LOS_REFRESH_MS);
      hz._visMask = this._computeFieldVisMask(hz, vr);
    }
    return hz._visMask;
  },

  _computeFieldVisMask(hz, vr) {
    const mask = new Array(FIELD_VIS_SAMPLES);
    for (let i = 0; i < FIELD_VIS_SAMPLES; i++) {
      const a = (i / FIELD_VIS_SAMPLES) * Math.PI * 2;
      const tx = hz.x + Math.cos(a) * vr, ty = hz.y + Math.sin(a) * vr;
      mask[i] = !this._wallDistanceLos || this._wallDistanceLos(hz.x, hz.y, a, vr, tx, ty) === Infinity;
    }
    return mask;
  },

  // Live visual for one planted hazard, drawn into `groundFx` (already cleared/redrawn this frame
  // by `_updateFirePatches`, which now runs first — see the call-order comment in
  // ArenaScene.update). A mine reads as a small pulsing warning light; a field reads as a
  // swirling dark-purple pull orb — a few dots orbiting the center, faster the longer it's lived.
  // #525 (playtest: "z-order of placed mines is too high"): this used to draw into `projFx`
  // (DEPTH.PROJECTILES, above every unit) — a mine sitting on the ground rendered OVER the player
  // and enemy mechs standing on top of it, same root cause #99 already fixed once for napalm's
  // burning-ground patch (see the DEPTH.GROUND_FX comment in shared.js and `_updateFirePatches`
  // below). A planted hazard is ground-level exactly like that patch, so it moves to the same
  // `groundFx` layer (DEPTH.GROUND_FX) for the same reason.
  _drawHazard(hz) {
    const g = this.groundFx;
    const now = this.time.now;
    if (hz.kind === 'mine') {
      // #488: player-placed mines keep the original warm orange-red warning-light color;
      // an enemy-placed mine (none exist yet, but the branch already reasons about
      // `hz.owner === 'enemy'` elsewhere in this file) gets a distinct cold cyan-teal so the
      // two are never confusable at a glance, in the same "warning light" idiom.
      // #621: an EMP Trap (`hz.disable` set) gets its own bright electric-blue warning light
      // instead — same pulsing "warning light" idiom, distinct at a glance from both a real
      // player mine and an enemy one.
      const mineColor = hz.disable ? EMP_TRAP_COLOR : (hz.owner === 'enemy' ? 0x33e6ff : 0xff5533);
      // #628: the pulse itself moved to `drawMineNode` (art/abilityFx.js) unchanged — same two
      // draw calls, same numbers, called here at scale 1 — so the garage's EMP Trap card can stamp
      // the real node visual rather than a lookalike. Nothing about the arena's look changed.
      drawMineNode(g, hz.x, hz.y, hz.radius, mineColor, now);
    } else if (hz.kind === 'field') {
      const t = now / 1000;
      // Playtest pass: the drawn orb uses `visualRadius` (defaults to the real pull `radius` for
      // any hazard that doesn't tune it) — Gravity Well's is deliberately much smaller than its
      // actual pull reach, so the orb reads as the landing zone the pull drags things INTO rather
      // than the whole area it reaches out to grab from.
      const vr = hz.visualRadius ?? hz.radius;
      // #543: draw the fill+ring one angular slice at a time instead of one full circle, and
      // simply skip any slice whose sampled ray back to the hazard's own centre is blocked —
      // the ring visibly cuts off on the far side of cover instead of sitting untouched next to
      // a wall while nothing on that side is actually reachable by the pull.
      const mask = this._fieldVisMask(hz, vr);
      const step = (Math.PI * 2) / FIELD_VIS_SAMPLES;
      for (let i = 0; i < FIELD_VIS_SAMPLES; i++) {
        if (!mask[i]) continue;
        const a0 = i * step, a1 = a0 + step;
        g.beginPath();
        g.arc(hz.x, hz.y, vr, a0, a1, false);
        g.lineTo(hz.x, hz.y);
        g.closePath();
        g.fillStyle(0x2a0845, 0.16);
        g.fillPath();
        g.beginPath();
        g.arc(hz.x, hz.y, vr, a0, a1, false);
        g.lineStyle(1.5, 0x8a2be2, 0.45);
        g.strokePath();
      }
      for (let i = 0; i < 3; i++) {
        const a = t * 2.4 + (i * Math.PI * 2) / 3;
        // #543: an orbiting dot currently swinging through a blocked slice doesn't draw this
        // frame either — it reads as ducking behind the cover rather than floating in front of it.
        const wrapped = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const sample = Math.floor(wrapped / step) % FIELD_VIS_SAMPLES;
        if (!mask[sample]) continue;
        const r = vr * 0.55;
        g.fillStyle(0x9a4bf0, 0.85).fillCircle(hz.x + Math.cos(a) * r, hz.y + Math.sin(a) * r * 0.7, 5);
      }
    } else if (hz.kind === 'pylon') {
      // #622: a single pylon node — a crackling ring around a bright core, using the hazard's
      // own colour (the lightning category's electric blue). Kept unchanged through #626's
      // rework: the node IS the tower, and it reads as "armed and waiting" on its own. The zap
      // arcs out to whatever it's shocking are a separate draw (`_updatePylons`), only present
      // for a beat after each pulse that actually found a target.
      const pulse = 0.5 + 0.5 * Math.sin(now / 110);
      g.lineStyle(1.5, hz.color, 0.35 + pulse * 0.45).strokeCircle(hz.x, hz.y, 8 + pulse * 3);
      g.fillStyle(hz.color, 0.9).fillCircle(hz.x, hz.y, 4);
    }
  },

  // #489 playtest follow-up: "should somehow give a visual that an enemy is coated" — a burning-
  // green flicker over any enemy currently carrying the plasmaBurn status effect (data/
  // statusEffects.js), so the DoT is visibly happening, not just a number ticking off-screen.
  // Drawn into `projFx` after `_updateProjectiles` has already run this frame (status effects
  // tick in `_updateEnemies`, earlier in ArenaScene.update, so this always reads THIS frame's
  // live set).
  // 2026-07-31: reworked from a floating green pulse-circle-at-centre-point into a per-part purple
  // "coating" outline that hugs the mech's own body, reusing the shield outline's technique
  // (shieldOutline.js's `updateDotOutline` — see its header note for the full rationale). Runs for
  // BOTH enemies (as before) and, since #560 made DoT symmetric, every live PLAYER too — an
  // enemy's plasma weapon can burn a player, and they deserve the same readout an enemy gets.
  // `delta` (ms, same value every other per-frame outline driver in the game takes) drives the
  // pulse; the outline set itself is built lazily per unit (`_ensureEnemyDotVisual`/
  // `_ensureDotVisualFor`) the first frame it's actually needed, mirroring the shield outline's
  // own perf story.
  _drawStatusEffects(delta) {
    const isBurning = (mech) => (mech?.statusEffects || []).some((s) => s.kind === 'plasmaBurn');
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const sv = this._ensureEnemyDotVisual(e);
      const burning = isBurning(e.mech);
      updateDotOutline(sv, e.view, burning, delta);
      updateDotTint(sv, e.view, burning);
    }
    for (const player of livePlayersOf(this)) {
      const sv = this._ensureDotVisualFor(player);
      const view = player.view ?? this.playerView;
      const burning = isBurning(player.mech);
      updateDotOutline(sv, view, burning, delta);
      updateDotTint(sv, view, burning);
    }
  },

  // #568: single-pass cache sync for `_updateProjectiles`'s per-frame own-hex transparency Sets
  // and the enemy spatial index. Stamps each live player/enemy's current hex key onto the entity
  // itself (`_pjHexKey`) and compares against what was stamped last frame — if every entity's hex
  // is unchanged AND the live enemy count is unchanged (nothing spawned or died), the previously
  // built Sets/index are still exactly correct and this is a no-op past the comparison scan. Only
  // a genuine change (a unit crossed a hex boundary, or the roster changed) pays for fresh Set/Map
  // allocations. A brand-new player/enemy object (fresh sortie, new spawn) has no `_pjHexKey` yet,
  // so it always compares unequal on its first tick — the cache is never stale across a scene
  // reset without needing an explicit clear here.
  _syncProjFrameCache() {
    let changed = !this._projPlayerTransparent || !this._projEnemyTransparent || !this._projEnemyIndex;
    const players = livePlayersOf(this);
    for (const pl of players) {
      const k = this._hexKeyAt(pl.x, pl.y);
      if (pl._pjHexKey !== k) { pl._pjHexKey = k; changed = true; }
    }
    let liveCount = 0;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      liveCount++;
      const k = this._hexKeyAt(e.x, e.y);
      if (e._pjHexKey !== k) { e._pjHexKey = k; changed = true; }
    }
    if (liveCount !== this._projCachedLiveCount) { this._projCachedLiveCount = liveCount; changed = true; }
    if (!changed) return;
    const playerTransparent = new Set();
    for (const pl of players) playerTransparent.add(pl._pjHexKey);
    const enemyTransparent = new Set();
    for (const e of this.enemies) if (!e.mech.isDestroyed()) enemyTransparent.add(e._pjHexKey);
    this._projPlayerTransparent = playerTransparent;
    this._projEnemyTransparent = enemyTransparent;
    this._projEnemyIndex = this._buildEnemyIndex();
  },

  // #168: a coarse uniform-grid spatial index over the living enemies. #568: rebuilt only when
  // `_syncProjFrameCache` above detects an actual hex change/roster change, not unconditionally
  // every frame. `nearest(x, y)` returns the closest living enemy to a point — the EXACT same result the old
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
    // #639: a HIGH kind (missiles) draws its BODY above the units, but its arc shadow stays on the
    // low layer with everything else — the shadow belongs to the ground it's cast on, and lifting
    // it above the mech it passes over would be a worse artifact than the one this fixes.
    const g = this.projFx;
    const body = (HIGH_PROJECTILE_KINDS.has(p.kind) && this.projFxHigh) || g;
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
      // 2026-08-02 (Jackson: "I'm not seeing the arc shadow at all, was there supposed to be one?
      // def would look nice if it could have one"). There was code for one, and it could never
      // have been visible: it drew a ≤8×3.4px ellipse at EXACTLY `p.x, p.y` — the same point the
      // round body draws at, a frame-order moment later into the same graphics — so the sprite
      // (~13px of missile plus its flame) sat right on top of it. It also SHRANK and faded as the
      // round climbed, so at apex, where a shadow should read most, it was smallest and faintest.
      //
      // Something has to move for a shadow to exist at all, and #57 pinned the ROUND ("no vertical
      // offset, no pitch" — it stays on its true ground position). So the SHADOW moves: it slides
      // away along a fixed screen light direction in proportion to height, which is what actually
      // sells the loft, and it grows and darkens slightly rather than vanishing. At h=0 (muzzle and
      // impact) the offset is 0, so the round still meets its shadow exactly where it leaves the
      // ground and where it lands — the two moments where a lie would be visible.
      const lift = h * SHADOW_MAX_OFFSET;
      const grow = (1 + h * SHADOW_GROW) * (p.scale || 1);
      g.save();
      g.translateCanvas(p.x + SHADOW_DIR_X * lift, p.y + SHADOW_DIR_Y * lift);
      g.rotateCanvas(p.angle);                                // lie ALONG the round, not under it
      g.fillStyle(0x000000, SHADOW_ALPHA);
      g.fillEllipse(0, 0, SHADOW_LEN * grow, SHADOW_WID * grow);
      g.restore();
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
    drawProjectileBody(body, p.x, p.y, p.angle, p.kind, p.color, scale * (p.scale || 1), p.dist, foreshorten);
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
    for (const b of this.beams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age, 1, b.coneDeg || 0, b.fullLen || 0);
    for (const b of this.dyingBeams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age + b.fadeAge, 1 - b.fadeAge / b.fadeTtl, b.coneDeg || 0, b.fullLen || 0);
  },

  // #536: Plasma Coater's dot (delivery.dot) also ignites the destructible cover/building hex a
  // bolt hits DIRECTLY (instead of a living target) — a lightweight PER-HEX burn tracked in
  // `buildingBurns`, ticking the SAME duration/tickDamage/tickInterval numbers the round's own
  // unit-side DoT carries (data/weapons.js's plasmaCoater config: 4s, 5dmg/tick, every 1s) —
  // there's no separate "building burn" dial to invent, the hex just burns at the rate the round
  // would coat a living target with. Applied straight through `_damageBuildingAt` rather than the
  // Mech/HpBody status-effect system, since a hex isn't a unit and has no statusEffects array.
  // Re-igniting an already-burning hex refreshes its remaining time rather than stacking a second
  // timer — the same "refresh, never stack" rule `applyStatusEffect` uses for units (#489).
  _igniteBuildingHex(p, x, y) {
    if (!p.dot) return;
    const k = this._hexKeyAt(x, y);
    if (!this.coverHp.has(k) && !this.buildingHp.has(k)) return;
    const { duration, tickDamage, tickInterval = 1 } = p.dot;
    const until = this.time.now + duration * 1000;
    const nextTick = this.time.now + tickInterval * 1000;
    const existing = this.buildingBurns.find((b) => b.key === k);
    if (existing) {
      existing.until = until;
      existing.nextTick = nextTick;
      existing.tickDamage = tickDamage;
      existing.tickInterval = tickInterval;
      existing.x = x;
      existing.y = y;
    } else {
      this.buildingBurns.push({ key: k, x, y, until, nextTick, tickDamage, tickInterval });
    }
  },

  // #536: tick every hex `_igniteBuildingHex` planted a burn on — same shape as the fire-patch
  // cover tick below, just scoped to the single hex Plasma's bolt actually hit (a coating, not an
  // AoE cloud) — and drawn with the same green pulse `_drawStatusEffects` uses for a burning
  // enemy, so a burning building reads as "the same plasma fire" rather than a new effect.
  // Drawn into `groundFx`, already cleared this frame by `_updateFirePatches` (which calls this
  // at its own end, same low ground-decal layer napalm's patches use).
  _updateBuildingBurns() {
    const now = this.time.now;
    const g = this.groundFx;
    for (const b of this.buildingBurns) {
      if (now >= b.nextTick) {
        b.nextTick += b.tickInterval * 1000;
        this._damageBuildingAt(b.x, b.y, b.tickDamage);
      }
      const pulse = 0.5 + 0.5 * Math.sin(now / 110);
      g.fillStyle(0x39ff6a, 0.18 + pulse * 0.12).fillCircle(b.x, b.y, 16 + pulse * 4);
      if (now >= b.until) b.dead = true;
    }
    if (this.buildingBurns.some((b) => b.dead)) this.buildingBurns = this.buildingBurns.filter((b) => !b.dead);
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
    this._updateBuildingBurns();   // #536: Plasma-ignited building/cover hexes, same ground layer
  },
};
