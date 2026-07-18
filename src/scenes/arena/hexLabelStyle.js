// #270 playtest follow-up: bases.js's original dock/alertTower/turretEmplacement labels and
// terrainLabels.js's newer per-terrain labels used to carry two different looks (bold red vs.
// muted gray) — Jackson asked for ONE shared style so they read as a single system and the two
// files can't drift apart again. Both files import this instead of hardcoding their own
// color/size/weight.
export const HEX_LABEL_COLOR = '#ff4444';
export const HEX_LABEL_FONT_SIZE = '11px';
export const HEX_LABEL_FONT_STYLE = 'bold';
