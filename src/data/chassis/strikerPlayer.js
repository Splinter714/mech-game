// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Originally
// revived only the old (removed, commit a164564) Striker chassis' `bodyLen`/`bodyWid`/`accent` —
// `git show f8f3707:src/data/chassis/striker.js` — but that chassis never actually had distinct
// GEOMETRY (it only scaled the medium's proportions), and Jackson called that out after playing:
// "the new chassis you added are just bigger versions of the same geometry; a long time ago we
// had legitimately different geometry". The real per-chassis silhouette system that followed
// (#24, `art.shape` — see light.js/medium.js/heavy.js and mechArt.js's `shapeOf`/`mechLayout`)
// postdates Striker/Colossus, so this is that system applied to Striker for the first time: a
// lean, forward-leaning recon-harasser silhouette echoing the Striker's original "fast, lightly-
// armored harasser... quicker and twitchier than the medium Trooper" flavor and light.js's own
// scout-silhouette vocabulary (smaller head thrust forward, slim torso, long reaching arms, wide
// light stance, sensor mast + swept vanes) — NOT a re-scaled Trooper.
//
// Deliberately keeps every STAT identical to mediumPlayer.js (movement, totalArmor, totalHp) per
// Jackson's own words: "same stats, just different art cosmetically." Only `id`/`name`/`art`
// differ from MEDIUM_PLAYER_CONFIG; everything else is spread through so the two can never drift
// on the things meant to match.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const STRIKER_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'strikerPlayer',
  name: 'Striker',
  art: {
    ...MEDIUM_PLAYER_CONFIG.art,
    bodyLen: 34, bodyWid: 26, accent: 0x49e88f,
    // A leaner, more angular recon-lean silhouette, not just a smaller Trooper: a
    // narrower head/torso thrust forward, longer thin arms reaching further forward, a
    // wider-set light-footed stance. `legSpread`/`legW`/`legH`/`legDrop` still build on the
    // player's own #438 leg tuning (inherited above) rather than reverting to DEFAULT_SHAPE.
    shape: {
      ...MEDIUM_PLAYER_CONFIG.art.shape,
      head: 0.8, torso: 0.88, sideTorso: 0.85,
      armW: 0.7, armH: 1.3, armSpread: 1.15,
      legW: 0.78, legSpread: 1.55, legH: 1.3,
      headDy: -0.05, armDy: -0.06,
    },
    // Sensor mast + swept-back vanes, same recon vocabulary as light.js — a Striker reads
    // as a twitchy harasser, not a re-skinned Trooper.
    decor: [{ kind: 'mast', side: -1 }, { kind: 'vane', side: -1 }, { kind: 'vane', side: 1 }],
  },
};
