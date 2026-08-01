// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Originally
// revived only the old (removed, commit a164564) Striker chassis' `bodyLen`/`bodyWid`/`accent` —
// `git show f8f3707:src/data/chassis/striker.js` — but that chassis never actually had distinct
// GEOMETRY (it only scaled the medium's proportions), and Jackson called that out after playing:
// "the new chassis you added are just bigger versions of the same geometry; a long time ago we
// had legitimately different geometry". The real per-chassis silhouette system that followed
// (#24, `art.shape` — see mechArt.js's `shapeOf`/`mechLayout`) postdates Striker/Colossus, so
// this is that system applied to Striker for the first time: a lean, forward-leaning recon-
// harasser silhouette echoing the Striker's original "fast, lightly-armored harasser... quicker
// and twitchier than the medium Trooper" flavor and the Scout's own scout-silhouette vocabulary
// (smaller head thrust forward, slim torso, long reaching arms, wide light stance, swept vanes)
// — NOT a re-scaled Trooper.
//
// 2026-07-31 live-chat: Jackson pointed at the ART PREVIEW's "PLAYER BUILD — light" cell and said
// he wanted THAT silhouette back. That cell renders the player theme on the `light` chassis, so
// what he was looking at is enemy/light.js's geometry — not the approximation of it this file had
// been carrying (dials derived by hand and, layered over mediumPlayer's shape, coming out a size
// larger with the arms splayed wide and a very wide stance: bodyLen 34 vs 30, armSpread 1.15 vs
// 0.8, legSpread 1.55 vs 1.02, which is exactly why it read as a milder Trooper). So the `art`
// below was MATCHED to that preview cell: same body size, same proportions, same decor.
//
// Asked whether to keep the player's own #438 leg tuning or take the light's legs, Jackson chose
// the light's ("match the preview exactly") — hence the narrow light-footed stance below rather
// than mediumPlayer's planted one.
//
// It briefly did that by spreading `LIGHT_CONFIG.art` wholesale, so the preview cell and the
// player's Striker "could not drift". That is now INVERTED — live-chat ask (2026-07-31): "can we
// actually split out the enemy chassis as separate code to be tweaked separately from the player
// chassis code?" The art below is an independent COPY of what enemy/light.js held at the moment
// of the split, and the two are free to diverge: retuning the enemy Scout's silhouette will no
// longer move the player's Striker, and the art-preview's "PLAYER BUILD — light" cell (which
// still renders the enemy light chassis) is no longer a guarantee of what this looks like.
//
// STATS deliberately stay identical to mediumPlayer.js, per Jackson's own words: "same stats,
// just different art cosmetically." That coupling is INSIDE the player group and is the point of
// the chassis-select tab, so it stays a spread — only `id`/`name`/`art` differ. The light's own
// lighter/faster stat block is still deliberately NOT taken.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const STRIKER_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'strikerPlayer',
  name: 'Striker',
  // Insectoid recon silhouette (#24): a tiny head thrust well FORWARD, long thin arms reaching
  // forward, a slim torso flanked by swept-back vanes, and a wide splayed light-footed stance.
  // Copied off enemy/light.js at the 2026-07-31 split — the vanes ride the pivoting SHOULDER
  // textures (mechArt.js SHOULDER_DECOR) so they cant with the shoulder, and the tall sensor mast
  // that used to sit over the head is gone (live-chat ask, same day: "remove mast decor from
  // light mech" — the vanes carry the recon read on their own).
  art: {
    bodyLen: 30, bodyWid: 22, accent: 0x49c2e8,
    shape: { head: 0.78, torso: 0.9, shoulder: 0.9, armW: 0.62, armH: 1.45, armSpread: 0.8, legW: 0.62, legH: 1.42, legSpread: 1.02, legDrop: 1.08, headDy: -0.03, armDy: -0.04 },
    decor: [{ kind: 'vane', side: -1 }, { kind: 'vane', side: 1 }],
  },
};
