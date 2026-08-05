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
import { CONVERGE_DIST, TARGET_CONE, aimAngleOffset, convergedFireAngle, pickConvergeTarget } from './shared.js';
import { TARGETING_RANGE } from '../../data/targetingRange.js';
import { playersOf, primaryPlayerOf } from './players.js';

// #620/#642: the aim-assist CEILING, expressed as a fraction of the targeting cone (applied in
// `_fireAngle` below). A converge target only exists while it's inside `TARGET_CONE` (shared.js, a
// 20° HALF-angle), so the largest gap that can ever be scaled is 20° and the maximum correction is
// exactly AIM_ASSIST_STRENGTH × 20°:
//   0.15 -> up to 3°   (#620's original: real, but under the noise floor of a moving fight)
//   0.30 -> up to 6°   (current, 2026-08-02: "dial aim assist back down to like 6 degrees")
//   0.60 -> up to 12°  (the intermediate step, used to see the effect at all before settling)
//   1.00 -> up to 20°  (full soft-lock: the limbs point at anything inside the cone)
// Deliberately no DISTANCE falloff: same convention as every other feel dial. Note it does NOT
// compound across frames — it's a fraction of the LIVE gap recomputed every frame, not an
// accumulating pull.
//
// #642 changed what this constant governs. It used to be the flat blend fraction itself — 30% of
// the gap closed whether you were 2° off or 20° off — so "how close you already are" had no effect
// on how hard the assist pulled, and it would yank you toward something 18° away you were never
// aiming at. It is now the PEAK of a curve (below) rather than the whole of it, and the ceiling it
// defines is unchanged: 0.3 × 20° = 6.0° maximum correction, same as before.
const AIM_ASSIST_STRENGTH = 0.3;

// #642: the sharpness of the near-centre-strong / edge-weak falloff — console "sticky aim". The
// blend fraction is `(1 - n^AIM_ASSIST_FALLOFF)` over the normalised gap `n = |gap| / TARGET_CONE`
// (0 dead-on, 1 at the cone edge), rescaled so the resulting correction peaks at exactly the
// AIM_ASSIST_STRENGTH ceiling. Strong where you have basically acquired the target and already
// just need to settle; zero at the cone edge, where the pull was never help in the first place.
//
// FELT MEANING of raising/lowering it, at the current 0.3 ceiling:
//   1.5 -> 92% of the gap closed near centre; very magnetic settle, collapses hard past ~15°
//   2   -> 78% near centre (current default); firm settle that still leaves you ~a fifth of the
//          gap to steer yourself, and halves the old pull on an 18°-off target (5.4° -> 2.7°)
//   3   -> 64% near centre; the strong band spreads wider across the mid-cone and the collapse
//          happens later, i.e. closer to the old flat feel
// Lower = snappier and more forgiving up close, deader at the edge. Higher = flatter, more like
// the old constant fraction. Don't go below ~1.2: the rescale would push the near-centre fraction
// past 1.0 and the limbs would point PAST the target (the `Math.min(1, …)` in `_fireAngle` guards
// this, but a curve that needs the guard is a curve that's mis-tuned).
const AIM_ASSIST_FALLOFF = 2;

// Normalisation for the above, computed once at load so the tuning dial can never move the 6°
// ceiling as a side effect. `n · (1 - n^p)` peaks at n = (1/(p+1))^(1/p); dividing by that peak
// makes the curve's own maximum correction land on AIM_ASSIST_STRENGTH × TARGET_CONE for ANY
// exponent. With p = 2 the peak sits at n ≈ 0.577 (an 11.5° gap) and the near-centre fraction
// works out to ≈ 0.779.
const ASSIST_PEAK_N = Math.pow(1 / (AIM_ASSIST_FALLOFF + 1), 1 / AIM_ASSIST_FALLOFF);
const ASSIST_CENTER_FRACTION =
  AIM_ASSIST_STRENGTH / (ASSIST_PEAK_N * (1 - Math.pow(ASSIST_PEAK_N, AIM_ASSIST_FALLOFF)));

// ── #637: PROJECTILE LEADING ──────────────────────────────────────────────────────────────────
// A non-tracking round has flight time, so aiming it at where the target IS lands it behind by
// `targetSpeed × flightTime`. Measured against the fastest ground chassis (light enemy mech,
// 268 px/s) at max range that is 179px for the Repeater — about four hex widths. `_fireAngle`
// below now aims those weapons at where the target WILL BE.
//
// This is its OWN dial, deliberately not scaled off AIM_ASSIST_STRENGTH: assist and lead answer
// different questions (assist = which point am I aiming at, lead = where will that point be), so
// tuning one must not move the other. It is also its own player-facing toggle (`projectileLead`,
// data/pauseSettings.js) rather than riding on `aimAssist`, and it is NOT gamepad-gated — leading
// is the gun aiming correctly, not a helper, so mouse gets it too.
//
// FELT MEANING of raising/lowering it:
//   0    -> off; every non-tracking round is fired at the target's current position (pre-#637)
//   0.5  -> aims half way to the intercept point: a crossing target is still missed, by half as
//           much, so hitting one remains a manual-lead skill and the gun only nudges you
//   1    -> FULL lead (current default): a round fired at a target holding its course connects.
//           The intercept is exact only while the target keeps its velocity — a mech that turns,
//           stops or is knocked back still makes the shot miss, so this is not an aimbot; it is
//           the difference between "the gun is wrong" and "the target dodged".
//   >1   -> overlead; the shot lands AHEAD of the target. No reason to want this.
//
// LIMB ART. `_partTilt` is `fireAngle − turretAngle`, so the arms and shoulders visibly swing onto
// the lead with no art change — which is wanted, and is bounded rather than wild. For a target
// crossing at speed `s` against a round of speed `u` the lead angle is atan(s·t / d) with
// t = d/u, i.e. atan(s/u) — INDEPENDENT OF RANGE, so it can't blow up at point-blank the way a
// naive "offset ÷ distance" would. Against the fastest ground chassis (268 px/s) that ceiling is
// 28° (Repulsor Pulse, the slowest leading round) down to 13° (Cluster Salvo, the fastest), and it
// only applies at all while something is locked inside the 20° targeting cone. It also goes to
// zero continuously as a target slows, and the DRAWN tilt is exponentially smoothed on top
// (locomotion `_syncTilts`), so a target reversing direction sweeps the limbs rather than snapping
// them. The FIRE angle itself is deliberately unsmoothed — the shot has to be right when it leaves.
const LEAD_STRENGTH = 1;

// The flight-time ceiling, in SECONDS, above which a weapon does not lead at all. Expressed as a
// threshold on `range.max / delivery.velocity` rather than a hardcoded list of weapon ids, so a
// future slow weapon is covered the day it is added.
//
// A long flight time makes a "correct" lead both enormous and worthless: it swings the limbs to an
// extreme angle and is wrong the instant the target changes direction, which it certainly will
// over multiple seconds. The live weapons sit in two well-separated clusters, which is where this
// number comes from — the six that lead run 0.38s (Repulsor Pulse) to 1.07s (Plasma Lance), and
// the two that must not are Flamethrower at 2.61s and Caustic Lobber at 6.92s. 1.5 sits in the
// middle of that gap with room on both sides, so ordinary retuning of any of the eight can't
// silently flip which cluster it lands in.
const MAX_LEAD_FLIGHT_SECONDS = 1.5;

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
      // #337 v2 / #460: the fog's per-enemy rule, TARGETING half. Live, `_enemyLockable` is ALWAYS
      // the branch taken (the mixin is unconditional); the `enemyTargetable` fallback survives only
      // for scene doubles in tests that predate the fog. "Nobody targets what they can't see —
      // player and enemies alike" (Jackson chose "Full parity"), plus #460's hard-cover raycast, so
      // the reticle can never grab something a shot would splash on stone. Note this is the STRICTER
      // of the two gates: `_enemyPerceivable` (what gets DRAWN) is deliberately laxer — a ground
      // unit behind a boulder is still on screen, it just cannot be locked. Do not swap them.
      && (this._enemyLockable ? this._enemyLockable(e)
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
    // #483: a STATIC pick (destructible hex / wall span) gets described for the top-left target
    // readout — texture, name and live HP — attached onto the pick itself so the pure HUD snapshot
    // can draw it. Enemy picks carry `.mech` and are shaped by the snapshot directly.
    if (player.convergeTarget && !player.convergeTarget.mech) {
      this._describeStaticTarget?.(player.convergeTarget);
    }

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
    // #421 legibility: a dark backing pass under the brackets + ring, drawn slightly wider,
    // so the thin reticle lines hold contrast on light ground (snow/sand) as well as dark.
    const back = this.projFx.lineStyle(4, 0x14161a, 0.5);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * r, cy = y + sy * r;
      back.lineBetween(cx, cy, cx - sx * len, cy);
      back.lineBetween(cx, cy, cx, cy - sy * len);
    }
    this.projFx.lineStyle(3.5, 0x14161a, 0.45).strokeCircle(x, y, r + 4);
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
  // Two angular offsets ride on top of whichever regime applies, both derived from the same
  // `convergeTarget`: #620/#642's AIM ASSIST (pad only, toward where the target is) and #637's
  // LEAD (player only, non-tracking projectiles only, toward where the target will be).
  // #348: `player` is whose weapon this is — its own turret facing and its own converge pick.
  _fireAngle(w, m, player = primaryPlayerOf(this)) {
    const d = w.weapon.delivery;
    // #620 aim assist, relocated here 2026-08-02 (Jackson: "aim assist feels like it is turning
    // the whole turret instead of pivoting arms/shoulders only"). It used to be blended into the
    // raw stick `aim` in locomotion `_drive`, one line above the turret slew, so it swung the
    // whole turret and the limbs only came along for the ride. Applying it to the FIRE ANGLE
    // instead puts it on exactly the axis the arms and shoulders already pivot on: `_partTilt`
    // is defined as `fireAngle - turretAngle`, so every degree of assist becomes a degree of
    // limb toe-in, and the turret tracks the stick untouched. One offset, both regimes below,
    // and the art follows for free because `_partTilt` calls straight back into this method.
    //
    // Computed INLINE rather than as a `this._…` sibling helper on purpose: BaseScene
    // cherry-picks exactly `{ _fireAngle, _lockAimPoint }` off this mixin (see its comment), so a
    // sibling-method dependency is a runtime TypeError in the base the moment it's added — which
    // is precisely what happened on the first attempt. Keep this method self-contained.
    // Gates, all unchanged from #620/#629: a live converge target, gamepad input
    // (`player.inputMode`, stamped per player each frame in locomotion `_drive` — mouse aiming is
    // precise enough not to want help), and the player-facing ON/OFF preference, read LIVE off the
    // registry every call so the pause-menu row and D-pad bind are felt on the very next frame
    // (`!== false` because it defaults ON). In the base, `convergeTarget` is never set at all, so
    // this is always 0 there — the same "nothing locked" behaviour the base already had.
    //
    // #637 removed the fourth gate that used to sit here (`noLeadYet`). It excluded every
    // non-tracking projectile from the assist, because the assist pulls toward where the target IS
    // and so dragged the player OFF whatever lead they had applied by hand. Now that those same
    // weapons genuinely lead (below), the assist is correct for them and the exclusion would be
    // the thing making them feel bad — so they are back on the ordinary three gates.
    const t = player.convergeTarget;
    let assist = 0;
    if (t && player.inputMode === 'pad' && this.registry.get('aimAssist') !== false) {
      // #642: the blend fraction is a function of how close the turret already is, not a flat 30%.
      // `aimAngleOffset` (shared.js) is the signed gap and is wrap-safe across the ±π seam — a raw
      // numeric subtraction of two angles is not, so don't inline arithmetic here.
      const gap = aimAngleOffset(player.x, player.y, player.turretAngle, t.x, t.y);
      // 0 = dead on the target, 1 = out at the cone edge. Clamped because the target was picked in
      // `_updateLock` against the turret angle of THAT moment; by the time a weapon asks for its
      // fire angle the turret has slewed and the target has moved, so the gap can sit a hair
      // outside TARGET_CONE. Unclamped, `1 - n^p` would go NEGATIVE there and the assist would push
      // the limbs AWAY from the target.
      const n = Math.min(1, Math.abs(gap) / TARGET_CONE);
      // Strongest near centre, zero at the edge. `Math.min(1, …)` is a guard, not a shape: the
      // fraction must never exceed 1 or the limbs would swing PAST the target (see the note on
      // AIM_ASSIST_FALLOFF). At the default exponent the curve peaks at 0.779, so it never fires.
      const fraction = Math.min(1, ASSIST_CENTER_FRACTION * (1 - Math.pow(n, AIM_ASSIST_FALLOFF)));
      assist = gap * fraction;
    }

    // #637 LEADING. A second angular offset, on the same axis and from the same target, added on
    // top of the assist. Computed INLINE for exactly the reason spelled out above — BaseScene
    // cherry-picks `_fireAngle` off this mixin, so a `this._helper()` sibling would be a runtime
    // TypeError there. Keep it self-contained.
    //
    // HOW THE TWO COMPOSE (and why they don't cancel). The assist is measured from the TURRET:
    // `assist = f × (targetBearing − turretAngle)`, a fraction of the way onto the target. The
    // lead is measured from the TARGET: `lead = leadBearing − targetBearing`, i.e. purely "how far
    // ahead of the target do I have to point", independent of where the turret currently is. Their
    // sum is therefore `turretAngle + f×gap + leadDelta` — the assist decides which point you are
    // aiming at, the lead then displaces that point to where it will be. With the assist off (or
    // on mouse) the full lead still applies to the raw turret bearing, which is the correctness
    // fix; with the assist at full strength the muzzles sit exactly on the intercept point.
    //
    // Gates:
    //  • A live converge target that is actually MOVING. Destructible hexes and wall spans carry no
    //    `vx`/`vy` at all, so terrain yields zero lead naturally, with no special case.
    //  • PLAYER ONLY (deliberate asymmetry in the player's favour — enemy fire keeps aiming at
    //    where the player is). `_fireAngle` is the shared fire-angle entry point, so this asks
    //    whether the shooter is one of the scene's own players rather than assuming it.
    //  • The weapon class: `hit: 'projectile'`, not homing (the round steers itself), not arcing
    //    (a lob resolves a travel DISTANCE rather than bending a launch angle — a different solve,
    //    left alone on purpose). Hitscan needs nothing; its flight time is zero.
    //  • Flight time under MAX_LEAD_FLIGHT_SECONDS — see that constant.
    //  • The player-facing `projectileLead` preference, read LIVE off the registry every call (not
    //    cached) so the pause-menu row is felt on the very next frame. `!== false` because it
    //    defaults ON. Note this is NOT the `aimAssist` channel and NOT gamepad-gated.
    const flightSeconds = d.velocity > 0 ? (w.weapon.range?.max ?? 0) / d.velocity : Infinity;
    const leadable = d.hit === 'projectile' && d.guidance !== 'homing' && d.path !== 'arcing'
      && flightSeconds <= MAX_LEAD_FLIGHT_SECONDS;
    let lead = 0;
    if (t && (t.vx || t.vy) && leadable && playersOf(this).includes(player)
      && this.registry.get('projectileLead') !== false) {
      // The intercept solve — find `t` where `|target + vel·t − shooter| = projectileSpeed · t` —
      // done as TWO fixed-point iterations rather than the exact quadratic. Iterate once (flight
      // time to where the target is now), then re-measure the distance to that first guess and
      // iterate again. Measured residual miss against a 268 px/s crossing target at each weapon's
      // max range: one iteration leaves 6–29px (Plasma Lance, the slowest round that leads, is the
      // 29), two leaves 0.3–6px. The second pass is two lines and takes every weapon inside the
      // round's own hit radius, so it's worth having; the exact quadratic would buy the last ~6px
      // at the cost of a discriminant that has to be guarded for the "target outruns the round"
      // case, which cannot happen here (targets cap at 268 px/s, the slowest leading round is 500).
      // Fixed-point iteration has no such case — it just converges.
      const dx = t.x - player.x, dy = t.y - player.y;
      let flight = Math.hypot(dx, dy) / d.velocity;
      flight = Math.hypot(dx + t.vx * flight, dy + t.vy * flight) / d.velocity;
      const lx = t.x + t.vx * flight * LEAD_STRENGTH;
      const ly = t.y + t.vy * flight * LEAD_STRENGTH;
      // Wrap-safe: `aimAngleOffset` is the signed, ±π-seam-safe offset of a point from a bearing,
      // so passing the target's OWN bearing as the reference gives exactly the lead delta. A raw
      // subtraction of two atan2 results would blow up by 2π when the target sits near ±π.
      lead = aimAngleOffset(player.x, player.y, Math.atan2(dy, dx), lx, ly);
    }

    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') {
      // Indirect/melee never converged (their targeting happens downrange), but they still have a
      // limb to pivot — so they take the raw assist offset and the round leaves along the arm.
      // No lead here by construction: `leadable` excludes contact/homing/arcing, so `lead` is
      // provably 0 on this branch and is left out rather than added as a no-op.
      return player.turretAngle + assist;
    }
    // Converge on a point at the picked target's range (or CONVERGE_DIST when there's none at
    // all), but floored to MIN_CONVERGE_DIST inside convergedFireAngle so point-blank can't cross
    // the muzzles (#74). `convergeTarget` (shared.js `pickConvergeTarget`, set in _updateLock) is
    // #322: scored by ONE rule over one pool — nearest inside a ~20° cone, enemies given a modest
    // range edge. (This supersedes #250's absolute "an enemy always beats terrain" ordering.)
    const dist = t ? Math.hypot(t.x - player.x, t.y - player.y) : CONVERGE_DIST;
    // The convergence POINT moves onto the assisted bearing, so the muzzles toe in toward the
    // target rather than toward a point dead ahead of the turret. At full strength the point sits
    // on the target itself and both arms are pointed right at it.
    // #637: …and then onto the LEAD bearing, so at full strength the point sits on the INTERCEPT
    // and the arms are pointed where the target is going. `dist` stays the target's own range: the
    // intercept sits at most a few percent further out (a 179px lead at 600px is a 626px intercept)
    // and `dist` only sets how hard the off-centre muzzles toe in — that 4% is worth well under a
    // pixel of lateral error at range, so it isn't worth a second hypot per shot.
    return convergedFireAngle(
      player.x, player.y, player.turretAngle + assist + lead, dist, m.x, m.y);
  },

};
