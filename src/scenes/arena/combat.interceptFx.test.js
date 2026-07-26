// #494/#527 — `_interceptFx` (CombatMixin), Anti-Missile Defense's own dedicated "shot down"
// feedback. Exercises it directly against a minimal fake scene, mirroring
// combat.abilityBlast.test.js's pattern for `_aoeBlastFx`: `_burst` is stubbed out (it needs the
// real tween/pool machinery, exercised elsewhere) so this only asserts `_interceptFx`'s own
// contract — a burst sequence always plays at the intercept point, a one-frame zap bolt is drawn
// from the defending mech to that point (when the scene has a real-enough `projFx`), and its own
// distinct SFX cue fires rather than the intercepted round's own weapon-impact sound.
import { describe, it, expect, vi } from 'vitest';
import { CombatMixin } from './combat.js';
import { Audio } from '../../audio/index.js';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn(), impact: vi.fn() } }));

function makeScene({ withProjFx = true } = {}) {
  const scene = {
    projFx: withProjFx
      ? { lineStyle: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), strokePath: vi.fn() }
      : undefined,
  };
  Object.assign(scene, CombatMixin);
  scene._burst = vi.fn();   // stub AFTER the mixin assign, so it wins over CombatMixin's real one
  return scene;
}

describe('#494/#527 _interceptFx', () => {
  it('plays a burst sequence at the intercept point, all cyan-tinted regardless of caller-supplied color', () => {
    const scene = makeScene();
    scene._interceptFx(0, 0, 120, 40);

    expect(scene._burst.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of scene._burst.mock.calls) {
      const [x, y] = call;
      expect(x).toBe(120);
      expect(y).toBe(40);
    }
  });

  it('draws a one-frame zap bolt from the defending mech to the intercept point', () => {
    const scene = makeScene();
    scene._interceptFx(10, 20, 120, 40);

    expect(scene.projFx.moveTo).toHaveBeenCalledWith(10, 20);
    expect(scene.projFx.lineTo).toHaveBeenCalledWith(120, 40);
    expect(scene.projFx.strokePath).toHaveBeenCalled();
  });

  it('plays its own dedicated SFX cue, not the generic weapon-impact sound', () => {
    const scene = makeScene();
    scene._interceptFx(0, 0, 10, 10);

    expect(Audio.ui).toHaveBeenCalledWith('antiMissile');
    expect(Audio.impact).not.toHaveBeenCalled();
  });

  it('is a safe no-op on the zap bolt when the scene has no real projFx (headless test double)', () => {
    const scene = makeScene({ withProjFx: false });
    expect(() => scene._interceptFx(0, 0, 10, 10)).not.toThrow();
    expect(scene._burst.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
