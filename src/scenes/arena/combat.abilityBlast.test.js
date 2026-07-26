// #498 — `_aoeBlastFx` (CombatMixin), the shared "you felt that" AoE blast used by Jump Blast's
// launch/landing beats (scenes/arena/abilities.js). Exercises it directly against a minimal fake
// scene: `_burst` is stubbed out (it needs the real tween/pool machinery, which is exercised
// elsewhere) so this test only asserts `_aoeBlastFx`'s own contract — it always plays a burst
// sequence and a camera shake, scaled off the radius it's given, and never throws when the scene
// has no camera at all (a headless/test double).
import { describe, it, expect, vi } from 'vitest';
import { CombatMixin } from './combat.js';

function makeScene({ withCamera = true } = {}) {
  const scene = {
    cameras: withCamera ? { main: { shake: vi.fn(), height: 800 } } : undefined,
  };
  Object.assign(scene, CombatMixin);
  scene._burst = vi.fn();   // stub AFTER the mixin assign, so it wins over CombatMixin's real one
  return scene;
}

describe('#498 _aoeBlastFx', () => {
  it('plays a core flash + shockwave ring + afterglow, all sized off the given radius', () => {
    const scene = makeScene();
    scene._aoeBlastFx(100, 200, 80, 0xffcf8a);

    expect(scene._burst).toHaveBeenCalledTimes(3);
    for (const call of scene._burst.mock.calls) {
      const [x, y, r0, r1] = call;
      expect(x).toBe(100);
      expect(y).toBe(200);
      expect(r0).toBeLessThan(80);
      expect(r1).toBeGreaterThan(0);
    }
  });

  it('shakes the camera, harder for a bigger radius', () => {
    const scene = makeScene();
    scene._aoeBlastFx(0, 0, 40, 0xffffff);
    const smallShake = scene.cameras.main.shake.mock.calls[0][1];

    const scene2 = makeScene();
    scene2._aoeBlastFx(0, 0, 200, 0xffffff);
    const bigShake = scene2.cameras.main.shake.mock.calls[0][1];

    expect(bigShake).toBeGreaterThan(smallShake);
  });

  it('caps the shake intensity rather than letting a huge radius shake the frame into nausea', () => {
    const scene = makeScene();
    scene._aoeBlastFx(0, 0, 5000, 0xffffff);
    const intensity = scene.cameras.main.shake.mock.calls[0][1];
    expect(intensity).toBeLessThanOrEqual(8 / 800);
  });

  it('is a safe no-op on the shake when the scene has no camera (headless test double)', () => {
    const scene = makeScene({ withCamera: false });
    expect(() => scene._aoeBlastFx(0, 0, 80, 0xffffff)).not.toThrow();
    expect(scene._burst).toHaveBeenCalledTimes(3);
  });
});
