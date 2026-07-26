// The perceptual-luminance greyscale conversion behind Cloak's "remove ALL colour from the mech"
// visual (#500 playtest follow-up: "camoflage/cloaking ability needs to remove color from the
// mech except for the multiplayer color ring"). Pulled out as its own pure module because it's
// the one piece of the fix that's actually testable without a live Phaser scene/canvas — the
// per-pixel bake itself (mechArt.js `desaturateTexture`) needs a real `<canvas>` and stays
// unit-test-free like the rest of the art layer (verified live instead, per CLAUDE.md).
//
// Rec. 601 luma weights (the standard "grey out a colour photo" formula), not a flat (r+g+b)/3
// average — human vision is far more sensitive to green than to red or blue, so an equal-average
// would make a saturated green panel read brighter than an equally-bright red one stays too dark.
//
// Why this has to be a PER-PIXEL formula at all, rather than a Phaser sprite tint: `setTint`
// multiplies each channel by a constant (`out = texture * tint`), which preserves every pixel's
// hue/saturation ratio exactly — it can only dim or colour-cast a sprite, never desaturate one.
// A saturated red panel (255,0,0) tinted by ANY grey (say 0x808080 → ×0.5) becomes (128,0,0):
// still fully-saturated red, just darker. That's why the original tint-based Cloak (a pale
// steel-blue-grey wash) still read as "has colour" once a player's saturated accent/rim-highlight
// hue was under it — the earlier playtest fix that added CLOAK_TINT/CLOAK_ALPHA in abilities.js
// only ever added a wash on TOP of the existing colours, never removed them. Collapsing R, G and B
// to the SAME value per pixel is the only way to actually zero out saturation.
export function luminanceGrey(r, g, b) {
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  return Math.max(0, Math.min(255, Math.round(grey)));
}
