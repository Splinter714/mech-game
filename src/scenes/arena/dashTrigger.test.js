// #261 — Dash replaced player-facing Sprint on L3/Space. This exercises
// `FiringMixin._handleDash` (arena/firing.js) directly against a minimal fake scene (mirrors
// the pattern already used in sprintOverclock.test.js/crush.test.js), since the real thing is a
// Phaser-scene mixin method that reads `this.dash`/`this.registry`. Controls.js's own
// rising-edge detection for `intent.dashPressed` is covered separately in Controls.test.js —
// this file assumes a caller already handed it a clean one-shot press per physical press, same
// as the arena does.
import { describe, it, expect } from 'vitest';
import { FiringMixin } from './firing.js';
import { initialDashState, DASH_BURST_DURATION, DASH_COOLDOWN } from '../../data/dash.js';

function makeScene() {
  const scene = {
    dash: initialDashState(),
    registry: { set() {} },
  };
  Object.assign(scene, FiringMixin);
  return scene;
}

describe('#261 _handleDash — press-to-trigger burst + cooldown', () => {
  it('a press triggers the burst immediately', () => {
    const scene = makeScene();
    scene._handleDash({ dashPressed: true }, 16);
    expect(scene.dash.active).toBe(true);
  });

  it('the burst ends on its own after DASH_BURST_DURATION, without another press', () => {
    const scene = makeScene();
    scene._handleDash({ dashPressed: true }, 16);
    expect(scene.dash.active).toBe(true);

    scene._handleDash({ dashPressed: false }, DASH_BURST_DURATION * 1000);
    expect(scene.dash.active).toBe(false);
  });

  it('pressing again mid-burst does nothing — no restart, no extension', () => {
    const scene = makeScene();
    scene._handleDash({ dashPressed: true }, 16);
    expect(scene.dash.active).toBe(true);
    const burstAfterFirstPress = scene.dash.burstRemaining;

    // A little time passes, then the player mashes the button again mid-burst.
    scene._handleDash({ dashPressed: true }, 16);
    expect(scene.dash.active).toBe(true);
    // Burst did not reset back up to full — the repeat press was ignored.
    expect(scene.dash.burstRemaining).toBeLessThanOrEqual(burstAfterFirstPress);
  });

  it('pressing again mid-cooldown (after the burst has ended) does nothing until it clears', () => {
    const scene = makeScene();
    scene._handleDash({ dashPressed: true }, 16);
    scene._handleDash({ dashPressed: false }, DASH_BURST_DURATION * 1000); // burst ends
    expect(scene.dash.active).toBe(false);
    expect(scene.dash.cooldown).toBeGreaterThan(0);

    scene._handleDash({ dashPressed: true }, 16);   // spammed re-press, still cooling down
    expect(scene.dash.active).toBe(false);

    // Advance to just short of the remaining cooldown — still refused.
    const remaining = scene.dash.cooldown;
    scene._handleDash({ dashPressed: false }, (remaining - 0.05) * 1000);
    scene._handleDash({ dashPressed: true }, 16);
    expect(scene.dash.active).toBe(false);
  });

  it('can be re-triggered once the cooldown fully clears', () => {
    const scene = makeScene();
    scene._handleDash({ dashPressed: true }, 16);   // first dash
    scene._handleDash({ dashPressed: false }, (DASH_COOLDOWN + 1) * 1000);   // let it fully clear
    expect(scene.dash.cooldown).toBe(0);

    scene._handleDash({ dashPressed: true }, 16);   // second dash, now ready
    expect(scene.dash.active).toBe(true);
  });

  // #450: the HUD's dash cooldown bar is gone, and with it the `dashActive`/`dashCooldown`/
  // `dashCooldownMax` channels that existed only to feed it. The state machine above is
  // untouched — this pins that the dash no longer publishes anything at all.
  it('publishes no dash channels to the registry — nothing reads them since #450', () => {
    const published = {};
    const scene = makeScene();
    scene.registry = { set: (k, v) => { published[k] = v; } };

    scene._handleDash({ dashPressed: true }, 16);
    scene._handleDash({ dashPressed: false }, DASH_BURST_DURATION * 1000);
    expect(Object.keys(published)).toEqual([]);
  });
});
