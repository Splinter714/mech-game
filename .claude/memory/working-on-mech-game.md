---
name: working-on-mech-game
description: How to develop and verify the mech game
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9109fdda-83f8-4a08-b3e0-dcd55a959dfe
---

The owner does not read code — tests and the running game are the source of truth, so
treat verification as first-class.

**Why**: same working style as [[horse-game-reference]]; the user understands working on
a project structured this way with Claude.

**How to apply**:
- Put pure logic in `src/data/*` and unit-test it (`npm test`, Vitest, fast/no browser):
  damage, kill rules, loadout validation, hexgrid, save round-trip.
- Adding content should be DATA, not new code: a chassis, weapon, equipment item, or
  saved-build slot = one new entry in its registry/table (`chassis/`, `weapons.js`,
  `equipment.js`, `rosters.js`).
- **The owner plays the live game himself — don't drive the browser preview to visualize
  for him.** Confirmed 2026-07-12 ("I can test, please don't try to visualize yourself"),
  see global `~/.claude/CLAUDE.md`'s exception to the verify-by-using-the-thing rule.
  `npm test` + `npm run smoke` are sufficient verification evidence to report and merge on
  for changes he'll personally exercise. Reserve driving the Claude Preview browser
  (`.claude/launch.json` → `mech-game-dev`, `window.__game.step(...)` to kick the headless
  Phaser loop) for cases with no other way to verify, or when he hasn't said he'll check it
  himself.
- `npm run smoke` (Playwright) is the deeper automated check but needs a one-time
  `npx playwright install chromium` (a heavy install — flag before running, per the
  global working-style in `~/.claude/CLAUDE.md`).
- **Ship / deploy**: work is main-based — commit + push to `main` directly, no PR/feature
  branch. "Ship it" (the full-release ritual defined in the global working-style) here =
  build green → push `main` → `npm run deploy` (= `vite build` then `gh-pages -d dist -b
  gh-pages`, publishing to the `gh-pages` branch / GitHub Pages). The deploy is the
  outward-facing step that needs an explicit go each time; a plain commit/push does not.
