---
name: test-pause
description: The entire test suite was deleted at Jackson's explicit direction — no tests exist right now
metadata:
  type: feedback
---

**Current state (as of 2026-07-26): there is no test suite.** All 230 `*.test.js` files
(~3,899 tests, including the `src/data/*` pure-logic tests) were deleted in commit
`1a6a566` (preceded by a narrower `3ab8f53` covering just guard-tests + UI-layout
pinning-tests). This overrides [[working-on-mech-game]]'s "put pure logic in `src/data/*`
and unit-test it" / `npm test` verification guidance entirely — there is nothing to run.
`npm test`'s script entry is still in `package.json` (harmless, points at an empty set).

**Why**: same session as [[fast-lane-tuning]]'s slog fix, a long run of heavy parallel-
agent dispatch with constant HUD/Garage layout rework caused the guard-tests and pixel-
pinning tests to be rewritten many times in one day (`hudPanels.test.js` alone 7 times).
Jackson said directly: "test re-writes seem to take time I don't want to take; let's purge
them in one commit" — first scoped narrowly (guard-tests + UI pinning-tests only, keeping
`src/data/*`), then corrected explicitly: "no, the test purge should be all tests, I'm sick
of them." Both instructions were his own words, live in chat — not inferred, not relayed
from elsewhere. A dispatched subagent flagged the scope-widening correction as worth
double-checking (a peer-relayed "user said X" isn't the same as the user's own words) before
acting on it — it was confirmed genuine before the full purge went ahead. Good instinct,
worth preserving as the standard: verify a broadened destructive instruction traces back to
the user's own words before executing it.

**How to apply**:
- Don't add tests. Don't run `npm test` or any vitest command, targeted or full — there's
  nothing there. Don't propose "let's add a test for this" as part of any task.
- Verification is now [[working-on-mech-game]]'s live-play channel ONLY — build checks
  (`npm run build`) are still fine/expected as a basic compile sanity check, but that is not
  a substitute for tests and shouldn't be described as one.
- This is currently the project's real state, not a "pause" — treat it as durable until
  Jackson says he wants tests back (a full suite rewrite, or a narrower reintroduction of
  just the `src/data/*` category, would both be his call to make, not something to restart
  unprompted just because it seems like good practice).
- If a future session is unsure whether this is still the state, check for `*.test.js`
  files (`find src -name '*.test.js' | wc -l`) rather than assume either way.
