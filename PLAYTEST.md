# Playtest checklist — 2026-06-30 balance/feel batch

Ten commits landed this session, each tied to a GitHub issue. All are
first-draft tuning values flagged in their commit messages and inline
code comments as owner-reviewable — nothing here is final. Test in the
Arena (`npm run dev`, deploy a mech, debug-spawn an enemy as needed).

## Weapons

- [ ] **Repeater (`#47`)** — fires faster (12→18/s) and bullets fly
  noticeably faster (640→900 px/s) and slightly smaller. Check it still
  feels like a sustained stream, not a laser, and that ammo drains at a
  reasonable clip with the higher fire rate.
- [ ] **Autocannon (`#48`)** — the slug round should look visibly bigger/
  punchier now (enlarged shell + tracer). Check it doesn't look cartoonish
  at point-blank range.
- [ ] **Scatter Gun, Repeater, Cluster Salvo range (`#52`)** — all three
  now reach to ~300-320px instead of 140-250px. Check engagements at the
  new max range still feel intentional (falloff, not just "now it
  reaches further").
- [ ] **Cluster Salvo (`#51`)** — fire it and watch the 5-rocket clump
  over its full flight. It should stay a tight, perfectly parallel
  column all the way to impact — no fanning/spreading. (This was the bug
  you originally flagged.)
- [ ] **Flamethrower (`#46`)** — spread is much tighter (24°→12°) and
  denser (3→6 particles); the flame art is reworked from round blobs
  into elongated, flickering, color-graded tongues. Check it now reads
  as a flame *stream* rather than a 3-pellet shotgun blast, and that the
  new art doesn't tank framerate at close range with multiple enemies.
- [ ] **Swarm Rack (`#49`)** — fire at a target from an angle where you
  can see the whole 6-missile fan. Missiles should jiggle/jostle
  chaotically right after launch, calm down on final approach, and
  arrive at the target at roughly the same time (not trickling in one by
  one). Watch for any missile that looks like it's lagging badly behind
  the rest.
- [ ] **Streak Pod (`#50`)** — fire a sustained burst. Each missile
  should weave in a smooth, deliberate sine pattern (not random/jittery)
  and the stream should look like a tight, slightly staggered packed
  column rather than missiles stacked exactly on top of each other.
  Compare side-by-side with Swarm Rack — Streak Pod should read as
  controlled/snaky, Swarm Rack as chaotic.
- [ ] **Cleaver / melee** — confirm it's gone from the garage catalog
  entirely (no melee weapon selectable, no stray UI for an empty melee
  slot category).

## Movement (`#45`)

- [ ] **All-around speed** — every chassis (light/medium/heavy) should
  feel ~25% slower than before. Drive each weight class briefly; check
  the *relative* feel between classes is still distinct (light still
  clearly nimble, heavy still clearly lumbering).
- [ ] **Backward movement penalty** — aim your turret one direction, then
  drive straight backward relative to that aim. You should be noticeably
  slower (~55% speed) than driving forward or strafing. Try a diagonal
  backward+strafe move too — it should feel like a smooth speed
  reduction, not a hard snap or a dead stop.
- [ ] **Enemy movement** — confirm enemies also feel slower and also
  hesitate/slow when backing away from you (same rule applies to them).

## Enemy AI (`#44`)

- [ ] **Engagement distance** — let an enemy fight you for 20-30 seconds
  without interrupting. Its preferred distance should drift in and out
  over time rather than holding a perfectly fixed orbit radius.
- [ ] **Strafe direction** — the enemy should reverse strafe direction on
  a deliberate multi-second cadence, not constantly flicker or stay
  locked one direction forever.
- [ ] **Commit bursts** — watch for the enemy occasionally breaking its
  strafe to commit to a straight advance toward you or a retreat away
  from you, then resuming normal behavior. Should feel like a deliberate
  tactical choice, not a glitch where it suddenly stops strafing.
- [ ] **Overall read** — does the enemy feel meaningfully less robotic/
  predictable than before, without becoming erratic or unfair?

## Known rough edges to watch for

- The flamethrower and missile-feel work was only spot-checked in the
  Weapon Lab preview, not exhaustively in live arena combat with damage
  resolution — watch for any edge case where a wobbling/staggered
  missile fails to register a hit it visually should have landed.
- All numeric constants (speed cuts, wobble amplitudes, AI timers, etc.)
  are first-draft guesses, flagged inline in the source for easy
  re-tuning — if something feels off, the relevant constant is named and
  commented at the top of its file.
