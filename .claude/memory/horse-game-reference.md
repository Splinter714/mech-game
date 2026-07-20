---
name: horse-game-reference
description: The sibling horse game project whose architecture the mech game mirrors
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9109fdda-83f8-4a08-b3e0-dcd55a959dfe
---

`/Users/jwbram/Code/horse game` — the user's other game, which the [[project-mech-game]]
deliberately mirrors architecturally (but NOT in art/content). (Relocated out of OneDrive
to ~/Code along with all his projects — the old OneDrive path is dead.)

Patterns worth copying from it: plain JS + Phaser 3 + Vite + Vitest + Playwright smoke;
procedural art via `gen()`/`scaledGraphics()` super-sampled for HiDPI (zero asset files);
a generic data-driven model (`Animal`) configured by per-type data tables; functional-mixin
scenes (`class X extends WithA(WithB(Phaser.Scene))`, one concern per file + a README map);
a `makeRoster` localStorage save factory (`src/data/save.js` + `rosters.js`); event-name
constants in one `events.js`; `.claude/launch.json` for the Claude preview.

