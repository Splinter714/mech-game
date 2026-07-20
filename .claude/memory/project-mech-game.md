---
name: project-mech-game
description: What the mech game is and the locked design decisions behind it
metadata: 
  node_type: memory
  type: project
  originSessionId: 9109fdda-83f8-4a08-b3e0-dcd55a959dfe
---

A top-down, real-time mech **action** game (not turn-based) with deep customization,
at `/Users/jwbram/Code/mech game`. Tech mirrors [[horse-game-reference]]: plain JS +
Phaser 3 + Vite, all art generated procedurally in code (zero asset files).

Locked design decisions (from planning on 2026-06-26):
- **View**: top-down. Used for gameplay AND the garage/customization screen.
- **World**: hex tiles. ALL hex math is isolated in `src/data/hexgrid.js` (axial coords);
  the mech moves with free physics on top. This was a deliberate risk-containment choice.
- **Control feel**: TWIN-STICK (converted from the original tank-style) — left stick/WASD =
  omnidirectional move (free strafe, no turn-to-face); right stick/mouse = free 360° aim. The
  turret still **slews** toward the aim at `turretSlew`, and weapons fire along that slewed
  facing (#40) so whipping the aim has a cost. Movement has weight-driven inertia (heavier =
  slower accel/slew) for a "big stompy robot" feel, plus a step-based stompy walk. Tuning
  knobs live in `chassis/` data. (`turretArc`/torso-twist limit is retired.)
- **Weapons = two axes**: a Category (ballistic/missile/energy/melee/support, the
  ammo/heat economy) PLUS a composable `delivery` profile (hitscan/projectile, velocity,
  straight/arcing, dumbfire/lockon/homing, single/spread/stream). So plasma=arcing
  projectile, laser=hitscan, MG=stream, shotgun=spread, etc. — same short category list,
  rich distinct feel.
- **Anatomy**: 6 targetable upper-body locations (head, cockpit, centerTorso, L/R torso,
  L/R arm), each with own armor+structure. Kill = head OR cockpit OR centerTorso destroyed.
  Legs were REMOVED as targets (#7, 2026-06-27) — they're animation-only now (no health, not
  in the kill rule; the old both-legs rule is retired). Build model = **5 skill slots** (#31,
  2026-06-27): four weapon slots (arms+side-torsos = RT/LT/RB/LB) + ONE ability slot (centre
  torso = L3/Space). The **head is NOT a skill slot** — just a targetable location (armor +
  cockpit). No tonnage, no multi-slot. Heat removed; each weapon has a self-regenerating ammo
  magazine. **Aim-assist is a DEFAULT always-on mechanic** (#31): shots are gently pulled
  toward the nearest enemy near the reticle, applied once the turret slews onto it; toggle on
  R3 / T. Homing/tracking is **intrinsic to guided weapons** (no Target Lock item — removed).
  Weapons fire along the **slewed turretAngle**, not the raw stick (#40), so torso-twist lag
  bites. Chassis trimmed to **3** (light/medium/heavy, #25); Striker + Colossus removed.
- **Audio** (locked 2026-06-27, BUILT): **procedural / synthesized via Web Audio, ZERO asset
  files** — same ethos as the art. `src/audio/AudioEngine.js` (singleton `Audio`, rides
  Phaser's WebAudio context) synthesizes per-event SFX (firing/impact/footfall/ability/
  explosion, #32–#36) from oscillators+filtered-noise+envelopes, plus a looping soundtrack
  (#38) with TWO interchangeable 32-step tracks (`this.track`/`setTrack`): **'metal'** (the
  DEFAULT — galloping distorted power chords via a WaveShaper guitar chain + double-bass at
  ~184 BPM) and **'synthwave'** (the original A-minor synth, kept). Guards no-op until the
  context is live, so callers + the headless smoke need no guards. Mute = M. Mock-context
  unit tests in `AudioEngine.test.js`; verified non-silent via in-browser offline render.
- **Arena enemies** = an `enemies` LIST (#39): each a self-contained object (own mech/textures/
  view/AI). Player weapons + homing + napalm + aim-assist target the nearest living enemy.
  Debug controls: `[`/`]` (d-pad ↑/↓) toggle enemy move/fire (#28); `R`/`N` (d-pad ←/→) reset
  all enemies / spawn one (#39). Footfalls use a LOCAL ground-impact FX (shock ring + dust +
  body squash), NOT a full-screen camera shake (#37).
- **Garage** = a row of 5 square **skill-button tiles** (#26, not the old paper-doll), each
  showing its fire bind + the procedural `icon_<category>` art; click-to-mount (replaces) /
  click-to-clear. Full **controller navigation** (#30): d-pad focus cursor across catalog +
  tiles, A equip, B clear, LB/RB chassis, Start deploy (return-from-arena = B/Select, #29).
- **Control scope**: single mech for now; revisit squad/lance later. Controls are TWIN-STICK
  (omnidirectional move + free 360° aim, no tank/torso-twist); gamepad + KB/mouse via an
  input-intent layer (`src/input/Controls.js`).
- **Art direction** (locked 2026-06-26, lives in `src/art/mechArt.js`): "gritty cyberpunk"
  — dark weathered ANGULAR gunmetal plates (hard chamfered polygons, no rounded corners),
  multi-tone shading (top highlight rim / mid face / lower AO shadow). Lit by neon:
  PURPLE = the mech's own power (reactor spine + vents on center torso, cockpit optic, leg
  thrusters); each WEAPON glows its CATEGORY colour so loadout reads at a glance — energy
  cyan, ballistic amber, missile pink, melee white, support green (these are the
  `CATEGORIES[id].color` values, also driving catalog icons). Top-down: the turret sprite
  stacks on the hull so the torso occludes the leg tops (only feet show). Weapons are
  category-SHAPED (laser=slim barrel+lens, autocannon=twin barrels, missile=cell launcher,
  etc.). Style was locked by iterating SVG mockups before porting.
  FACTION THEMES: `buildMechTextures`/`reskinMech` take `{ theme }` — `player` (dark,
  angular/chamfered, gritty) vs `enemy` (light/white, rounded, sleek). Same glow language
  both ways; the arena's target dummy uses the enemy theme. DISTINCT per-chassis silhouettes
  are DONE (#24): each chassis has an `art.shape` block of proportion/stance multipliers that
  `mechLayout` applies — spindly light (Scout) / blocky heavy (Bulwark) / baseline medium
  (Trooper). UI: the garage + arena share one bottom skill-tile row (`src/ui/skillTiles.js`)
  with weapon-FX icons from `src/art/projectileArt.js` (the SAME art the arena draws live).

Milestone 1 (done): project scaffold + thin vertical slice of BOTH the garage (mount/
validate/save/deploy) and the arena (drive + turret + fire + per-part damage on a dummy).
Deferred: full garage UX, enemy AI/real combat, full heat+ammo sim, world collision, more
chassis/assault class, squad. Plan: `~/.claude/plans/i-want-to-make-zippy-hearth.md`.
