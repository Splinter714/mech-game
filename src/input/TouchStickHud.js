// #346: draws the on-screen touch sticks. Presentation only — every bit of geometry comes
// from the pure `TouchSticks` model (`touchSticks.js`), which is where the tuning dials and
// the unit tests live. Nothing here feeds the input intent.
//
// Screen-space overlay: `setScrollFactor(0)` so it ignores the arena camera, drawn at a
// depth above the world. Invisible until a finger actually lands, so a touchscreen laptop
// being driven by mouse+keyboard never sees it.

import { TOUCH_STICK, fixedOrigins } from './touchSticks.js';

const DEPTH = 9000;
const RING = 0x8fd6ff;
const KNOB = 0xd8f2ff;

export class TouchStickHud {
  constructor(scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    this.g.setScrollFactor(0).setDepth(DEPTH);
  }

  // Call once per frame with the live TouchSticks model (or null/undefined for no touch).
  draw(sticks) {
    const g = this.g;
    g.clear();
    if (!sticks || !sticks.used) return;

    // In fixed mode, show faint resting rings so the player knows where the sticks are.
    if (!TOUCH_STICK.floating) {
      const anchors = fixedOrigins(sticks.width, sticks.height, TOUCH_STICK);
      for (const side of ['move', 'aim']) {
        if (sticks.stickState(side)) continue;
        g.lineStyle(2, RING, 0.18);
        g.strokeCircle(anchors[side].x, anchors[side].y, TOUCH_STICK.radius);
      }
    }

    for (const side of ['move', 'aim']) {
      const s = sticks.stickState(side);
      if (!s) continue;
      const { origin, knob } = s;
      g.lineStyle(3, RING, 0.45);
      g.strokeCircle(origin.x, origin.y, TOUCH_STICK.radius);
      g.lineStyle(2, RING, 0.25);
      g.strokeCircle(origin.x, origin.y, TOUCH_STICK.radius * TOUCH_STICK.deadzone);
      g.fillStyle(KNOB, 0.35);
      g.fillCircle(origin.x + knob.x, origin.y + knob.y, TOUCH_STICK.radius * 0.36);
      g.lineStyle(2, KNOB, 0.7);
      g.strokeCircle(origin.x + knob.x, origin.y + knob.y, TOUCH_STICK.radius * 0.36);
    }
  }

  destroy() {
    this.g?.destroy();
    this.g = null;
  }
}
