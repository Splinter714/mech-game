// #487 — the garage colour picker's pure layer: the curated swatch palette, the per-build colour
// resolver, and the co-op distinct-pick rules. The palette section reuses players.test.js's #404
// clash-audit verbatim, extended over the WHOLE swatch set — every swatch must be as un-confusable
// with the game's other coloured signals as the four auto-colours already are.
import { describe, it, expect } from 'vitest';
import {
  MECH_SWATCHES, MECH_SWATCH_NAMES, swatchName, isSwatch, defaultMechColor, mechColorFor,
  takenSwatches, canPickSwatch, cycleSwatch,
} from './mechColors.js';
import { PLAYER_COLORS } from './players.js';
import { Mech } from './Mech.js';

// ── #404's clash vocabulary + distance method, copied so a change here re-audits the whole set ──
const hsl = (c) => {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
};
const hueGap = (a, b) => { const d = Math.abs(hsl(a).h - hsl(b).h) % 360; return Math.min(d, 360 - d); };
const confusable = (a, b) => {
  if (hueGap(a, b) > 20) return false;
  const A = hsl(a), B = hsl(b);
  return Math.abs(A.l - B.l) < 0.18 && Math.abs(A.s - B.s) < 0.3;
};
const OTHERS = {
  ballisticMuzzle: 0xffb24a, energyMuzzle: 0x38d9ff, missileMuzzle: 0xff4fa3,
  supportMuzzle: 0x6dff9e, meleeMuzzle: 0xcfd6e0,
  reactor: 0xb15cff, halo: 0xfbfdff, enemyBody: 0xd3dae2,
  overdrive: 0xe2533a, overclock: 0x7bd17b, armorPatch: 0x9fa8b2,
  shield: 0x5ec8e0, infiniteFire: 0x28e0d8, barrage: 0xc06be0,
  wallTurretCyan: 0x5ac8e0, tankRust: 0xc65a34, helicopterGold: 0xe0b13a,
  carrierRed: 0xcf4d4d, carrierViolet: 0x8a4fc9, infantryOlive: 0x8fae4a,
  uiWarn: 0xefc14a, uiBad: 0xe2533a,
};

describe('MECH_SWATCHES palette is clash-proof (#487, #404 method over the full set)', () => {
  it('is a set of 8–12 distinct swatches', () => {
    expect(MECH_SWATCHES.length).toBeGreaterThanOrEqual(8);
    expect(MECH_SWATCHES.length).toBeLessThanOrEqual(12);
    expect(new Set(MECH_SWATCHES).size).toBe(MECH_SWATCHES.length);
  });

  it('opens with exactly the four PLAYER_COLORS, so every auto-default is a selectable swatch', () => {
    expect(MECH_SWATCHES.slice(0, PLAYER_COLORS.length)).toEqual(PLAYER_COLORS);
  });

  it('reuses no other on-screen signal colour exactly', () => {
    for (const c of MECH_SWATCHES) expect(Object.values(OTHERS)).not.toContain(c);
  });

  it('puts nothing in the 0–45° alert/ballistic danger hue band', () => {
    for (const c of MECH_SWATCHES) {
      const { h } = hsl(c);
      expect(h > 45 || h < 0).toBe(true);
    }
  });

  it('is not confusable with any muzzle, powerup, enemy accent or alert colour', () => {
    const clashes = [];
    for (const c of MECH_SWATCHES) {
      for (const [name, other] of Object.entries(OTHERS)) {
        if (confusable(c, other)) clashes.push(`0x${c.toString(16)} vs ${name}`);
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe('isSwatch', () => {
  it('is true only for a value actually in the palette', () => {
    for (const c of MECH_SWATCHES) expect(isSwatch(c)).toBe(true);
    expect(isSwatch(0x123456)).toBe(false);
    expect(isSwatch(null)).toBe(false);
    expect(isSwatch(undefined)).toBe(false);
    expect(isSwatch('0x427ffa')).toBe(false);   // a string is never a swatch
  });
});

describe('defaultMechColor', () => {
  it('is the PLAYER_COLORS auto-assignment, and every default is itself a swatch', () => {
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      expect(defaultMechColor(i)).toBe(PLAYER_COLORS[i]);
      expect(isSwatch(defaultMechColor(i))).toBe(true);
    }
  });

  it('wraps past the last player and tolerates a missing index', () => {
    expect(defaultMechColor(PLAYER_COLORS.length)).toBe(PLAYER_COLORS[0]);
    expect(defaultMechColor(undefined)).toBe(PLAYER_COLORS[0]);
  });
});

describe('mechColorFor — the one resolver both surfaces call', () => {
  it('returns the explicit pick when the build has a valid one', () => {
    const pick = MECH_SWATCHES[5];
    expect(mechColorFor({ color: pick }, 0)).toBe(pick);
  });

  it('falls back to the per-index default when there is no pick', () => {
    expect(mechColorFor({ color: null }, 1)).toBe(defaultMechColor(1));
    expect(mechColorFor({}, 2)).toBe(defaultMechColor(2));
    expect(mechColorFor(null, 3)).toBe(defaultMechColor(3));
  });

  it('ignores a stale pick no longer in the palette — trimming the palette never breaks a slot', () => {
    expect(mechColorFor({ color: 0x010203 }, 0)).toBe(defaultMechColor(0));
  });
});

describe('co-op distinctness — takenSwatches / canPickSwatch (#487)', () => {
  it('solo (one build) takes nothing — P1 picks freely from the whole palette', () => {
    const builds = [{ color: null }];
    expect(takenSwatches(builds, 0).size).toBe(0);
    for (const c of MECH_SWATCHES) expect(canPickSwatch(builds, 0, c)).toBe(true);
  });

  it('a swatch another joined player holds is taken (by explicit pick OR by their default)', () => {
    // P2 has picked MECH_SWATCHES[6]; P1 (editing) sees it taken. P2 also still holds P1... no —
    // P2's default is PLAYER_COLORS[1]; here P2 has an explicit pick so its default is freed.
    const p2Pick = MECH_SWATCHES[6];
    const builds = [{ color: null }, { color: p2Pick }];
    const taken = takenSwatches(builds, 0);
    expect(taken.has(p2Pick)).toBe(true);
    expect(canPickSwatch(builds, 0, p2Pick)).toBe(false);
    // A player who has NOT picked still holds their default colour, which is likewise disabled.
    const builds2 = [{ color: null }, { color: null }];
    expect(takenSwatches(builds2, 0).has(defaultMechColor(1))).toBe(true);
    expect(canPickSwatch(builds2, 0, defaultMechColor(1))).toBe(false);
  });

  it('the editing player can always re-select their OWN current colour', () => {
    const mine = MECH_SWATCHES[4];
    const builds = [{ color: mine }, { color: MECH_SWATCHES[6] }];
    expect(canPickSwatch(builds, 0, mine)).toBe(true);
    // and their own default, when they have not picked, is not blocked by themselves
    const builds2 = [{ color: null }, { color: MECH_SWATCHES[6] }];
    expect(canPickSwatch(builds2, 0, defaultMechColor(0))).toBe(true);
  });

  it('a pick FREES the previous colour for the other player', () => {
    // P1 holds JADE (index 3 swatch); P2 (editing) cannot take it.
    const jade = MECH_SWATCHES[3];
    let builds = [{ color: jade }, { color: null }];
    expect(canPickSwatch(builds, 1, jade)).toBe(false);
    // P1 re-picks STEEL — jade is now free, P2 may take it.
    const steel = MECH_SWATCHES[4];
    builds = [{ color: steel }, { color: null }];
    expect(canPickSwatch(builds, 1, jade)).toBe(true);
  });

  it('never lets a non-swatch value be picked', () => {
    expect(canPickSwatch([{ color: null }], 0, 0x010203)).toBe(false);
    expect(canPickSwatch([{ color: null }], 0, null)).toBe(false);
  });
});

describe('swatch names (#487 cycle picker)', () => {
  it('has one name per swatch, all non-empty and distinct', () => {
    expect(MECH_SWATCH_NAMES.length).toBe(MECH_SWATCHES.length);
    for (const n of MECH_SWATCH_NAMES) expect(n.length).toBeGreaterThan(0);
    expect(new Set(MECH_SWATCH_NAMES).size).toBe(MECH_SWATCH_NAMES.length);
  });

  it('swatchName maps each swatch to its aligned name and returns "" otherwise', () => {
    MECH_SWATCHES.forEach((hex, i) => expect(swatchName(hex)).toBe(MECH_SWATCH_NAMES[i]));
    expect(swatchName(0x010203)).toBe('');
    expect(swatchName(null)).toBe('');
  });
});

describe('cycleSwatch — button-advance picker that skips taken colours (#487 second pass)', () => {
  it('steps to the next / previous swatch in solo, wrapping the palette', () => {
    const builds = [{ color: MECH_SWATCHES[0] }];
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[0], +1)).toBe(MECH_SWATCHES[1]);
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[1], -1)).toBe(MECH_SWATCHES[0]);
    // forward past the end wraps to the front
    const last = MECH_SWATCHES.length - 1;
    expect(cycleSwatch([{ color: MECH_SWATCHES[last] }], 0, MECH_SWATCHES[last], +1)).toBe(MECH_SWATCHES[0]);
    // back from the front wraps to the end
    expect(cycleSwatch([{ color: MECH_SWATCHES[0] }], 0, MECH_SWATCHES[0], -1)).toBe(MECH_SWATCHES[last]);
  });

  it('SKIPS a colour another live player holds, landing on the next available one', () => {
    // P1 (editing, index 0) currently on swatch 0. P2 holds swatch 1, so a forward step must
    // jump straight to swatch 2.
    const builds = [{ color: MECH_SWATCHES[0] }, { color: MECH_SWATCHES[1] }];
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[0], +1)).toBe(MECH_SWATCHES[2]);
    // going back from swatch 2 skips the taken swatch 1 and lands on swatch 0
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[2], -1)).toBe(MECH_SWATCHES[0]);
  });

  it('skips a colour held only by another player\'s DEFAULT, not just an explicit pick', () => {
    // P2 has made no pick, so it holds its default (PLAYER_COLORS[1] === MECH_SWATCHES[1]).
    const builds = [{ color: MECH_SWATCHES[0] }, { color: null }];
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[0], +1)).toBe(MECH_SWATCHES[2]);
  });

  it('returns the current colour unchanged when every OTHER swatch is taken', () => {
    // Editing player (index 0) sits on swatch 0; phantom co-op players hold every other swatch,
    // so the only free colour is the editor's own — the cycle lands back on itself, no error.
    const others = MECH_SWATCHES.filter((c) => c !== MECH_SWATCHES[0]);
    const builds = [{ color: MECH_SWATCHES[0] }, ...others.map((c) => ({ color: c }))];
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[0], +1)).toBe(MECH_SWATCHES[0]);
    expect(cycleSwatch(builds, 0, MECH_SWATCHES[0], -1)).toBe(MECH_SWATCHES[0]);
  });

  it('the result is always a pickable swatch (or the unchanged current)', () => {
    const builds = [{ color: MECH_SWATCHES[3] }, { color: MECH_SWATCHES[5] }];
    for (const dir of [+1, -1]) {
      const next = cycleSwatch(builds, 0, MECH_SWATCHES[3], dir);
      expect(next === MECH_SWATCHES[3] || canPickSwatch(builds, 0, next)).toBe(true);
    }
  });
});

describe('persistence round-trip — the chosen colour survives save/load (#487)', () => {
  it('a Mech serialises and restores its colour like any other build field', () => {
    const pick = MECH_SWATCHES[7];
    const m = new Mech({ chassisId: 'mediumPlayer', color: pick });
    m.mount('rightArm', 'autocannon');
    expect(m.toJSON().color).toBe(pick);
    const restored = new Mech(m.toJSON());
    expect(restored.color).toBe(pick);
    expect(mechColorFor(restored, 0)).toBe(pick);
  });

  it('a build with no colour round-trips as null and resolves to the default', () => {
    const m = new Mech({ chassisId: 'mediumPlayer' });
    expect(m.color).toBe(null);
    expect(new Mech(m.toJSON()).color).toBe(null);
    expect(mechColorFor(m, 2)).toBe(defaultMechColor(2));
  });

  it('a non-numeric saved colour is normalised to null on load', () => {
    const m = new Mech({ chassisId: 'mediumPlayer', color: 'azure' });
    expect(m.color).toBe(null);
  });
});
