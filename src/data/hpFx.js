// #495 follow-up (Jackson, EXPLICITLY experimental — "can we try out a random flicker and some
// opacity changes and some 'static' effects, maybe some sparks?" for the fused readout's HP wash):
// a first pass to react to LIVE, not a locked spec. Kept entirely in this one small pure module —
// no per-tile state, nothing threaded into the readout's core layout math (healthReadout.js) —
// specifically so it is trivial to rip back out or retune: delete this file and the two call
// sites in HudScene's `_paintFusedReadout` if Jackson doesn't like it in motion.
//
// Every function here is a HASH, not `Math.random()` — the same "seeded pseudo-random via a sine
// hash" idiom `art/projectileArt.js`'s beam sparks already use (`Math.sin(x) * 43758.5453`,
// fractional part, floored to a uniform [0,1)). That means there is no per-tile particle STATE to
// track or clean up anywhere: a value at a given (seed, time-step) is exactly reproducible, so
// HudScene can recompute the whole effect fresh every frame from `scene.time.now` alone and throw
// it away — cheap (a handful of `Math.sin` calls per tile), and nothing here can leak.
function hash(seed) {
  const s = Math.sin(seed) * 43758.5453;
  return s - Math.floor(s);
}

// How "urgent" the electronics-damage look should read at this HP fraction — 0 near full health
// (flat and calm), ramping up as the part empties. Deliberately NOT linear: barely anything above
// ~70% hp, with most of the ramp packed into the last third, so a scratch doesn't glitch but a
// dying part visibly does.
export function hpUrgency(hpFrac) {
  const f = Math.max(0, Math.min(1, hpFrac ?? 0));
  const t = Math.max(0, 1 - f / 0.7);   // 0 above 70% hp, 1 at 0% hp
  return t * t;                          // eased — the ramp is back-loaded toward empty
}

// FLICKER + OPACITY: a multiplier to apply to the HP wash's existing alpha, centred on 1. `tSec`
// is a free-running clock (scene.time.now / 1000 — nothing here needs to start at zero); `seed`
// should differ per tile (its index in TILE_ORDER is enough) so tiles don't strobe in lockstep.
// Quantised into short discrete steps rather than a smooth sine — a STEPPED jitter is what reads
// as "flicker" rather than "pulse" — and the step RATE (how often it re-rolls) speeds up with
// urgency too, so a badly hurt part strobes faster as well as further.
export function hpFlicker(tSec, seed, urgency) {
  if (urgency <= 0) return 1;
  const rate = 4 + urgency * 16;                       // re-rolls/sec: calm drift → fast strobe
  const step = Math.floor(tSec * rate);
  const j = hash(step + seed * 13.7);                  // 0..1, held for one step's duration
  const amp = 0.6 * urgency;                            // how far the multiplier can swing off 1
  return 1 - amp + j * amp * 2;                          // ranges [1-amp, 1+amp]
}

// STATIC: a handful of small noise specks scattered over `rect`, count and brightness both
// scaling with urgency. Reshuffles on its own short cadence (independent of the flicker rate)
// so the two effects don't lock into the same visual beat.
export function hpStaticSpecks(rect, tSec, seed, urgency) {
  if (urgency <= 0) return [];
  const n = Math.round(5 * urgency);
  if (n <= 0) return [];
  const rate = 18;                                      // reshuffles ~18×/sec — reads as noise
  const step = Math.floor(tSec * rate);
  const specks = [];
  for (let i = 0; i < n; i++) {
    const hx = hash(step * 3.1 + seed * 11.7 + i * 5.3);
    const hy = hash(step * 4.7 + seed * 17.9 + i * 8.1 + 50);
    const ha = hash(step * 2.3 + seed * 6.1 + i * 3.7 + 200);
    specks.push({
      x: rect.x + hx * rect.w,
      y: rect.y + hy * rect.h,
      size: 1 + ha * 2.2,
      alpha: 0.25 + ha * 0.55,
    });
  }
  return specks;
}

// SPARKS: at most one small accent per tile per "window" (~1/2.2s), existing only once urgency
// clears a floor (no sparks on a lightly-scratched part) and even then only on a per-window coin
// flip whose odds improve with urgency — occasional at moderate damage, near-constant right
// before the part goes. Each spark carries a `life` (0..1) that fades it in then out across its
// own window via a half-sine envelope, so — again — nothing needs to persist between frames: the
// spark you see this frame and the one you'll see three frames from now are the SAME reproducible
// value at a slightly later `tSec`, not two different objects being tracked.
export function hpSparks(rect, tSec, seed, urgency) {
  if (urgency < 0.15) return [];
  const rate = 2.2;
  const raw = tSec * rate;
  const step = Math.floor(raw);
  const roll = hash(step * 9.7 + seed * 3.3);
  if (roll > urgency * 0.9) return [];
  const localT = raw - step;                            // 0..1 progress through this window
  const life = Math.sin(localT * Math.PI);                // fades in, peaks mid-window, out
  if (life <= 0.02) return [];
  const hx = hash(step * 5.1 + seed * 7.7 + 300);
  const hy = hash(step * 6.3 + seed * 4.1 + 400);
  const hang = hash(step * 8.9 + seed * 2.9 + 500);
  return [{ x: rect.x + hx * rect.w, y: rect.y + hy * rect.h, angle: hang * Math.PI * 2, life }];
}

// CRITICAL FLASH: a new playtest ask, LAYERED alongside the flicker/static/sparks above rather
// than replacing them — a distinct red "alarm" pulse gated on genuinely LOW hp, not just "some
// urgency". #526's own playtest removed the continuous blue→purple→red colour WASH-by-health
// (Jackson: "for now just keep the flicker/static/sparks"); this is a DIFFERENT mechanism, not a
// reintroduction of that ramp — it does nothing at all above `HP_CRITICAL_FRAC`, and below it
// rides a plain sine PULSE (not the flicker's stepped jitter) so it reads as a deliberate alarm
// rather than more of the same damage noise. Pure and reproducible from (hpFrac, tSec) alone, same
// idiom as the rest of this module.
export const HP_CRITICAL_FRAC = 0.2;   // hp fraction at/below which the flash can appear at all
const HP_CRITICAL_PULSE_HZ = 6.5;      // radians/sec fed to Math.sin — a brisk but readable pulse

export function hpCriticalFlash(hpFrac, tSec) {
  const f = Math.max(0, Math.min(1, hpFrac ?? 0));
  if (f <= 0 || f > HP_CRITICAL_FRAC) return 0;   // destroyed (f<=0) parts get their own dead fill
  const closeness = 1 - f / HP_CRITICAL_FRAC;     // 0 right at the threshold, 1 at hp 0
  const pulse = 0.5 + 0.5 * Math.sin(tSec * HP_CRITICAL_PULSE_HZ);
  return closeness * (0.25 + 0.55 * pulse);
}
