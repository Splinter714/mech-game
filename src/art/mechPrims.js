// Shared mech-art primitives + palettes. The low-level draw helpers (all in mech-local
// design coords: origin = centre, -y up) and the faction/glow palettes, factored out of
// mechArt.js so the per-category weapon-mount art (./mounts/) and per-kind chassis decor
// (./decor/) can reuse them without importing the orchestrator (avoids a cycle).
import { ART_SCALE, scaledGraphics } from './_frames.js';

export { scaledGraphics };
export const DESIGN = 64;              // design-grid canvas size (square)
export const CENTER = DESIGN / 2;

// Faction palettes. `faceted` swaps the plate primitive (tapered cut-plane wedge ↔ the player's
// symmetric chamfered octagon), and `roundBarrel` keeps gun tubes capsule-ended. Tones run
// outline (edge) → deep/ao (shadow) → faceDk/faceMid/face (panels) → rim/rimHi (light).
//
// #446, pass 1 (de-bubbling): the enemy theme used to carry a third mode, `bubbly` — every part
// drawn as a glossy ELLIPSE with a soft bottom shadow and a bright highlight spot, which is what
// read as "too bubbly": inflated ceramic pods rather than armour. That mode is gone entirely.
// It fell back onto a `rounded` plate with a very hard corner radius (0.13).
//
// #446, pass 2 (this one): the owner's read on that was "a bit more angular instead of BLOCKY" —
// a rounded rect with its corners squeezed to nearly nothing is just a rectangle, so the fix is
// NOT a smaller radius (that only makes it blockier). The whole rounded mode is gone with the
// bubbly one; the enemy now draws a FACETED plate — a trapezoid, narrower at the top, whose
// corners are cut back into visible chamfer planes (deep at the top, shallow at the bottom), with
// a shaded cut plane down one side, a bright highlight along the fold between the two planes, and
// a DIAGONAL panel seam. Slanted sides + cut corners + diagonal panel lines is what reads as
// angular at ~40px; orthogonal edges and right angles are what read as blocky. Still unmistakably
// the "sleek pale machine" faction against the player's dark symmetric gunmetal.
// `armorArt` (#472): does a mech of this faction show its ARMOR state on the sprite at all?
// The player still tears open (`exposedInternals`) when a location's armor is stripped — that's
// the player-side look #401 owns. Enemies do NOT: the owner's read was that the visual "looks so
// dumb on enemies", and an enemy's armor already has a home in the HUD's locked-enemy disc
// (#452's structure/armor/shield arcs), so an enemy mech has exactly ONE body look per damage
// state. It's a theme property rather than a call-site branch because the faction palette table
// is already the single place a mech's LOOK is decided.
const THEMES = {
  player: {
    faceted: false, armorArt: true,
    outline: 0x0b0e14, deep: 0x1b212b, ao: 0x10131a, recess: 0x14181f, housing: 0x14181f,
    lower: 0x252c38, faceDk: 0x2a323e, faceMid: 0x2e3543, face: 0x3a4250,
    rim: 0x4b5666, rimHi: 0x566273, joint: 0x181d27, grime: 0x0e1219, char: 0x17120f,
  },
  enemy: {
    faceted: true, roundBarrel: true, legibilityHalo: true, armorArt: false,
    outline: 0x2b3441, deep: 0x9aa7b6, ao: 0x8b97a6, recess: 0x96a3b2, housing: 0x5a6675,
    lower: 0xc3ccd6, faceDk: 0xb6c2cf, faceMid: 0xd3dae2, face: 0xe7ecf1,
    rim: 0xf6f9fb, rimHi: 0xffffff, joint: 0x8b97a6, grime: 0x96a3b2, char: 0x4a3a36,
  },
};
// #446 pass 2 — the two dials of the FACETED plate, both fractions:
//   FACET_TAPER — how much narrower the plate's TOP edge is than its bottom, so the sides slant
//     instead of running vertical (a wedge, not a box).
//   FACET_CUT — the base corner cut as a fraction of the short side. The top corners take 1.5× it
//     and the bottom corners 0.6×, so the cut planes are unmistakably deliberate at the shoulder
//     line rather than a symmetric bevel that just reads as "slightly rounded".
export const FACET_TAPER = 0.18;
export const FACET_CUT = 0.26;
// #348 (local co-op, player identification): an optional per-OWNER accent layered on top of a
// faction palette. Two mechs on the same side must be told apart at a glance, and the theme
// table is already the one place a mech's colour is decided — so rather than bolt on a parallel
// tinting mechanism, an `accent` recolours the palette's RIM tones (the lit top edges of every
// plate). That reads as "same machine, different unit markings" instead of "different faction":
// the body/shadow tones, the reactor purple and every weapon-category neon are untouched, so a
// loadout still reads exactly as it did. `accent` omitted/null returns the base theme object
// itself, unchanged and uncloned — which is what player 1 and every enemy get.
export const themeFor = (opts) => {
  const base = THEMES[opts?.theme] ?? THEMES.player;
  if (!opts?.accent) return base;
  return { ...base, rim: opts.accent, rimHi: opts.accent };
};

// The mech's own power glow (not a weapon).
export const REACTOR = { halo: 0x7a2ed6, core: 0xb15cff, hot: 0xecd6ff, edge: 0x8a4ad6 };

// #129: a fixed, near-white "legibility halo" — an extra silhouette ring drawn OUTSIDE a
// part's existing dark outline, enemy/vehicle-only (`T.legibilityHalo`/opt-in per call site).
// The existing dark outline already reads fine against LIGHT biome grounds (snow, sand): the
// bug is dark biome grounds (volcanic ash, night-dark grass/urban patches) where that dark
// outline is nearly the same tone as the terrain and the silhouette disappears. Rather than
// re-picking per-biome colours (would require a combinatorial retune of every enemy × every
// biome), this adds ONE more ring in a bright, fixed tone: on light terrain the inner dark
// outline still carries the edge (unchanged); on dark terrain this outer bright ring now
// does. The two rings together read against the whole 5-biome range without touching any
// enemy's identifying body/accent colour.
export const HALO = 0xfbfdff;

// #421: the halo above solves DARK terrain and only dark terrain. On LIGHT terrain (snow
// 0xd9e6ef, sand 0xbf9c5e) the enemy faction is a near-white machine (face 0xe7ecf1) whose only
// separation from the ground was the ~0.6-design-unit `outline` ring — sub-pixel-thin once the
// arena displays the sprite at ARENA_MECH_SCALE — and OUTSIDE that sat the bright halo, which on
// snow is simply more white. So the unit read as a pale blob with a hairline edge.
// `HALO_EDGE` closes that: one more ring, drawn OUTSIDE the halo in a near-black tone, so the
// silhouette now runs ground → dark edge → bright halo → dark outline → body. Whatever the
// terrain's tone, one of the two outer rings is always in strong contrast with it, and the
// enemy's identifying colours are still untouched. Deliberately thin (`HALO_EDGE_W` design
// units ≈ 1.4 display px at arena scale): the point is legibility, not a black rim on everything.
export const HALO_EDGE = 0x121821;
export const HALO_EDGE_W = 1.0;

// Per weapon-category glow ramps {halo, core, hot, edge}. Cores mirror CATEGORIES.color.
export const NEON = {
  energy:    { halo: 0x1390c8, core: 0x38d9ff, hot: 0xe6fbff, edge: 0x7fe6ff },
  ballistic: { halo: 0xc8801a, core: 0xffb24a, hot: 0xffe6b0, edge: 0xffcf85 },
  missile:   { halo: 0xc81f72, core: 0xff4fa3, hot: 0xffd0e6, edge: 0xff8cc2 },
  melee:     { halo: 0x9aa0ad, core: 0xcfd6e0, hot: 0xffffff, edge: 0xf2f4f7 },
  support:   { halo: 0x1f9c54, core: 0x6dff9e, hot: 0xd6ffe6, edge: 0xa6ffc6 },
};
export const neonFor = (catId) => NEON[catId] ?? NEON.melee;

// #433: run `fn` as EMISSIVE output — flag its draw ops as glow (`_glow`) so the two muzzle-bake
// gates treat them like glowDot/glowBar do. That's what lets the base-part bake OMIT them entirely
// (drawWeaponsAt raises `sg.glowSkip` → they bake transparent, not dark) while the glow-only overlay
// KEEPS them (`sg.glowOnly`). Wrap ANY coloured muzzle layer that isn't itself a glowDot/glowBar —
// a barrel edge-light, a rail slit, a plasma pool, a launch cell, a blade edge — so recombining the
// base part with its glow overlay reproduces the original single inline bake EXACTLY, per weapon.
// A no-op when neither gate is set (enemy mechs bake glow straight into the part).
export function emissive(sg, fn) {
  const prev = sg._glow; sg._glow = true;
  fn();
  sg._glow = prev;
}

// ── Low-level draw helpers (all in mech-local design coords: origin = centre, -y up).

// Filled polygon from [x,y] pairs.
export function poly(sg, pts, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillPoints(pts.map(([x, y]) => ({ x: CENTER + x, y: CENTER + y })), true);
}
// Centred filled rect.
export function rectC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillRect(CENTER + cx - w / 2, CENTER + cy - h / 2, w, h);
}
// Centred rounded rect (via the raw super-sampled graphics).
export function roundC(sg, cx, cy, w, h, fill, r, alpha = 1) {
  if (sg._blocked?.()) return;   // #433: suppressed during the glow-only overlay bake (it hits sg.raw directly)
  sg.fillStyle(fill, alpha);
  const k = ART_SCALE, rr = Math.min(r, w / 2, h / 2);
  // #422: this one primitive draws straight onto the raw R× graphics, so it has to apply the
  // scaledGraphics translate itself (every other primitive gets it for free). Zero unless a
  // `drawDilated` pass is running.
  const ox = sg.ox || 0, oy = sg.oy || 0;
  sg.raw.fillRoundedRect((CENTER + cx + ox - w / 2) * k, (CENTER + cy + oy - h / 2) * k, w * k, h * k, rr * k);
}
// Centred filled ellipse (used for soft glow pools).
export function ellipseC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillEllipse(CENTER + cx, CENTER + cy, w, h);
}
// Octagon (chamfered rect) point list — the angular plate primitive.
export function chamfer(cx, cy, w, h, c) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
          [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}

// #446 pass 2 — the FACETED plate outline, the enemy's angular counterpart to `chamfer`. A
// trapezoid narrower at the top (so both side edges slant) with all four corners cut back into
// chamfer planes: deep at the top, shallow at the bottom. Eight points, same as `chamfer`, so it
// drops into every place that took a chamfered octagon — including the halo/outline rings, which
// just call it at a larger size.
export function facet(cx, cy, w, h, c, taper = FACET_TAPER) {
  const hw = w / 2, hh = h / 2, tw = hw * (1 - taper), slope = hw - tw;
  const ct = Math.max(0.4, Math.min(c * 1.5, tw * 0.8, hh * 0.8));   // top corners: the deep cut
  const cb = Math.max(0.3, Math.min(c * 0.6, hw * 0.8, hh * 0.8));   // bottom corners: barely broken
  const dt = slope * (ct / h), db = slope * (cb / h);                // sideways drift along the slant
  return [
    [cx - tw + ct, cy - hh], [cx + tw - ct, cy - hh],
    [cx + tw + dt, cy - hh + ct], [cx + hw - db, cy + hh - cb],
    [cx + hw - cb, cy + hh], [cx - hw + cb, cy + hh],
    [cx - hw + db, cy + hh - cb], [cx - tw - dt, cy - hh + ct],
  ];
}

// The theme's plate OUTLINE primitive — faceted wedge (enemy) or symmetric chamfered octagon
// (player). Shared with the non-`plate` places that draw a plate-shaped inset (the cockpit core,
// the launcher boxes) so a faction has ONE silhouette language across the whole mech.
export function plateOutline(T, cx, cy, w, h, c) {
  return T.faceted ? facet(cx, cy, w, h, c) : chamfer(cx, cy, w, h, c);
}
// The default corner cut for a theme, as a fraction of the plate's short side.
export const plateCut = (T, w, h) => Math.min(w, h) * (T.faceted ? FACET_CUT : 0.22);

// A shaded armour plate: dark outline, mid face, a highlight rim catching overhead light, an
// ambient-occlusion shadow, and an optional panel seam. The player gets the symmetric chamfered
// octagon with orthogonal furniture (straight rim band, straight AO band, horizontal seam); the
// enemy gets the faceted wedge with DIAGONAL furniture — a shaded cut plane down its right side,
// a lit fold where the two planes meet, and a diagonal seam (#446 pass 2).
export function plate(sg, T, cx, cy, w, h, opts = {}) {
  const fill = opts.fill ?? T.face;
  const c = opts.chamfer ?? plateCut(T, w, h);
  const shape = (ww, hh, cc) => plateOutline(T, cx, cy, ww, hh, cc);
  if (T.legibilityHalo) {
    const e = HALO_EDGE_W;
    poly(sg, shape(w + 2.6 + e * 2, h + 2.6 + e * 2, c + 0.8 + e), HALO_EDGE);   // #421
    poly(sg, shape(w + 2.6, h + 2.6, c + 0.8), HALO);
  }
  poly(sg, shape(w + 1.2, h + 1.2, c + 0.4), T.outline);
  poly(sg, shape(w, h, c), fill);
  if (T.faceted) return facetFurniture(sg, T, cx, cy, w, h, c, opts);
  const inset = c;
  rectC(sg, cx, cy - h / 2 + h * 0.085, w - 2 * inset, h * 0.15, opts.rim ?? T.rim);
  rectC(sg, cx, cy + h / 2 - h * 0.08, w - 2 * inset, h * 0.13, T.ao, 0.5);
  if (opts.seam !== false) rectC(sg, cx, cy + h * 0.05, w * 0.58, Math.max(0.8, h * 0.04), T.grime, 0.7);
}

// The faceted plate's surface detail. Everything here runs on a DIAGONAL, which is the whole point:
// the previous pass kept the player's orthogonal bands on a near-rectangular plate, and horizontal
// stripes on a rectangle are exactly what reads as blocky. Order: the shaded second plane, the lit
// fold between the planes, a tapering rim strip along the (slanted) top edge, an AO wedge along the
// bottom, then a diagonal seam on the unshaded half.
function facetFurniture(sg, T, cx, cy, w, h, c, opts) {
  const hw = w / 2, hh = h / 2, tw = hw * (1 - FACET_TAPER);
  const ct = Math.max(0.4, Math.min(c * 1.5, tw * 0.8, hh * 0.8));
  // The cut plane: everything right of a diagonal ridge running from upper-left to lower-right,
  // a shade darker so the body reads as two surfaces meeting at an angle rather than one flat face.
  const ridgeTop = [cx - tw * 0.30, cy - hh + h * 0.12];
  const ridgeBot = [cx + hw * 0.12, cy + hh - h * 0.13];
  poly(sg, [ridgeTop, [cx + tw * 0.80, cy - hh + h * 0.12], [cx + hw * 0.80, cy + hh - h * 0.13], ridgeBot],
       opts.plane ?? T.faceDk);
  // The lit fold along that ridge — a hard bright line on the diagonal, the strongest angular cue
  // at arena size.
  thickLine(sg, ridgeTop[0], ridgeTop[1], ridgeBot[0], ridgeBot[1], Math.max(0.7, Math.min(w, h) * 0.07),
            opts.rim ?? T.rim, 0.85);
  // Rim strip hugging the top edge, tapering with it (a trapezoid, not a rectangle).
  poly(sg, [[cx - tw + ct * 0.85, cy - hh + h * 0.02], [cx + tw - ct * 0.85, cy - hh + h * 0.02],
            [cx + tw - ct * 1.25, cy - hh + h * 0.15], [cx - tw + ct * 1.25, cy - hh + h * 0.15]],
       opts.rim ?? T.rim);
  // AO wedge along the bottom, wider on the shaded side so the shadow leans with the fold.
  poly(sg, [[cx - hw * 0.86, cy + hh - h * 0.19], [cx + hw * 0.9, cy + hh - h * 0.12],
            [cx + hw * 0.9, cy + hh - h * 0.02], [cx - hw * 0.86, cy + hh - h * 0.02]], T.ao, 0.5);
  // A second, shorter panel line on the LIT half, parallel to nothing — a diagonal cut across the
  // corner, the kind of thing that reads as panelling rather than as a stripe.
  if (opts.seam !== false) {
    thickLine(sg, cx - tw * 0.78, cy + hh * 0.20, cx - tw * 0.05, cy - hh * 0.34,
              Math.max(0.7, Math.min(w, h) * 0.05), T.grime, 0.7);
  }
}

// Layered point-glow: wide faint halo → tighter halo → bright core → hot centre.
// #433: `_glow` is raised around the emission so these layers survive the glow-only overlay bake
// (scaledGraphics suppresses every other op) — the muzzle glow is the ONLY thing that texture keeps.
export function glowDot(sg, cx, cy, r, n) {
  const prev = sg._glow; sg._glow = true;
  sg.fillStyle(n.halo, 0.22); sg.fillCircle(CENTER + cx, CENTER + cy, r * 2.2);
  sg.fillStyle(n.halo, 0.5);  sg.fillCircle(CENTER + cx, CENTER + cy, r * 1.35);
  sg.fillStyle(n.core, 1);    sg.fillCircle(CENTER + cx, CENTER + cy, r);
  sg.fillStyle(n.hot, 1);     sg.fillCircle(CENTER + cx, CENTER + cy, r * 0.42);
  sg._glow = prev;
}
// Emissive bar (reactor spine / vent slits): halo spill → core → hot streak.
export function glowBar(sg, cx, cy, w, h, n) {
  const prev = sg._glow; sg._glow = true;
  rectC(sg, cx, cy, w * 1.9 + 1.4, h * 1.5 + 1.4, n.halo, 0.38);
  rectC(sg, cx, cy, w, h, n.core, 1);
  rectC(sg, cx, cy, w * 0.36, h * 0.7, n.hot, 1);
  sg._glow = prev;
}

// #400/#404: the center-torso STATUS SPOT — replaces the reactor spine's fixed purple with a
// data-driven indicator. This primitive is MEANING-AGNOSTIC: it renders whatever colour list
// the caller resolves (single-player → active-powerup colours; co-op → the player's identifying
// colour). The list decides the look: 0 colours → a dark "no powerup" core; 1 → a solid glowing
// bar; N → N sections stacked along the bar's length (a vertical spine reads top-to-bottom).
// A vertical bar of (cx,cy,w,h). Mirrors glowBar's glow language so it still reads as "core".
export function statusSpotBar(sg, cx, cy, w, h, colors) {
  if (!colors || colors.length === 0) {
    rectC(sg, cx, cy, w, h, STATUS_SPOT_DARK);         // dark core = no active powerup
    rectC(sg, cx, cy, w * 0.5, h * 0.86, 0x16181c);    // faint inner so it reads as a housing, not a hole
    return;
  }
  const n = colors.length;
  const top = cy - h / 2, seg = h / n;
  rectC(sg, cx, cy, w * 1.9 + 1.4, h * 1.5 + 1.4, colors[0], 0.32);   // soft glow halo behind the whole bar
  for (let i = 0; i < n; i++) {
    const sy = top + seg * (i + 0.5);
    rectC(sg, cx, sy, w, seg, colors[i], 1);                          // the section's own colour
    rectC(sg, cx, sy, w * 0.4, seg * 0.66, mixToWhite(colors[i], 0.5), 1); // hot center streak
  }
}

// #400 follow-up: a glowBar GLOW DESCRIPTOR ({halo,core,hot}) for the small center-torso vents that
// flank the spine, derived from the same status-spot colour list the spine consumes. The vents are
// too small to section, so they take the PRIMARY (first) colour of the list — black (matching
// statusSpotBar's dark core) when the list is empty (no powerup). Shaped like REACTOR so glowBar
// renders it, so the whole reactor cluster reads as one indicator: black when no powerup, the
// powerup colour when one is.
export const STATUS_SPOT_DARK = 0x0a0b0d;
export function statusSpotGlow(colors) {
  const core = colors && colors.length ? colors[0] : STATUS_SPOT_DARK;
  return { halo: mixToWhite(core, 0.12), core, hot: mixToWhite(core, 0.5) };
}

// Mix a 0xRRGGBB colour `t` of the way toward white (0 = colour, 1 = white). Local to the
// status-spot glow; kept tiny and dependency-free.
function mixToWhite(c, t) {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
  const m = (v) => Math.round(v + (255 - v) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

// A weapon barrel: a capsule (`roundBarrel` themes) or a plain dark bar. #446: the enemy's old
// glossy-ellipse barrel went with the rest of the bubbly mode, but the tube stays capsule-ended
// because a gun barrel genuinely IS round — that's the one part the de-facet doesn't apply to,
// which is why it has its own flag rather than riding on the plate mode.
export function barrel(sg, T, cx, cy, w, h) {
  return T.roundBarrel
    ? roundC(sg, cx, cy, w, h, T.faceDk, Math.min(w, h) * 0.45)
    : rectC(sg, cx, cy, w, h, T.faceDk);
}

// A thick line segment (a rotated quad) between two design-coord points — used to draw the
// frayed cabling / struts inside a torn-open panel.
function thickLine(sg, x0, y0, x1, y1, t, fill, alpha = 1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2), ny = (dx / len) * (t / 2);
  poly(sg, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], fill, alpha);
}

// #401 — the ARMOR-STRIPPED state, replacing the #246 "brackets bolted on top of an armored
// plate" read. The new direction (owner's): the clean base plate IS the fully-armored look, so
// full armor draws NOTHING extra. When a location's ARMOR is gone but its STRUCTURE still lives
// (distinct from `stump`, which is full destruction), a jagged panel is TORN OFF this part to
// bare the internals underneath — a dark cavity, a lit powered core, strut/actuator hardware,
// frayed multicoloured cabling and a couple of spark glints. Baked into the part texture (rebuilt
// only when armor breaks/returns, per the existing `armorBrokeNow` reskin gate), so the "spark"
// is a fixed hot glint, not a per-frame animation. Deterministic jag offsets keep it stable.
const INTERNAL_DARK = 0x0a0d13;   // the shadowed void behind the peeled shell
const INTERNAL_STRUT = 0x363d47;  // actuators / structural ribs inside
const SPARK = { halo: 0xffb04a, core: 0xffd98a, hot: 0xffffff, edge: 0xffcf85 };
const WIRES = [0xd23b3b, 0xe0b23a, 0x3ba0e0, 0x46c07a];  // frayed cabling (R/Y/B/G)
export function exposedInternals(sg, T, cx, cy, w, h) {
  const m = Math.min(w, h);
  // Jagged torn cavity: an 8-point ring with alternating in/out radii so the rim reads as
  // bent-back, ripped plating rather than a clean-cut hole. Fixed jag => stable across rebuilds.
  const rw = w * 0.36, rh = h * 0.36;
  const jag = [1.0, 0.62, 0.94, 0.68, 1.04, 0.6, 0.9, 0.7];
  const cav = jag.map((k, i) => {
    const a = (i / jag.length) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * rw * k, cy + Math.sin(a) * rh * k];
  });
  // Peeled-back metal lip (a larger, lighter torn edge) then the dark interior void.
  poly(sg, cav.map(([x, y]) => [(x - cx) * 1.18 + cx, (y - cy) * 1.18 + cy]), T.faceDk);
  poly(sg, cav.map(([x, y]) => [(x - cx) * 1.08 + cx, (y - cy) * 1.08 + cy]), T.outline);
  poly(sg, cav, INTERNAL_DARK);
  // A faint powered glow deep in the cavity — reads as "live machine still running inside."
  ellipseC(sg, cx, cy + h * 0.04, rw * 1.1, rh * 0.9, REACTOR.halo, 0.28);
  // Structural struts / actuator ribs behind the wiring.
  thickLine(sg, cx - rw * 0.55, cy - rh * 0.7, cx - rw * 0.35, cy + rh * 0.75, m * 0.1, INTERNAL_STRUT);
  thickLine(sg, cx + rw * 0.5, cy - rh * 0.75, cx + rw * 0.4, cy + rh * 0.7, m * 0.1, INTERNAL_STRUT);
  // Frayed cabling: a few thin coloured runs across the cavity at varied angles.
  thickLine(sg, cx - rw * 0.7, cy - rh * 0.3, cx + rw * 0.6, cy + rh * 0.2, Math.max(0.7, m * 0.05), WIRES[0]);
  thickLine(sg, cx - rw * 0.4, cy + rh * 0.6, cx + rw * 0.55, cy - rh * 0.55, Math.max(0.7, m * 0.05), WIRES[1]);
  thickLine(sg, cx - rw * 0.15, cy - rh * 0.75, cx + rw * 0.1, cy + rh * 0.7, Math.max(0.6, m * 0.045), WIRES[2]);
  thickLine(sg, cx + rw * 0.1, cy + rh * 0.5, cx - rw * 0.6, cy + rh * 0.1, Math.max(0.6, m * 0.045), WIRES[3]);
  // A couple of hot spark glints where the shell tore free.
  glowDot(sg, cx + rw * 0.45, cy - rh * 0.4, Math.max(0.9, m * 0.07), SPARK);
  glowDot(sg, cx - rw * 0.5, cy + rh * 0.45, Math.max(0.7, m * 0.05), SPARK);
}

// A destroyed location: a charred lump with faint embers.
export function stump(sg, T, cx, cy, w, h) {
  const m = Math.min(w, h);
  if (T.legibilityHalo) {
    const e = HALO_EDGE_W;
    poly(sg, plateOutline(T, cx, cy, w * 0.62 + 1.4 + e * 2, h * 0.5 + 1.4 + e * 2, m * 0.14 + 0.4 + e), HALO_EDGE);   // #421
    poly(sg, plateOutline(T, cx, cy, w * 0.62 + 1.4, h * 0.5 + 1.4, m * 0.14 + 0.4), HALO);
  }
  poly(sg, plateOutline(T, cx, cy, w * 0.62, h * 0.5, m * 0.14), T.outline);
  poly(sg, plateOutline(T, cx, cy, w * 0.56, h * 0.44, m * 0.14), T.char);
  sg.fillStyle(0x7a2a12, 0.6); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.12);
  sg.fillStyle(0xd6601e, 0.5); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.06);
}
