// Shared ability-FX specs (#534) — the ONE description of what an ability's signature blast
// looks like, read by two renderers that would otherwise drift apart:
//
//   * the ARENA (`scenes/arena/combat.js` `_aoeBlastFx` / `_interceptFx`) plays each ring at
//     world scale through its pooled impact-circle + tween machinery;
//   * the CATALOG CARD (`ui/abilityPreview.js`, the animated garage preview) replays the exact
//     same rings at card scale with a plain Graphics redraw each frame.
//
// This is the same "no fake harness" principle the weapon cards already follow by live-firing
// through `data/delivery.js`: an ability preview has to show what the ability ACTUALLY does, so
// retuning a blast here retunes both surfaces at once rather than leaving the card showing a
// hand-drawn impression of an effect that's since moved.
//
// A ring is `{ r0, r1, color, alpha, dur, stroke }` — deliberately the exact argument list
// `_burst(x, y, r0, r1, col, alpha, dur, stroke)` already took, so the arena side is a straight
// loop over these with no translation step in between.

// #498's radius-SIZED AoE blast: a bright core flash, a shockwave ring that grows past the
// ability's actual radius, and a slower afterglow fill so the affected area itself reads for a
// beat. Used by Shield Burst (#490) and by both edges of Jump Blast (#498), each at its own
// radius/tint — the shape is shared, the numbers come from the ability's own data.
export function aoeBlastRings(radius, color) {
  return [
    { r0: radius * 0.15, r1: radius * 0.6, color: 0xffffff, alpha: 0.95, dur: 140, stroke: false },
    { r0: radius * 0.3, r1: radius * 1.05, color, alpha: 0.85, dur: 260, stroke: true },
    { r0: radius * 0.2, r1: radius * 0.8, color, alpha: 0.35, dur: 320, stroke: false },
  ];
}

// #527's Anti-Missile "shot down" burst — always cyan regardless of what got intercepted, and
// deliberately bigger/longer-held than an ordinary weapon impact spark so it can't be mistaken
// for one. Sizes are absolute (not radius-derived): an intercept is a point event, not an area.
export function interceptRings() {
  return [
    { r0: 4, r1: 16, color: 0xffffff, alpha: 1, dur: 100, stroke: false },
    { r0: 6, r1: 32, color: 0x5ec8e0, alpha: 0.9, dur: 280, stroke: true },
    { r0: 4, r1: 20, color: 0x5ec8e0, alpha: 0.5, dur: 220, stroke: false },
  ];
}

// The one-frame "zap" bolt drawn from the defending mech to the intercept point (#527) — the bit
// that makes an intercept read as *the mech doing something* rather than a spark in open air.
export const INTERCEPT_BOLT_COLOR = 0xbdf3ff;

// How long a ring set takes to finish, in ms — the card preview uses this to hold a phase open
// long enough for the blast to actually play out (Shield Burst's own `duration` is 0.15s, well
// under its 320ms afterglow).
export function ringsDuration(rings) {
  return rings.reduce((m, r) => Math.max(m, r.dur), 0);
}

// Replay a ring set into a Graphics at `ageMs` into its life, optionally scaled (the card shows
// world radii shrunk to fit its stage). Reproduces what the arena's tween does to a pooled
// circle: linear growth r0 → r1 (Phaser's default ease is linear) with alpha fading to 0 over
// `dur`. Rings past their duration simply draw nothing, so a caller can keep replaying a set
// until `ringsDuration` has elapsed without tracking each ring separately.
export function drawFxRings(g, cx, cy, rings, ageMs, scale = 1) {
  for (const r of rings) {
    if (ageMs < 0 || ageMs >= r.dur) continue;
    const f = ageMs / r.dur;
    const rad = (r.r0 + (r.r1 - r.r0) * f) * scale;
    const a = r.alpha * (1 - f);
    if (rad <= 0 || a <= 0) continue;
    if (r.stroke) g.lineStyle(Math.max(1, 2 * scale), r.color, a).strokeCircle(cx, cy, rad);
    else g.fillStyle(r.color, a).fillCircle(cx, cy, rad);
  }
}
