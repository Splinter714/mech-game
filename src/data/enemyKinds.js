// Non-mech enemy KINDS — data, not code (mirrors ENEMIES / WEAPONS / CHASSIS). Each entry
// fully describes a non-mech unit: its health, its damageable part layout (design coords, so
// procedural art + the arena's nearest-part hit-mapping line up), the weapon it fires (a real
// id from data/weapons.js, so no weapon-id literal ever leaks into scenes/arena/*), how fast
// and how it moves, whether it flies (ignores ground cover), and which registered ART builder
// and AI BEHAVIOR it uses. **Add a non-mech enemy = one entry here** — the arena builds it from
// this the same way it builds a Mech from ENEMIES.
//
// The `kind: 'mech'` default is implicit (absent from this table): an enemy with no `kind`
// stays a Mech and every existing enemy behaves UNCHANGED. Only the four entries below opt into
// the HpBody + per-kind art/behavior path.
//
// Fields:
//   name       display name (floats on spawn / used by feedback text).
//   hp         single-pool hit points (HpBody).
//   parts      { locId: {x,y,w,h} } damageable layout in mech-local design coords (−y forward).
//   muzzlePart which entry in `parts` a shot actually spawns from (#109) — the gun/barrel/nose,
//              not the unit's centre. Falls back to the first `parts` entry if omitted.
//   weaponId   which WEAPONS entry this unit fires (its delivery drives the projectile).
//   weapons    #305: the MULTI-WEAPON form. A kind that needs more than one gun declares a map
//              of SLOTS instead of the single top-level weaponId — `weapons: { nose: {...},
//              flank: {...} }` — where each slot carries its OWN weaponId, weaponOverride,
//              fireRange and burstShots/burstRestMs (every field below that describes a gun is
//              per-slot in this form). `defaultWeaponSlot` names the one a caller gets when it
//              doesn't ask. Slot keys are MOUNT/ROLE names, never weapon names, so weapon ids
//              still never leak out of this file. A kind with no `weapons` map is normalised
//              into one synthesised slot from its top-level fields, so every single-weapon kind
//              is unchanged. See data/kindWeapons.js for the seam and the helicopter below for
//              the live example (its live slot is chosen by FACING — data/gunshipCycle.js).
//   weaponOverride  #243: optional PARTIAL override merged onto the base weapon for THIS kind
//              only (resolveWeapon, data/weapons.js): top-level fields shallow-merge, the nested
//              `delivery` object also shallow-merges, and the base WEAPONS entry is never
//              mutated — so a kind can mount "the Repeater, but single-lane" as a one-line
//              delta instead of forking a whole near-duplicate weapon entry. See helicopter
//              below for the live example. Per the #243 playtest follow-up, overrides tune
//              cadence/stream/burst shape ONLY — never `damage`; enemy per-round damage always
//              matches the player's version of the weapon. (#244 carve-out: the turret's
//              override DOES set damage — it isn't an enemy-side retune of a shared weapon
//              but the old dedicated siegeShell entry, a distinct weapon with its own damage
//              identity, consolidated byte-identical into a napalm override. See the turret
//              entry + the enemyKinds.test.js damage-rule test.)
//              CADENCE lives here too (#243, superseding #241's transitional `fireEveryMs`
//              field entirely — it no longer exists): a vehicle's cooldown is ALWAYS
//              `_fireInterval` on the RESOLVED weapon (the same resolution the player/
//              mech-enemy path uses), so a kind that wants a slower/faster cadence tunes it
//              in the weapon's OWN terms — `weaponOverride: { cycleTime: 260 }` for a
//              single-shot weapon (drone/tank below), or
//              `weaponOverride: { delivery: { fireRate: 10/7 } }` for a stream weapon
//              (infantry below). One cadence concept, no parallel per-kind timer vocabulary.
//   fireRange  px at which it opens fire (falls back to the weapon's own max).
//   burstShots / burstRestMs  #243 trigger discipline (both optional): fire `burstShots` shots
//              at the normal cadence, then rest `burstRestMs` before the next burst can start
//              (the rest replaces the per-shot cooldown on the burst's last shot — see
//              `_fireVehicleWeapon`). Orthogonal to the weapon-derived cadence above, which
//              spaces the shots WITHIN a burst; deliberately KIND-level fields (not weapon
//              stats) because trigger discipline is how the unit squeezes the trigger, not
//              what the weapon is. Both absent ⇒ continuous fire, byte-identical to before;
//              the drone and helicopter opt in today. `burstRestMs` defaults to 1000 if only
//              `burstShots` is set.
//   flying     true ⇒ ignores walls/forest/water (flies over) AND draws a drop shadow (elevated).
//   move       { maxSpeed, accel, turnRate, turretSlew } px/s + rad/s locomotion tuning.
//   art        key into the vehicle-art registry (src/art/vehicles/) — builds this unit's textures.
//   behavior   key into the AI-behavior registry (scenes/arena/enemyBehaviors.js) — its update fn.
//   themeColor accent colour for its procedural art (the kind's "danger" glow on a WHITE body).
//   size       #269 (ground-unit size-tier design doc, section 2): formal 'small' | 'large' size
//              tier, queried via shared.js's `unitSize`/`isSmallUnit` rather than read directly
//              off this table — that's the one canonical query point both the crush-eligibility
//              check (world.js `_crushTargetAt`) and the hex-vocabulary cover/LOS work go
//              through. 'small': tank, infantry (the two kinds already crushable on contact,
//              pre-#269 gated by the now-superseded CRUSHABLE_BEHAVIORS Set). 'large': turret,
//              drone, helicopter. A mech enemy (data/enemies.js) has no entry in this
//              table at all and is always 'large' — `unitSize` special-cases that.
//   scale      on-screen sprite size as a MULTIPLE of the arena mech scale (data-driven per #75;
//              the arena multiplies ARENA_MECH_SCALE by this). Absent ⇒ the old global 1.15×
//              fallback. Tuned per-kind so each vehicle reads at the right heft (playtest #75,
//              shrunk further per #89's composition/sizing pass, then nudged down again per
//              #91, then again per #145's follow-up): turret 0.42 (down from 0.55, itself way
//              down from 1.15 — it now spawns in tight clusters, see TURRET_CLUSTER_SIZE, so a
//              nest of tiny sentries reads right instead of one big one), tank 0.4 (down from
//              0.48 per the #269 dock-composition follow-up — 2-3 tanks now dock-cluster on one
//              hex), drone 0.52 (down from 0.62 per #91 — "drones slightly smaller again"),
//              helicopter 0.6 (down from 0.75 per the same #269 follow-up — a paired 2-heli
//              dock cluster needs the extra headroom).

export const ENEMY_KINDS = {
  // 1) TURRET / emplacement — static objective defender. No locomotion. #94 (playtest: "turrets
  //    should have INSANE range and not be LOS, they should do some kind of artillery shit"):
  //    reworked from a short-range direct-fire autocannon sentry into a long-range artillery
  //    emplacement — it lobs an arcing artillery shell (napalm + the weaponOverride below, #244;
  //    formerly the dedicated siegeShell entry) that never needs line-of-sight (arcing rounds
  //    skip wall collision entirely, see scenes/arena/projectiles.js) at a fireRange far beyond
  //    any other enemy's engagement envelope in the game. Tough, rooted, can't chase — but you
  //    can't just hide from it either; you have to hunt it down or leave its enormous range.
  //    Per-shot damage/cadence are tuned down from the old autocannon numbers (see the
  //    weaponOverride below) since turrets now spawn in clusters (TURRET_CLUSTER_SIZE, currently
  //    4 — bumped up from 3 per #145's follow-up, alongside a further scale shrink, so the nest
  //    reads as more/smaller sentries) with guaranteed uptime (no LOS to break) — several of the
  //    old autocannon's 16-dmg/1.1s cadence firing constantly and unavoidably would be brutal;
  //    the shell's 10 dmg (with range falloff further softening it near max range) on a slower
  //    2.6s cadence keeps a nest a real but survivable threat to actively deal with rather than an
  //    instant unavoidable shred. #145-followup: went from 3→4 turrets without raising per-shot
  //    damage/cadence, so a nest's total DPS rises ~33% — worth another playtest pass to confirm
  //    a 4-turret nest doesn't tip into "unavoidable shred" territory; if it does, softening the
  //    override's damage or cycleTime a touch (rather than the turret count) is the likely lever.
  turret: {
    name: 'Sentry Turret',
    kind: 'turret',
    // #299 balance pass (owner-set): 35 structure + 15 armor = 50 total, down from a flat 90.
    // Armor-only, NO shield — the owner explicitly corrected an earlier "turrets get shields"
    // to "no shields at all, just armor", so the 15 lands in the armor pool.
    hp: 35,
    armor: 15,
    parts: {
      base: { x: 0, y: 6, w: 26, h: 16 },
      gun: { x: 0, y: -8, w: 12, h: 20 },
    },
    muzzlePart: 'gun',
    // #233 ("shots should originate from the muzzle art's tip"): `gun`'s own front edge
    // (y:-8, h:20 ⇒ front at y=-18 in art/vehicles/turret.js's drawGun coords) sits well
    // BEHIND the barrel's actual rendered tip — the muzzle-glow ellipse at y=-22 in that
    // file. `muzzleForward` is that gap (design units, added to partMuzzle's forward
    // distance) so vehicle-kind shots spawn from the real barrel tip, not the gun housing's
    // own box edge, same fix as the mech mount art (src/art/mounts/barrelSpec.js).
    muzzleForward: 4,
    // #244: the dedicated `siegeShell` WEAPONS entry was mechanically identical to napalm
    // (both arcing projectile + splash + groundFire lobs) and differed only in tuning, so it
    // was consolidated away — the turret now mounts napalm with the FULL artillery tuning as
    // a weaponOverride (#243 resolveWeapon: top-level + `delivery` merge field-by-field, but
    // OTHER nested objects — `range`, `groundFire` — are replaced WHOLESALE, so both are
    // restated complete). Numbers are byte-identical to the old siegeShell entry.
    // #94's design intent carries over unchanged: a heavy mortar shell lobbed from EXTREME
    // range ("turrets should have INSANE range and not be LOS, they should do some kind of
    // artillery shit"). Arcing (never needs LOS — arcing rounds skip wall collision entirely,
    // scenes/arena/projectiles.js), with a long, slow flight time (opt 1600 / velocity 550 ≈
    // 2.9s) so an incoming shell reads as a telegraphed "incoming!" lob rather than an
    // instant snipe; splash + a lingering burn patch reward hunting the emplacement down or
    // leaving its enormous engagement envelope rather than trying to out-trade it.
    // NOTE (SFX): per #243's resolver semantics the resolved weapon keeps the BASE id
    // ('napalm'), so the turret's fire/impact cues now resolve as napalm's tuned sound
    // (sfxParams.js) instead of the old siegeShell id (which had no DEFAULT_SFX entry of its
    // own and fell back to FALLBACK_SFX) — an audible change, flagged in #244.
    weaponId: 'napalm',
    weaponOverride: {
      // #259: this ABSOLUTE damage override is untouched by the DPS-squish base retune
      // (napalm's direct-hit damage 6 -> 27) — it's the old dedicated siegeShell value,
      // deliberately independent of the player's napalm tuning (see #244 above), and its own
      // DPS (10/2.6s ≈ 3.85, x4 turrets in a nest ≈ 15.4 total) was already checked against
      // the retuned roster and still reads as a reasonable long-range-artillery threat, not a
      // trivial tickle or a one-shot — no change needed here.
      damage: 10,                                     // vs napalm's base 27 (was 6 pre-#259)
      range: { min: 300, opt: 1600, max: 2400 },      // vs base 50/500/780 — the #94 INSANE envelope
      // #375 (redefined): the turret fires the PLAYER's version of napalm. The cadence-slowing
      // `cycleTime: 2600` and the enlarged `ammoMax: 10` are BOTH gone — cadence and magazine now
      // inherit the base napalm entry (cycleTime 1500, ammoMax 5). So the turret dumps its 5-shell
      // mag at the player's own bombardment rate, then the emptied magazine locks the gun out for
      // RELOAD_SECONDS and comes back FULL (PLAYER RELOAD model — `ammoLimited` below + kindAmmo.js;
      // no `ammoRegen` trickle), exactly like the player's own gun. The reload is the beat a player
      // reads to time an approach. Only the non-speed siege identity survives the override: the
      // absolute damage (#259/#244), the INSANE range envelope (#94), and the heavy-shell delivery.
      delivery: {
        velocity: 550,                                // faster, flatter-feeling heavy shell (base 300)
        splash: 55,                                   // bigger burst (base 30)
        groundFire: { radius: 44, dps: 5, duration: 3 },  // wider but softer/shorter burn (base 46/8/4)
      },
    },
    fireRange: 2400,       // #94: INSANE — well beyond the next-longest engagement range in the
                           // game (streakPod max 1540 / swarmRack max 1750) so a turret nest
                           // threatens from far outside normal combat distance. Matches the
                           // override's range.max above.
    // #243: no separate fire timer — cadence always derives from the resolved weapon. With the
    // #375 override no longer touching cadence, that is the base napalm's own 1500ms cycleTime.
    flying: false,
    // #375: this kind's guns run on a real MAGAZINE (data/kindAmmo.js) — the opt-in flag for
    // ammo on the vehicle fire path. Deliberately scoped to the two EMPLACED kinds: a rooted gun
    // going quiet reads as suppression, whereas a tank or drone pausing mid-chase would read as a
    // bug. Tanks/drones/helicopters/carriers/infantry stay pure cadence + trigger discipline.
    ammoLimited: true,
    move: { maxSpeed: 0, accel: 0, turnRate: 0, turretSlew: 2.6 },
    art: 'turret',
    behavior: 'turret',
    // #269 (ground-unit size-tier section): the formal size-tier field — 'small' | 'large' —
    // read by shared.js's `unitSize`/`isSmallUnit` (the canonical query point for "how big is
    // this ground unit," used by both the crush-eligibility check below and the hex-vocabulary
    // cover/LOS work). A rooted emplacement reads as a large, hard-to-miss target.
    size: 'large',
    themeColor: 0xd66a3a,
    scale: 0.42,           // #145-followup: shrunk further (was 0.55) — playtest feedback
                           // "turrets are too large" alongside bumping TURRET_CLUSTER_SIZE up
                           // to 4, so a nest of even smaller sentries reads busy rather than
                           // just big. #89: originally shrunk way down from 1.15 since turrets
                           // spawn in tight clusters (see TURRET_CLUSTER_SIZE / 'turretNest').
  },

  // 1b) WALL TURRET (#310) — the rail-lance gun mounted on a base wall's parapet.
  //
  // A DISTINCT KIND, not the `turret` above with a weaponOverride. Three reasons, in order of
  // weight:
  //   1. `weaponOverride` is a per-KIND field, not per-spawn. There is no mechanism by which two
  //      spawns of one kind mount different weapons, so "the turret kind with railLance instead of
  //      napalm" is not expressible as an override at all — it would require a forked kind
  //      regardless. The #243 mechanism is for tuning ONE weapon per owner, which is exactly what
  //      the `weaponOverride` below does do (rail lance, but a fortification's version of it).
  //   2. Almost nothing else would survive the override anyway. The sentry's identity is its
  //      napalm artillery: fireRange 2400, an arcing no-LOS lob, a 2.6s bombardment cadence. A
  //      parapet gun is a direct-fire hitscan sniper with an ordinary engagement envelope. The
  //      shared part is the HP pool and the "rooted, no locomotion" chassis — the smaller half.
  //   3. They must read as different objects. The player has to learn "sentry nest = incoming
  //      lobs you can hide from, wall gun = a lance down your throat if you're in its lane" and
  //      that lesson is impossible if they share a silhouette and a name.
  // Stats are deliberately IDENTICAL to the sentry's (#299's owner-set 35 structure + 15 armor) —
  // this is a different weapon on the same emplacement chassis, and the owner set that table.
  wallTurret: {
    name: 'Wall Lance',
    kind: 'turret',
    hp: 35,
    armor: 15,
    parts: {
      base: { x: 0, y: 6, w: 22, h: 12 },
      gun: { x: 0, y: -6, w: 10, h: 22 },
    },
    muzzlePart: 'gun',
    muzzleForward: 6,     // see the sentry's note — the drawn barrel tip sits ahead of the box edge
    // #310 (owner-confirmed weapon): the RAIL LANCE — "it telegraphs, it hits hard, and it makes
    // closing on a walled base a real gauntlet rather than a stream of chip damage." The override
    // (#243 resolveWeapon: top-level merged, `delivery` merged field-by-field, `range` replaced
    // WHOLESALE so it is restated complete) is the FORTIFICATION's version of that gun:
    //
    //   - NO damage override. The gun hits for the rail lance's own full 52.8, exactly as the
    //     player's does. This is the #243 playtest rule ("enemy rounds always match the player's
    //     weapon") and it is deliberately NOT bent here: the one standing exception is the
    //     sentry's shell, and that is excused only because it is a distinct consolidated weapon
    //     with its own damage identity (#244), not an enemy-side retune of a gun the player also
    //     mounts — which is precisely what softening the lance would be. It also turns out to be
    //     the right call on the merits: a half-weight lance would undercut the whole brief. The
    //     owner picked this weapon because "it telegraphs, it hits hard"; a 52.8 hit is ~9% of the
    //     player's health in one crack, which is the "hits hard" doing its job.
    //   - NO cadence override (#375 redefined). The wall gun now fires at the base rail lance's own
    //     rate (cycleTime 1650), exactly the player's — the owner's call: "use the player version of
    //     the weapon." The old deliberate 5.2s slow-charge telegraph is gone; difficulty is carried
    //     by gun count, the magazine/reload beat, and the guns' longer reach, never by a bespoke
    //     cadence. With only two or three guns able to bear at once (every span of the ring except its
    //     own still blocks a gun — see TURRET_MOUNT_OFFSET_PX), a ring is a real cost to a slow
    //     approach and survivable to a brisk one, now with a reload lull to exploit.
    //   - range opt 520 / max 900, LONGER than the player's 400/640. A fixed emplacement on a
    //     parapet with a prepared field of fire should out-range a walking mech; it is what
    //     makes the guns matter during the APPROACH (the point of the issue) rather than only once
    //     the player is already at the wall. Still far short of the sentry's 2400 artillery
    //     envelope, so the two never occupy the same tactical niche.
    //   - The base rail lance's own magazine (4 rounds) on the player RELOAD model: dump the mag,
    //     then a full lockout-and-reload beat before it fires again, exactly like the player's gun.
    // Per #243 the resolved weapon keeps the BASE id ('railLance'), so its fire/impact cues
    // resolve as the rail lance's own tuned sound — deliberate: the player already knows that
    // charge-and-crack, and hearing it from the wall is the telegraph doing its job.
    weaponId: 'railLance',
    weaponOverride: {
      range: { min: 0, opt: 520, max: 900 },
      // #375 (redefined): the wall lance fires the PLAYER's version of the rail lance. The
      // cadence-slowing `cycleTime: 5200` and the enlarged `ammoMax: 6` are BOTH gone — cadence and
      // magazine now inherit the base railLance entry (cycleTime 1650, ammoMax 4). So the wall gun
      // fires at the player's own rate, dumps its 4-shot mag, then the emptied magazine locks out for
      // RELOAD_SECONDS and returns FULL (PLAYER RELOAD model — `ammoLimited` below + kindAmmo.js; no
      // `ammoRegen` trickle), exactly like the player's own gun. That reload beat is the tactical
      // lever: bait the wall into emptying its magazine, then move on it while it swaps. Only the
      // non-speed range override survives — a parapet gun out-ranges a walking mech (matters on the
      // APPROACH, the point of #310); damage already matched the player's, so nothing to change there.
    },
    fireRange: 900,        // matches the override's range.max above
    flying: false,
    ammoLimited: true,     // #375: emplaced ⇒ real magazine; see the sentry turret's note above
    move: { maxSpeed: 0, accel: 0, turnRate: 0, turretSlew: 1.5 },   // slow, heavy traverse: part of the telegraph
    art: 'wallTurret',
    behavior: 'turret',
    size: 'large',
    themeColor: 0x5ac8e0,  // cold cyan — rail/energy, and distinct from the sentry's warm orange
    scale: 0.34,           // smaller than the sentry (0.42): it sits ON a 14px-thick wall line and
                           // must not swamp the span it is mounted on.
  },

  // 2) TANK — ground armour. Slow, heavy, tough frontal facing; a turreted main gun (direct
  //    fire). No jumping/flying — blocked by cover/water like a mech. Grinds toward a firing
  //    standoff and holds, hull facing the player.
  tank: {
    name: 'Battle Tank',
    kind: 'tank',
    // #299 balance pass (owner-set): 50 structure + 30 armor = 80 total, down from 160+40=200.
    hp: 50,
    // #246: HP+ARMOR (no shield) — an armored ground vehicle is the natural "has plating, no
    // energy shielding" profile, and exercises the HpBody armor layer (data/HpBody.js/
    // data/shield.js): its 40-point armor pool absorbs hits before hp same as a mech's
    // per-location armor, just as one flat unit-wide pool (HpBody has no per-location split).
    armor: 30,       // #299: 40 -> 30
    parts: {
      // #294: hull w/h narrowed + lengthened to match the art's new less-square silhouette
      // (art/vehicles/tank.js drawHull — tracks moved from sx ±13 to ±10, hull tub lengthened
      // from y -14.6..15.6 to -18..20) — was a near-square 30x26, now clearly longer-than-wide.
      hull: { x: 0, y: 8, w: 22, h: 32 },
      turret: { x: 0, y: -4, w: 18, h: 16 },
      barrel: { x: 0, y: -16, w: 6, h: 16 },
    },
    muzzlePart: 'barrel',
    // #233: `barrel`'s own front edge (y:-16, h:16 ⇒ y=-24) sits behind the gun's actual
    // rendered tip — the hot-glow ellipse at y≈-31 in art/vehicles/tank.js's drawTurret.
    muzzleForward: 7,
    weaponId: 'autocannon',
    // #243 (was `fireEveryMs: 1500`): the deliberate slower-than-weapon cadence — autocannon's
    // own cycleTime is 1100 — now expressed in the weapon's OWN terms via the override merge,
    // same 1500ms cooldown as before (`_fireInterval`'s cycleTime branch on the resolved weapon).
    weaponOverride: { cycleTime: 1500 },
    fireRange: 420,
    standoff: 300,          // px it wants to hold from the player
    flying: false,
    move: { maxSpeed: 52, accel: 120, turnRate: 1.4, turretSlew: 2.2 },   // #91: slowed further
                                                                          // (was 78) — reads as
                                                                          // noticeably heavier/
                                                                          // slower ("tanks slower").
    art: 'tank',
    behavior: 'tank',
    // #269: 'small' — this is one of the two kinds already crushable on contact (see
    // `CRUSHABLE_BEHAVIORS`'s pre-#269 history, now superseded by `unitSize`/`isSmallUnit` in
    // shared.js), so its size tier matches that gameplay reality: a battle tank low to the
    // ground and stompable.
    size: 'small',
    themeColor: 0xc65a34,
    // #269 playtest follow-up (dock composition): shrunk again (was 0.48, #91's "tanks
    // smaller" pass) so 2-3 tanks can dock in a tight cluster on ONE dock hex (scenes/arena/
    // bases.js `_spawnDormantUnits`'s scatter offset) without excessive overlap.
    scale: 0.4,
  },

  // 3) DRONE — one unit of an infantry/drone SWARM. Cheap, small, fast, individually weak; a
  //    light rapid weapon. Spawned in numbers (see DEFAULT_SWARM) and swarms the player with a
  //    loose, jittery orbit so the pack reads as a cloud, not a firing line.
  drone: {
    name: 'Recon Drone',
    kind: 'drone',
    // #370 (owner-set, playtest 2026-07-20: "increase drone ability to withstand hits" — asked
    // armor vs shields he picked SHIELDS, and gave "10 total, 5 of each"). So: 5 structure +
    // 5 shield = 10 total, up from the #299 pass's flat 3 ("chaff, dies instantly").
    hp: 5,
    // #246 layer model: HP+SHIELD, no armor — same combo (and same regen shape) as the
    // helicopter: a thin-skinned flyer with a small fast-recharging deflector.
    // #382: shared pause/regen for ALL shields (3000ms, 25%-of-max/sec — see shield.js). The
    // 5-point pool now regens 1.25/sec and refills in the same 4s as everything else; per-kind
    // tuning (the old 2200ms/5-per-sec) is gone. Note swarms are 10+ since #370, so the refill
    // still compounds across a swarm — a prime playtest dial if drones feel spongy.
    shield: { max: 5 },
    parts: {
      body: { x: 0, y: 0, w: 12, h: 12 },
    },
    muzzlePart: 'body',
    // #233: `body`'s own front edge (y:0, h:12 ⇒ y=-6) sits behind the under-slung barrel's
    // rendered tip (art/vehicles/drone.js drawFrame's `rectC(0, -6, 1.4, 4, ...)` ⇒ far edge
    // y=-8, no glow beyond it).
    muzzleForward: 2,
    // #243 further playtest follow-up: swapped off Pulse Laser onto Plasma Lance — the drone
    // now sprays plasma bolts instead of hitscan pulses. No damage override (per-owner
    // deltas stay cadence/burst-shape only, per the standing #243 rule): each bolt hits for the
    // SAME damage as the player's mount (#259 DPS-squish retuned that to 1.5, down from 2 —
    // still shared verbatim, no override). Plasma Lance's own delivery is a fast stream
    // (`fireRate: 20`, i.e. a bolt every 50ms) — that native cadence is too machine-gun-fast to
    // read as single shots on its own, so no weaponOverride is needed for the bolt itself;
    // `_fireVehicleWeapon` resolves the bare base entry (resolveWeapon(id, null) === base).
    // Trigger discipline (`burstShots`/`burstRestMs`) does the shaping instead. #243 latest
    // playtest ask: fire 1 shot at a time instead of the prior 7-bolt stutter (was
    // burstShots: 7 / burstRestMs: 700). burstShots: 1 fires a single bolt then rests
    // burstRestMs before the next — burstRestMs: 400 is a deliberate pause (not the weapon's
    // native 50ms) but still snappy/erratic to match the drone's small-swarmer role, not a slow
    // deliberate cadence like the gunship's 1200ms rest. fireRange kept at #117's 280 — well
    // inside Plasma Lance's `opt: 460` (firing.js's falloff is full damage out to `opt`, so
    // every drone shot at this range lands at full damage) and its `max: 620`.
    weaponId: 'plasmaLance',
    burstShots: 1,           // one bolt at a time…
    burstRestMs: 400,        // …then a short, snappy pause before the next single shot
    fireRange: 280,
    swarmRadius: 200,       // px orbit radius the drone tries to hold around the player (#93: nudged out from 150 — playtest felt too close)
    flying: true,           // hovers — ignores ground cover, draws a small shadow
    move: { maxSpeed: 150, accel: 420, turnRate: 6, turretSlew: 9 },
    art: 'drone',
    behavior: 'drone',
    // #269: 'large' — never in the pre-#269 CRUSHABLE_BEHAVIORS scope, and it flies (hovers
    // over ground obstacles) rather than being a squat, low target, so it doesn't fit the
    // 'small' tier the way tank/infantry do.
    size: 'large',
    themeColor: 0xe0b13a,
    scale: 0.35,           // #379 3rd pass (owner playtest 2026-07-21: "a touch too big") —
                           // trimmed from 0.40 (which was itself a bump from 0.30; original
                           // 0.44 rounded, 0.52 per #91, 0.62 before that).
                           // Still just above the infantry trooper's 0.19 (#411), so troopers
                           // stay the smallest unit. PLAYTEST DIAL.
    // #379: the drone is the one shielded kind whose two sprites are NOT both "the unit's body".
    // Its hull is the airframe (booms + pod) and its turret sprite is the spinning-ROTOR blur
    // overlay, so the default hull+turret outline glowed around four rotor discs — Jackson:
    // "remove the shield glow from their rotors, but keep it on their body". Naming the outline
    // parts here keeps that a DATA statement about this kind's art: every other shielded kind
    // (helicopter, carrier) omits the field and keeps the shared hull+turret default untouched.
    shieldOutlineParts: ['hull'],
  },

  // 4) HELICOPTER / VTOL — fast flyer. Ignores ground cover entirely (flies over walls, forest,
  //    water). Runs strafing passes across the player's front and loses fire, then peels off
  //    and comes around again — harder to hit because it never sits still. Elevated (big shadow).
  //    #95: streakPod (homing) was shelved pending a lock/tracking rework, so this mount swaps
  //    to machineGun — a direct-fire stream that reads as the gunship raking the ground with
  //    cannon fire on each pass, no guidance/lock dependency.
  helicopter: {
    name: 'Gunship',
    kind: 'helicopter',
    // #299 balance pass (owner-set): 35 structure + 15 shield = 50 total, down from 70+30=100.
    hp: 35,
    // #246: HP+SHIELD (no armor) — a thin-skinned aerial unit with a small deflector rather
    // than plating; regens fast (it's evasive and often out of the fight between passes) but
    // the pool itself is modest, so a sustained pass still breaks through it quickly. Exercises
    // the HpBody shield layer (data/shield.js). Only the pool SIZE is per-kind now.
    // #299: pool 30 -> 15 (owner-set).
    // #382: shared pause/regen for ALL shields (3000ms, 25%-of-max/sec — see shield.js); the
    // 15-point pool regens 3.75/sec and refills in 4s. #362 has helicopters HOLD range rather than
    // closing, so this is the enemy kind most likely to actually cash in the recharge by drifting
    // out of contact between passes.
    shield: { max: 15 },
    parts: {
      fuselage: { x: 0, y: 2, w: 14, h: 30 },
      cockpit: { x: 0, y: -12, w: 12, h: 12 },
      tail: { x: 0, y: 18, w: 6, h: 14 },
    },
    muzzlePart: 'cockpit',   // nose-mounted gun — cockpit is the most-forward part
    // #233: `cockpit`'s own front edge (y:-18) already sits almost exactly at the chin gun's
    // hot-glow tip (y=-17 in art/vehicles/helicopter.js drawAirframe) — within ~1 design unit,
    // negligible at world scale, but included for consistency with every other kind.
    muzzleForward: -1,
    // #305: the gunship is the first MULTI-WEAPON kind — see data/kindWeapons.js for the seam.
    // Two slots, and which one is live is decided by FACING (data/gunshipCycle.js): the nose
    // gun while the airframe is pointed at the player on its approach run, the door gun while
    // it's broadside on its strafing pass. Slot keys are MOUNT names, so the weapon ids stay
    // confined to this file exactly as #243 requires.
    weapons: {
      // NOSE — Cluster Salvo, fired down the airframe axis during the nose-on APPROACH.
      // Jackson picked the DUMBFIRE cluster over the homing seeker deliberately, so a head-on
      // gunship run is something the player can read and sidestep rather than something that
      // simply tracks him. No damage override (per #243's rule): the enemy's per-round damage
      // is the player's own Cluster Salvo. Cadence is the weapon's own 1100ms cycleTime, and
      // 3 salvos per squeeze then a 1.4s rest keeps an approach to a few readable volleys
      // rather than a continuous rocket stream. fireRange is shorter than the door gun's — it
      // must actually be closing before it starts throwing rockets.
      nose: {
        weaponId: 'clusterRocket',
        // A FIXED FORWARD mount: it aims and fires along the AIRFRAME, and holds fire until the
        // airframe itself is on target (see aimAndFire). Without this the gunship dumped a salvo
        // the instant its approach began, while still ~77 degrees off from the previous phase —
        // measured in the running game. It's also what makes the dumbfire salvo sidesteppable:
        // the rockets go where the aircraft visibly points.
        fixedForward: true,
        fireRange: 520,
        burstShots: 3,
        burstRestMs: 1400,
      },
      // FLANK — the door gun. This is the pre-#305 gunship loadout, moved verbatim into its
      // own slot: twin-lane Repeater (#269 playtest follow-up: matches the player's Repeater,
      // no damage override; cadence is machineGun's own fireRate 18 ⇒ ~55.6ms/tick via
      // `_fireInterval`, #241), with #243's trigger discipline bounding each squeeze to 15
      // cadence ticks (~0.83s, 15 rounds per lane) then a 1.2s rest, so a pass reads as
      // aggressive raking BURSTS rather than one continuous hose. Owner: tune via playtest.
      flank: {
        weaponId: 'machineGun',
        weaponOverride: { delivery: { count: 2 } },   // matches player's Repeater
        fireRange: 460,
        burstShots: 15,
        burstRestMs: 1200,
      },
    },
    // Which slot a caller gets if nothing asks for one — the door gun, its bread-and-butter.
    defaultWeaponSlot: 'flank',
    // NOTE: the old flat `strafeRange: 320` is GONE. #305 randomises the standoff per unit in a
    // 240-400px band, re-rolled each attack cycle, so a group of gunships spreads across the
    // field instead of sitting on one radius — the band lives in data/gunshipCycle.js
    // (STANDOFF_MIN/STANDOFF_MAX) next to the cycle it belongs to.
    flying: true,
    move: { maxSpeed: 210, accel: 260, turnRate: 3.2, turretSlew: 4 },
    art: 'helicopter',
    behavior: 'helicopter',
    // #269: 'large' — an elevated flyer, never crushable, not a small ground target.
    size: 'large',
    themeColor: 0xcf4d4d,
    // #269 playtest follow-up (dock composition): shrunk again (was 0.75, #89's pass) so a
    // paired 2-helicopter dock cluster (scenes/arena/bases.js `_spawnDormantUnits`) reads as
    // two distinct gunships rather than one overlapping blob.
    scale: 0.6,
  },

  // 5) CARRIER — "Broodhauler" (#130, reworked in #328). A slow, tanky, UNARMED drone carrier:
  //    the battle tank's exact tracked body (art/vehicles/carrier.js reuses tank.js's own
  //    `drawTankHull`) with the gun turret replaced by a launch BAY DOOR, and no weapon at all.
  //    Its only threat is what it unloads — while alive and AWARE it acts as a mobile "nest,"
  //    dropping a whole BATCH of drones from its own body on a cadence (carrierBehavior in
  //    enemyBehaviors.js) up to a lifetime cap, rather than a cluster spawning everything up
  //    front like turretNest/infantryMob.
  //
  //    #328 (playtest 2026-07-19, Jackson): the old four-legged Broodwalker "honestly looks
  //    bad" — re-skinned onto the tank body ("re-use tank art exactly, but minus the tank
  //    turret", plus "something on top that looks like a bay door... to let the drones out"),
  //    disarmed ("unarmed — pure carrier"), and moved onto tank-like movement ("movement feel
  //    should match the tank, but maybe slower, and also make the whole thing bigger"). The
  //    known consequence — that it is now much LESS dangerous, since the player can park
  //    alongside and dismantle it at leisure — was surfaced and accepted; deliberately NOT
  //    compensated for by buffing drone output, so it can be felt in play first.
  carrier: {
    name: 'Broodhauler',
    kind: 'carrier',
    // #299 balance pass (owner-set): 50 structure / 50 armor / 50 shield = 150 total.
    // #436: the shield pool is gone — its 50 points moved onto armor instead, so the stack is
    // now 50 structure / 100 armor = 150 total, same toughness, no regenerating layer. #328
    // left the whole toughness stack untouched (only art, weapon, movement and size moved);
    // #436 is the first change to touch it, and only to swap which layer holds the 50.
    hp: 50,
    // #436: was 50 (armor-only from #246's "all three layers") + a separate 50-point `shield`
    // pool (#382's shared regen). Jackson: move the carrier from shields to armor, same value —
    // it no longer regens a depleted layer, it just has more flat armor to grind through.
    armor: 100,
    // #328: the hitboxes follow the new art. `hull` is byte-identical to the TANK's, because it
    // is now literally the same drawing (see art/vehicles/carrier.js); the tank's `turret` and
    // `barrel` parts are replaced by the single `bay` — the launch door on the deck. Both parts
    // scale with `scale` at hit-resolution time like every other kind's.
    parts: {
      hull: { x: 0, y: 8, w: 22, h: 32 },
      bay: { x: 0, y: 1, w: 16, h: 20 },
    },
    // #328: NO weapon. Jackson chose "unarmed — pure carrier", so there is no `weaponId`, no
    // `weaponOverride`, no `muzzlePart`/`muzzleForward` and no `fireRange` — `kindWeaponSlots`
    // (data/kindWeapons.js) resolves an unarmed kind to ZERO slots, and `carrierBehavior` never
    // calls `aimAndFire` at all. Its detection radius falls back to `detectionRangeFor`'s own
    // default (360px), which is close to the 456px the old gun-derived value produced.
    standoff: 320,           // px it wants to hold from the player while unloading
    flying: false,
    // #328: "movement feel should match the tank, but maybe slower". Tank is
    // { maxSpeed: 52, accel: 120, turnRate: 1.4 }; this is the same tank-style hull-travel
    // shape a touch heavier across the board. The old 0.35 turnRate was a deliberate
    // lumbering-LEGS tune (#152) that no longer describes anything now the legs are gone.
    // No `turretSlew` — there is no turret to slew; the bay door is pinned to the hull.
    // Owner: tunable, these are playtest dials.
    // #361 (playtest 2026-07-21, "WAAAAAY too slow or getting stuck at gates"): diagnosed as
    // pure speed, not a gate deadlock — soft ground separation (data/groundSeparation.js) already
    // clears the carrier through a gate crowd (gateJam.test.js's heterogeneous case), but the old
    // 40/95/1.0 was slower than the tank on EVERY axis (52/120/1.4), so it lumbered and could
    // wallow in a gate mouth strafing in place. Bumped to "a touch slower than the tank" on all
    // three axes, matching the #328 design intent ("match the tank, maybe slower") instead of
    // being dramatically under it. Still the slowest mobile ground kind.
    move: { maxSpeed: 48, accel: 110, turnRate: 1.3 },
    // #328: how many BAY-DOOR frames this kind's art builds (art/vehicles/carrier.js
    // CARRIER_DOOR_FRAMES — [0] shut, [1] open). Presence of this field is what tells the arena
    // (enemies.js _makeVehicleView/_updateVehicle/_reskinVehicle) to render
    // `<key>_turret_0..N` instead of one static `<key>_turret`, exactly mirroring how
    // `legFrames` drives multi-frame HULL art. `carrierBehavior` flips the live frame to 1 for
    // a beat whenever a batch launches.
    turretFrames: 2,
    // #147/#152: every deployEveryMs while alive+engaged it drops a whole BATCH of drones at once
    // (enemies.js `_updateVehicle` → enemyBehaviors.js `carrierDeployTick`), floor 5 so every
    // burst is a real swarm.
    // #328 follow-up: NO `deployCap`. The old lifetime cap of 24 exhausted a carrier after 3-4
    // batches (~12-16s), then it never deployed again. Jackson: "yes make broodhauler an infinite
    // spawner, yes" — it now deploys for as long as it lives, and killing it is the only lever,
    // exactly as docks work post-#326.
    // #416 (playtest: "still floods/camps" even after the carrier was moved closer): the cadence
    // is now slowed and the batch shrunk on top of `carrierDeployTick`'s new live-drone cap
    // (`CARRIER_MAX_LIVE_DRONES`, enemyBehaviors.js) — the cap alone bounds the PILE-UP, but the
    // old 4s/5-8 cadence still refilled that cap almost the instant the player cracked it open.
    // Slower production (6s, was 4s) plus a smaller burst (3-5, was 5-8) makes the brood read as
    // a steady trickle the player can keep pace with, rather than a swarm that reloads itself
    // in one breath. Owner: tunable playtest dial, same as the cap.
    deployEveryMs: 6000,
    deployBatchMin: 3,
    deployBatchMax: 5,
    art: 'carrier',
    behavior: 'carrier',
    // #269: 'large' — not crushable, and it towers over the tree canopy.
    size: 'large',
    themeColor: 0x8a4fc9,    // distinct violet accent — reads as a different "danger" bit
                             // from tank's orange / turret's orange / drone's yellow / etc.
    // #328: "make the whole thing bigger" — visibly bigger than a tank. Because this now draws
    // the TANK's art, `scale` is finally directly comparable to the tank's own 0.4, so this is
    // simply 1.5x a tank's on-screen footprint. (The old 1.0 was against the old Broodwalker art's
    // much larger intrinsic size and is NOT comparable — see #328's note.) Side effect worth
    // knowing: its collision radius therefore FALLS from 24px to 14.4px
    // (shared.js `groundEnemyRadius` = 24 * scale), so it fits through gates and wall breaches
    // strictly better than the Broodhauler did, not worse.
    scale: 0.6,
  },

  // 6) INFANTRY — one trooper of a GROUND swarm (#97). The weakest unit in the game by a wide
  //    margin: barely any hp, a single small part, a weak short-range popgun. Individually
  //    meaningless — it threatens purely through the size of the mob it spawns in (see
  //    INFANTRY_MOB_SIZE below, deliberately bigger than the drone SWARM_SIZE so a mob reads as
  //    an overwhelming crowd, not just "a few more enemies"). Ground unit (flying: false), unlike
  //    the drone it otherwise mirrors in spirit — advances/mills on foot, blocked by terrain like
  //    a mech, and subject to #92 player-ground-collision (see groundEnemyRadius: its footprint
  //    scales by `scale` same as every other vehicle, so at 0.38 each trooper's own collision
  //    circle is tiny — a mob reads as a crowd you push through, not a solid wall; see the #97
  //    report for the full reasoning).
  infantry: {
    name: 'Trooper',
    kind: 'infantry',
    hp: 3,                 // #299 balance pass (owner-set): 3, matching the drone — the floor of the roster
    parts: {
      body: { x: 0, y: 0, w: 8, h: 12 },
    },
    muzzlePart: 'body',
    // #233: `body`'s own front edge (y:0, h:12 ⇒ y=-6) sits well behind the held rifle's
    // rendered tip — the muzzle-glow ellipse at y=-18 in art/vehicles/infantry.js drawRifle
    // (the rifle is drawn held forward across the body, reaching well past the torso box).
    muzzleForward: 12,
    weaponId: 'machineGun',   // cheap, short-range, already-mounted ballistic — fits a trooper
    // #243 (was `fireEveryMs: 700`): the EXACT same 700ms cooldown, now expressed in the
    // weapon's own terms — a slow popgun stream, fireRate 10/7 ≈ 1.43 shots/sec
    // (`_fireInterval`: 1000 / (10/7) = 700ms). #241's balance flag carries over verbatim:
    // this cadence has never been confirmed as a deliberate slower-than-weapon choice (unlike
    // tank/carrier's), but un-slowing it would let a 28-unit INFANTRY_MOB_SIZE mob each
    // stream at the Repeater's full 18/sec — a huge DPS jump — so it's preserved byte-identical
    // pending a deliberate playtest/tune pass.
    weaponOverride: { delivery: { fireRate: 10 / 7 } },
    fireRange: 200,
    flying: false,           // ground troop — walks, collides with terrain and the player
    move: { maxSpeed: 48, accel: 260, turnRate: 5, turretSlew: 6 },  // #104: slowed noticeably
                                                                     // from 85 (playtest: "should
                                                                     // be slower") — a lumbering
                                                                     // mob you can outrun/outdrive,
                                                                     // not a fast-closing swarm.
    // #151 (playtest: "infantry swarms hanging out in the water"): a passable river/channel is
    // meant for mechs/tanks to wade through, but a tiny trooper parking in it reads badly. This
    // only affects idle-wander GOAL PICKING (scenes/arena/enemies.js `_idleMoveIntent`) — a
    // trooper directly chasing/fleeing across a river when AWARE is unaffected (that's driven by
    // direct-line movement toward the player, not a chosen destination) and can still physically
    // cross passable water if forced to. Tank/carrier are bulkier and read fine wading, so this
    // is infantry-only, not a generic "small ground unit" flag — see #151 report.
    avoidWater: true,
    art: 'infantry',
    behavior: 'infantry',
    // #269: 'small' — the other pre-#269 CRUSHABLE_BEHAVIORS entry, and literally the smallest
    // unit in the game (scale 0.38, the lowest of any kind).
    size: 'small',
    themeColor: 0x8fae4a,
    scale: 0.19,           // #411 (playtest: "shrink infantry to about half size"): halved from
                           // 0.38. `scale` is the single size source of truth — it drives BOTH the
                           // rendered art footprint and the collision radius (groundEnemyRadius =
                           // 24 * scale in shared.js), so one edit halves both. The art itself is
                           // left as #104's deliberately-chunky single-blob silhouette (thin shapes
                           // vanish at small scale) rather than shrunk further, which would
                           // over-shrink and desync from the `parts` hitbox above. Still comfortably
                           // below the drone's 0.44 (#97 wanted troopers the smallest unit). PLAYTEST
                           // DIAL — if it aliases too hard at this size, nudge back up.
  },
};

// A non-mech spawn ships several drones as one "swarm" unit so the pack reads as numbers. The
// arena expands a 'swarm' request into this many drones. #89: drastically increased (was 5) per
// playtest feedback ("waaaaaay more of them at once") — this is exactly the concentrated-unit
// load the #71/#76 performance fixes (per-enemy view/texture teardown, throttled impact FX) were
// built to hold up under; profiled at 18 concurrent drones (see #89 report) with headroom to
// spare, so this is picked as a strong "way more" without measurably hurting frame rate.
export const SWARM_SIZE = 18;

// A 'turretNest' spawn expands into this many turrets dropped close together in a tight, fixed
// formation (#89 — "a few of them should spawn together"). Turrets are stationary (maxSpeed 0),
// so unlike the drone swarm's loose orbiting cloud, the nest is a small static cluster — picked
// small and sensible so it reads as an emplacement, not a wall of guns. #145-followup (playtest
// 2026-07-12: "could we try 2 or 4 at a time instead of 3?" — owner left the pick open): bumped
// 3 → 4, paired with a further scale shrink on the `turret` kind above, so the nest reads as
// "more, smaller" sentries rather than fewer, bigger ones. Easy to retune — just change this
// constant (see the turretClusterHexes/_spawnTurretCluster call sites, which are fully
// parameterized by count, not hardcoded to 3 or 4).
export const TURRET_CLUSTER_SIZE = 4;

// An 'infantryMob' spawn expands into this many infantry dropped in a loose cluster (#97 —
// "let's add infantry in large volumes, smaller than drones"). Deliberately bigger than the
// drone SWARM_SIZE (18) so a mob reads as an overwhelming crowd rather than just "more of the
// same"; profiled (see #97 report) alongside the #71/#76 concentrated-load perf work before
// landing on this number — dial back if a future profile run shows it doesn't hold ~60fps.
export const INFANTRY_MOB_SIZE = 28;

// Is a type id a non-mech kind? (Anything not in this table is a mech loadout.)
export function isEnemyKind(typeId) {
  return Object.prototype.hasOwnProperty.call(ENEMY_KINDS, typeId);
}

export const ENEMY_KIND_IDS = Object.keys(ENEMY_KINDS);
