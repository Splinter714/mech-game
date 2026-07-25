// #506 — replaces dashTrigger.test.js. Exercises `FiringMixin._handleAbilities` (arena/firing.js)
// directly against a minimal fake scene/player (mirrors the pattern already used in
// sprintOverclock.test.js/crush.test.js), with a mech that has Dash mounted in one ability slot
// — the same 'dash' effect kind the old hardcoded _handleDash drove, now routed through the
// generic ability system. Controls.js's own rising-edge detection for `intent.ability` is
// covered separately in Controls.test.js — this file assumes a caller already handed it a clean
// one-shot press per physical press, same as the arena does.
import { describe, it, expect } from 'vitest';
import { FiringMixin } from './firing.js';
import { initAbilityStates } from './abilities.js';
import { DASH_BURST_DURATION, DASH_COOLDOWN } from '../../data/abilities.js';

function makeScene() {
  const player = {
    mech: { abilityMounts: { abilityY: 'dash', abilityB: null, abilityA: null, abilityX: null } },
    abilityStates: initAbilityStates(),
  };
  const scene = { registry: { set() {} } };
  Object.assign(scene, FiringMixin);
  return { scene, player };
}

function press(scene, player, slot, delta) {
  const ability = { abilityY: false, abilityB: false, abilityA: false, abilityX: false, [slot]: true };
  scene._handleAbilities({ ability }, delta, player);
}
function release(scene, player, delta) {
  scene._handleAbilities({ ability: { abilityY: false, abilityB: false, abilityA: false, abilityX: false } }, delta, player);
}

describe('#506 _handleAbilities — Dash mounted in an ability slot', () => {
  it('a press triggers the burst immediately', () => {
    const { scene, player } = makeScene();
    press(scene, player, 'abilityY', 16);
    expect(player.abilityStates.abilityY.active).toBe(true);
  });

  it('the burst ends on its own after DASH_BURST_DURATION, without another press', () => {
    const { scene, player } = makeScene();
    press(scene, player, 'abilityY', 16);
    expect(player.abilityStates.abilityY.active).toBe(true);

    release(scene, player, DASH_BURST_DURATION * 1000);
    expect(player.abilityStates.abilityY.active).toBe(false);
  });

  it('pressing again mid-burst does nothing — no restart, no extension', () => {
    const { scene, player } = makeScene();
    press(scene, player, 'abilityY', 16);
    const burstAfterFirstPress = player.abilityStates.abilityY.burstRemaining;

    press(scene, player, 'abilityY', 16);
    expect(player.abilityStates.abilityY.active).toBe(true);
    expect(player.abilityStates.abilityY.burstRemaining).toBeLessThanOrEqual(burstAfterFirstPress);
  });

  it('pressing again mid-cooldown does nothing until it clears, then works', () => {
    const { scene, player } = makeScene();
    press(scene, player, 'abilityY', 16);
    release(scene, player, DASH_BURST_DURATION * 1000);
    expect(player.abilityStates.abilityY.cooldown).toBeGreaterThan(0);

    press(scene, player, 'abilityY', 16);
    expect(player.abilityStates.abilityY.active).toBe(false);

    release(scene, player, (DASH_COOLDOWN + 1) * 1000);
    press(scene, player, 'abilityY', 16);
    expect(player.abilityStates.abilityY.active).toBe(true);
  });

  it('an unmounted slot never activates, however it is pressed', () => {
    const { scene, player } = makeScene();
    press(scene, player, 'abilityB', 16);
    expect(player.abilityStates.abilityB.active).toBe(false);
  });
});
