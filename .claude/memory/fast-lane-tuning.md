---
name: fast-lane-tuning
description: "For pure data/constant/feel tuning in the mech game, skip the full test gate — dispatch the edit, merge, deploy, Jackson catches it in play"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eafdbdd0-6034-4359-90af-8d14b25ebe1e
---

For **pure data / constant / feel-tuning** changes in the mech game (a weapon velocity, a
regen rate, a scale value, a block-chance number, an arc curve), skip the heavyweight pipeline:
dispatch the one-line edit, merge, deploy — Jackson verifies in play immediately. Do NOT write
new unit tests for the number, and do NOT run the full ~2800-test suite (which grew to ~3
minutes/run and became the wall-clock bottleneck). Real *logic* changes still get the full
treatment.

**Why:** mech game, 2026-07-20 — "this is feeling less and less like fun quick iteration and
more like a slog." Root cause: routing one-number feel tweaks (e.g. Swarm Rack velocity
500→320, done ~5 times in a row) through the same full pipeline as major features —
isolated worktree, new tests, full suite gate, merge, deploy — meant 5 minutes of ceremony per
10-second edit. Jackson chose "Fastest — skip tests for pure data changes," verifying in play
instead.

**How to apply:**
- Batch related dials into ONE dispatch (all the Swarm Rack tweaks at once, not one agent per
  tweak).
- For a pure constant change, the agent edits, merges, deploys — no new test, no full-suite
  run. A typo'd constant is caught in play in seconds; that's the accepted trade.
- Keep the full gate for anything with branching logic, state, or a real invariant (co-op,
  fog, pathfinding, run flow). The distinction is data-vs-logic, not big-vs-small.
- This narrows the general [[working-on-mech-game]] verify-by-tests-and-play flow specifically
  for the tuning case; unit tests remain the merge gate for logic.

Also from this session: agent *thinking* is Anthropic-API-bound, not local-CPU-bound, so a
faster machine doesn't speed agents up — but the local test/build runs and their contention
ARE CPU-bound. Jackson moved the dev session to his beefier Windows rig on 2026-07-20 for that
reason (dev on Windows, PLAY on Mac/iPad — the Windows rig has an unresolved in-browser FPS
problem, see the deployed #334 FPS/GPU overlay).
