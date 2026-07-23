// #366 — the per-player HUD layout.
//
// Two things are pinned here, because both are what the issue says gets missed:
//  1. SOLO IS BYTE-IDENTICAL. Every number a single player's HUD is built from has to be the
//     literal constant HudScene hardcoded before this change. These assertions are deliberately
//     written as raw numbers, not as expressions re-derived from the module.
//  2. A downed player's panel says what it is waiting on rather than sitting at a stale zero.
import { describe, it, expect } from 'vitest';
import {
  hudLayout, panelLabel, panelStatusText, panelsNeedRebuild, hudPlayerSnapshot, lockPointOf,
  integrityLayout, INTEGRITY_BARS, INTEGRITY_ORDER,
  CONSOLE, CONSOLE_TILES, consoleLayout, consoleBand, consoleTileSize, tileRowWidth,
  HUD_DISC, minimapBox, targetDiscBox, targetDiscLayout, ringSweep, discReserveBottom,
  bodyPools, hudTargetSnapshot, minimapEnemyDots,
} from './hudLayout.js';
import { LOCATIONS } from './anatomy.js';

const W = 1280;

describe('hudLayout — one panel per player, and the shared top-corner chrome', () => {
  it('has one panel in solo', () => {
    const l = hudLayout(1, W);
    expect(l.panels).toHaveLength(1);
    expect(l.count).toBe(1);
  });

  it('keeps the objective line right-aligned and the buff rings on the right edge in solo', () => {
    const l = hudLayout(1, W);
    expect(l.shared.objectiveX).toBe(W - 16);
    expect(l.shared.objectiveOriginX).toBe(1);
    expect(l.shared.buffCx).toBe(W - 16 - 15);
  });

  it('keeps the 24px wayfinding margins on both edges — the console is centred, not against them', () => {
    for (const n of [1, 2]) expect(hudLayout(n, W).margins).toEqual({ left: 24, right: 24 });
  });

  it('labels the column plainly in solo, by player once there are two', () => {
    expect(panelLabel(0, 1)).toBe('INTEGRITY');
    expect(panelLabel(0, 2)).toBe('P1 INTEGRITY');
    expect(panelLabel(1, 2)).toBe('P2 INTEGRITY');
  });

  it('builds one panel per player in co-op and moves the shared readouts to top-centre', () => {
    const l = hudLayout(2, W);
    expect(l.panels.map((p) => p.index)).toEqual([0, 1]);
    expect(l.shared.objectiveOriginX).toBe(0.5);
    expect(l.shared.objectiveX).toBe(W / 2);
  });
});

// ── #452 (style pass) — the two corner DISCS ────────────────────────────────────────────────
//
// Jackson: "the locked enemy preview should be in a circle top left similar to the minimap on top
// right; both circles should be the same size, and should be slightly larger than current minimap
// size". Both halves of that are easy to break silently by tuning one disc's numbers alone.
describe('the corner discs — target top-left, minimap top-right', () => {
  it('makes both circles exactly the same size', () => {
    const map = minimapBox(W), tgt = targetDiscBox(0);
    expect(map.w).toBe(tgt.w);
    expect(map.h).toBe(tgt.h);
    expect(map.w).toBe(map.h);
  });

  it('is bigger than the 132px the minimap used to be', () => {
    expect(HUD_DISC.d).toBeGreaterThan(132);
  });

  it('pins the target disc to the top LEFT and the map to the top RIGHT, on the same line', () => {
    const map = minimapBox(W), tgt = targetDiscBox(0);
    expect(tgt.x).toBe(HUD_DISC.inset);
    expect(map.x + map.w).toBe(W - HUD_DISC.inset);
    expect(tgt.y).toBe(map.y);
    expect(tgt.x + tgt.w).toBeLessThan(map.x);   // they never meet, even side by side
  });

  it('stacks a second player\'s disc under the first rather than into the map\'s corner', () => {
    const [a, b] = [targetDiscBox(0), targetDiscBox(1)];
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
    expect(discReserveBottom(2)).toBeGreaterThan(discReserveBottom(1));
  });
});

describe('targetDiscLayout — the preview and its three gauge rings', () => {
  const disc = targetDiscLayout(targetDiscBox(0));

  it('centres on the disc and keeps every ring inside its frame', () => {
    expect(disc.cx).toBe(HUD_DISC.inset + HUD_DISC.d / 2);
    for (const ring of disc.rings) expect(ring.r + ring.w / 2).toBeLessThan(disc.r);
  });

  it('runs the same three layers, in the same order, the player\'s own block draws', () => {
    expect(disc.rings.map((r) => r.key)).toEqual(['hp', 'armor', 'shield']);
    // Outermost first, each one strictly inside the last.
    for (let i = 1; i < disc.rings.length; i++) {
      expect(disc.rings[i].r).toBeLessThan(disc.rings[i - 1].r);
    }
  });

  it('fits the art square inside the innermost ring, so a pose can never paint over the gauges', () => {
    expect(disc.art.w).toBeGreaterThan(0);
    expect(disc.art.w).toBeCloseTo(disc.art.h, 5);
    // The square's corner is exactly the inner radius away from the centre.
    expect(Math.hypot(disc.art.w / 2, disc.art.h / 2)).toBeCloseTo(disc.inner, 5);
  });

  it('hangs the unit-name line under the disc, centred', () => {
    expect(disc.nameX).toBe(disc.cx);
    expect(disc.nameY).toBeGreaterThan(disc.cy + disc.r);
  });
});

describe('ringSweep — a gauge arc winds clockwise from twelve o\'clock', () => {
  it('draws nothing at empty and a full turn at full', () => {
    expect(ringSweep(0).drawn).toBe(false);
    const full = ringSweep(1);
    expect(full.end - full.start).toBeCloseTo(Math.PI * 2, 5);
  });

  it('clamps anything out of range rather than winding past the ring', () => {
    expect(ringSweep(4).end).toBe(ringSweep(1).end);
    expect(ringSweep(-2).drawn).toBe(false);
    expect(ringSweep(undefined).drawn).toBe(false);
  });

  it('starts at the top of the dial', () => {
    expect(ringSweep(0.5).start).toBeCloseTo(-Math.PI / 2, 5);
  });
});

// ── #448 — the integrity readout's bar geometry ──────────────────────────────────────────────
//
// What matters and is easy to get silently wrong: the segments only name locations the model
// tracks, HP sits LEFT of armor inside each pair, the shield is the RIGHTMOST bar, and a cramped
// co-op half squeezes the widths instead of running the block into the skill tiles.
describe('integrityLayout — the bottom-corner bar block', () => {
  const solo = integrityLayout(INTEGRITY_ORDER, {
    anchorX: 16, side: 'left', bottomY: 790, availW: 400,
  });

  it('only ever names damage-tracked locations', () => {
    expect(INTEGRITY_ORDER.slice().sort()).toEqual(LOCATIONS.slice().sort());
  });

  it('puts HP on the LEFT and armor on the RIGHT inside every segment', () => {
    for (const seg of solo.segments) expect(seg.hpX).toBeLessThan(seg.armorX);
  });

  it('lines the shield up as the RIGHTMOST bar, past every segment', () => {
    const lastSeg = solo.segments[solo.segments.length - 1];
    expect(solo.shield.x).toBeGreaterThan(lastSeg.armorX);
    expect(solo.shield.x + solo.shield.w).toBeCloseTo(solo.x + solo.w, 5);
  });

  it('hangs off the given edge, sharing the tile row\'s baseline', () => {
    expect(solo.x).toBe(16);
    expect(solo.bottom).toBe(790 - INTEGRITY_BARS.labelH);
    expect(solo.top).toBe(solo.bottom - INTEGRITY_BARS.barH);
    expect(solo.scale).toBe(1);
  });

  it('mirrors a right-hand panel so the block ends at its anchor edge', () => {
    const right = integrityLayout(INTEGRITY_ORDER, {
      anchorX: 1264, side: 'right', bottomY: 790, availW: 400,
    });
    expect(right.x + right.w).toBeCloseTo(1264, 5);
    expect(right.segments[0].hpX).toBeLessThan(right.segments[0].armorX);
  });

  it('squeezes the WIDTHS (never the height) to fit a cramped co-op half', () => {
    const tight = integrityLayout(INTEGRITY_ORDER, {
      anchorX: 16, side: 'left', bottomY: 790, availW: 98,
    });
    expect(tight.w).toBeLessThanOrEqual(98);
    expect(tight.barW).toBeLessThan(solo.barW);
    expect(tight.barH).toBe(solo.barH);      // both players' bars stay the same length
    expect(tight.scale).toBeGreaterThanOrEqual(INTEGRITY_BARS.minScale);
  });

  it('never collapses the bars to nothing, however little room there is', () => {
    for (const availW of [0, 20, 60]) {
      const l = integrityLayout(INTEGRITY_ORDER, { anchorX: 16, side: 'left', bottomY: 790, availW });
      expect(l.barW).toBeGreaterThan(2);
      expect(l.segments).toHaveLength(INTEGRITY_ORDER.length);
    }
  });
});

// ── #452 (style pass) — the CENTRED console band ─────────────────────────────────────────────
//
// Jackson: the console "should be centered and only as wide as it needs to be" — not the
// full-screen-width shell it shipped as. The two failure modes are a band that is wider than its
// contents (the thing he objected to) and one that packs so tightly at co-op/narrow widths that
// the groups overlap or run off the screen.
const band1 = consoleBand(W, [{ blockW: 120, tilesW: 404 }]);

describe('consoleBand — the console is its contents, centred', () => {
  it('is exactly the contents plus one padding at each end', () => {
    expect(band1.w).toBe(120 + CONSOLE.blockGap + 404 + CONSOLE.padX * 2);
  });

  it('is narrower than the screen, and centred on it', () => {
    expect(band1.w).toBeLessThan(W);
    expect(band1.x + band1.w / 2).toBeCloseTo(W / 2, 0);
    expect(W - (band1.x + band1.w)).toBeCloseTo(band1.x, 0);
  });

  it('puts a player\'s integrity block first and their own tile row right beside it', () => {
    const [g] = band1.groups;
    expect(g.blockX).toBe(band1.x + CONSOLE.padX);
    expect(g.tilesX).toBe(g.blockX + 120 + CONSOLE.blockGap);
    expect(g.tilesX + g.tilesW).toBe(band1.x + band1.w - CONSOLE.padX);
  });

  it('lays two players\' groups side by side without overlapping or leaving the band', () => {
    const b = consoleBand(W, [{ blockW: 120, tilesW: 404 }, { blockW: 120, tilesW: 404 }]);
    const [a, c] = b.groups;
    expect(a.tilesX + a.tilesW).toBeLessThanOrEqual(c.blockX);
    expect(c.tilesX + c.tilesW).toBeLessThanOrEqual(b.x + b.w);
    expect(b.x).toBeGreaterThanOrEqual(0);
  });
});

describe('consoleTileSize — the tiles give before the band runs off the screen', () => {
  it('gives solo its full-size tiles at a normal window', () => {
    expect(consoleTileSize(W, [120])).toBe(CONSOLE_TILES.max);
  });

  it('squeezes rather than overflowing at a narrow window, and never below the floor', () => {
    for (const w of [520, 700, 900]) {
      const size = consoleTileSize(w, [120, 120]);
      expect(size).toBeGreaterThanOrEqual(CONSOLE_TILES.min);
      expect(size).toBeLessThanOrEqual(CONSOLE_TILES.max);
    }
  });

  it('keeps the band on screen wherever there is room to', () => {
    for (const w of [900, 1280, 1920]) {
      for (const n of [1, 2]) {
        const blockWs = Array(n).fill(120);
        const b = consoleBand(w, blockWs.map(() => ({ blockW: 120, tilesW: tileRowWidth(consoleTileSize(w, blockWs)) })));
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe('consoleLayout — the shell that frames the band', () => {
  it('is the band\'s own rectangle, not the screen\'s', () => {
    const c = consoleLayout(800, 676, band1);
    expect(c.x).toBe(band1.x);
    expect(c.w).toBe(band1.w);
    expect(c.w).toBeLessThan(W);
  });

  it('runs from above the band\'s tallest readout down to the bottom edge', () => {
    const c = consoleLayout(800, 676, band1);
    expect(c.y).toBeLessThan(676);
    expect(c.y + c.h).toBe(800 - CONSOLE.edgeGap);
  });
});

describe('bodyPools — one target\'s condition, whatever kind of body it has', () => {
  it('reads a flat single-pool body (a vehicle) off its own fields', () => {
    const p = bodyPools({ hp: 20, maxHp: 40, armor: 10, maxArmor: 40 });
    expect(p.hp).toBe(0.5);
    expect(p.armor).toBe(0.25);
    expect(p.hasArmor).toBe(true);
    expect(p.hasShield).toBe(false);
  });

  it('sums a part-shaped body (a mech) across its locations', () => {
    const p = bodyPools({ parts: { a: { hp: 10, maxHp: 20, armor: 0, maxArmor: 10 }, b: { hp: 20, maxHp: 20, armor: 5, maxArmor: 10 } } });
    expect(p.hp).toBe(0.75);
    expect(p.armor).toBe(0.25);
  });

  it('reports a shield only when the body actually has one', () => {
    const none = bodyPools({ hp: 1, maxHp: 1, hasShield: () => false, shield: { max: 0, hp: 0 } });
    expect(none.hasShield).toBe(false);
    expect(none.shield).toBe(0);
    const shielded = bodyPools({ hp: 1, maxHp: 1, hasShield: () => true, shield: { max: 50, hp: 25 } });
    expect(shielded.shield).toBe(0.5);
  });

  it('survives an armorless body without reporting a phantom empty armor bar', () => {
    expect(bodyPools({ hp: 5, maxHp: 10 }).hasArmor).toBe(false);
  });
});

describe('hudTargetSnapshot — the readout can only ever show what the reticle is on', () => {
  const vehicle = {
    kind: 'tank', texKey: 'kind_tank_armored', kindDef: { art: 'tank' },
    mech: { name: 'Tank', hp: 30, maxHp: 40, armor: 0, maxArmor: 20, isDestroyed: () => false },
  };

  it('is null with nothing targeted', () => {
    expect(hudTargetSnapshot({ id: 0 })).toBe(null);
    expect(hudTargetSnapshot(null)).toBe(null);
  });

  it('describes a live vehicle from the SAME pick the reticle uses', () => {
    const s = hudTargetSnapshot({ convergeTarget: vehicle });
    expect(s.kind).toBe('vehicle');
    expect(s.name).toBe('TANK');
    expect(s.texKey).toBe('kind_tank_armored');   // the CURRENT (plated) set, not the bare one
    expect(s.pools.hp).toBeCloseTo(0.75, 5);
    expect(s.mech).toBe(null);                    // only a mech needs its live handle, for posing
  });

  it('hands a mech target its live handle, since posing needs the real chassis', () => {
    const mech = {
      name: 'Raider', parts: { leftArm: { hp: 1, maxHp: 1, armor: 0, maxArmor: 0 } },
      isDestroyed: () => false, isPartDestroyed: (loc) => loc === 'leftArm',
    };
    const s = hudTargetSnapshot({ convergeTarget: { kind: 'mech', key: 'enemy3', mech } });
    expect(s.kind).toBe('mech');
    expect(s.mech).toBe(mech);
    expect(s.texKey).toBe('enemy3');
    expect(s.damageSig).toMatch(/1/);   // a lost location changes the signature, so the art rebuilds
  });

  it('goes null the instant the targeted unit dies — the pod goes idle, it does not freeze', () => {
    const dead = { ...vehicle, mech: { ...vehicle.mech, isDestroyed: () => true } };
    expect(hudTargetSnapshot({ convergeTarget: dead })).toBe(null);
  });

  it('names a destructible hex / wall span, which has no body to read', () => {
    expect(hudTargetSnapshot({ convergeTarget: { x: 1, y: 2, hexKey: '3,4' } }))
      .toEqual({ kind: 'structure', name: 'STRUCTURE', pools: null });
    expect(hudTargetSnapshot({ convergeTarget: { x: 1, y: 2, edgeKey: 'e1' } }).name)
      .toBe('WALL SECTION');
  });

  it('is what hudPlayerSnapshot publishes as `target`, alongside the chevron\'s point', () => {
    const s = hudPlayerSnapshot({ id: 0, color: 1, mech: null, convergeTarget: vehicle });
    expect(s.target.name).toBe('TANK');
    expect(hudPlayerSnapshot({ id: 0, color: 1, mech: null }).target).toBe(null);
  });
});

describe('panelsNeedRebuild — the mid-sortie join', () => {
  it('rebuilds when a second player joins mid-sortie', () => {
    expect(panelsNeedRebuild(1, 2)).toBe(true);
  });

  it('rebuilds nothing on a steady frame', () => {
    expect(panelsNeedRebuild(1, 1)).toBe(false);
    expect(panelsNeedRebuild(2, 2)).toBe(false);
  });

  it('treats an empty player list as one panel, not zero', () => {
    expect(panelsNeedRebuild(1, 0)).toBe(false);
  });
});

describe('panelStatusText — a downed player reads sensibly', () => {
  it('says nothing for a living player', () => {
    expect(panelStatusText({ dead: false, respawn: null })).toBe('');
  });

  it('counts the respawn clock down', () => {
    const s = panelStatusText({ dead: true, respawn: { remainingMs: 12340, waitingOnCombat: false } });
    expect(s).toBe('DOWN — RESPAWN 12.3s');
  });

  it('explains a clock that has run out but is held on the out-of-combat gate', () => {
    const s = panelStatusText({ dead: true, respawn: { remainingMs: 0, waitingOnCombat: true } });
    expect(s).toMatch(/ALL-CLEAR/);
    expect(s).not.toMatch(/0\.0s/);   // never a stale zero
  });

  it('reads DESTROYED with no respawn coming (solo death / run over)', () => {
    expect(panelStatusText({ dead: true, respawn: null })).toBe('DESTROYED');
    expect(panelStatusText({ dead: true, respawn: { remainingMs: null } })).toBe('DESTROYED');
  });
});

describe('hudPlayerSnapshot — what each player publishes to the HUD', () => {
  const player = {
    id: 1,
    color: 0xffb24a,
    mech: { tag: 'p2 mech' },
    dead: true,
    respawn: { remainingMs: 8000, waitingOnCombat: false },
  };

  it('carries that player\'s OWN mech, colour and respawn state', () => {
    const s = hudPlayerSnapshot(player);
    expect(s.id).toBe(1);
    expect(s.color).toBe(0xffb24a);
    expect(s.mech).toBe(player.mech);
    expect(s.dead).toBe(true);
    expect(s.respawn).toEqual({ remainingMs: 8000, waitingOnCombat: false });
  });

  it('copies the respawn state rather than handing out the live object', () => {
    const s = hudPlayerSnapshot(player);
    expect(s.respawn).not.toBe(player.respawn);
  });

  it('survives a half-built player (no respawn yet)', () => {
    const s = hudPlayerSnapshot({ id: 0, color: 1, mech: null });
    expect(s.respawn).toBe(null);
  });

  // #450: the dash cooldown readout was removed from the HUD, so the snapshot no longer
  // carries any dash state at all — the mechanic itself is untouched (data/dash.js).
  it('publishes no dash state', () => {
    expect(hudPlayerSnapshot({ ...player, dash: { active: true, cooldown: 2.5 } }).dash)
      .toBeUndefined();
  });
});

// #368 — the off-screen lock chevron is per player now, so each player's own target point rides
// its own HUD snapshot. `lockPointOf` is the pure half of that.
describe('lockPointOf — one player\'s own lock target', () => {
  it('is null with no target at all', () => {
    expect(lockPointOf({ id: 0 })).toBe(null);
    expect(lockPointOf(null)).toBe(null);
  });

  it('is a static target\'s point', () => {
    expect(lockPointOf({ convergeTarget: { x: 300, y: -120 } })).toEqual({ x: 300, y: -120 });
  });

  it('is a live enemy\'s CURRENT position, copied rather than aliased', () => {
    const enemy = { x: 10, y: 20, mech: { isDestroyed: () => false } };
    const pt = lockPointOf({ convergeTarget: enemy });
    expect(pt).toEqual({ x: 10, y: 20 });
    expect(pt).not.toBe(enemy);
    enemy.x = 999;
    expect(pt.x).toBe(10);   // the published snapshot is this frame's, not a live handle
  });

  it('goes null the moment the targeted enemy dies — the chevron hides itself', () => {
    const enemy = { x: 10, y: 20, mech: { isDestroyed: () => true } };
    expect(lockPointOf({ convergeTarget: enemy })).toBe(null);
  });

  it('is what hudPlayerSnapshot publishes as `lock`', () => {
    const s = hudPlayerSnapshot({ id: 1, color: 2, mech: null, convergeTarget: { x: 7, y: 8 } });
    expect(s.lock).toEqual({ x: 7, y: 8 });
    expect(hudPlayerSnapshot({ id: 0, color: 1, mech: null }).lock).toBe(null);
  });
});

// #462 — the minimap's enemy dots are gated on visibility. Before this they were published raw,
// so the corner map showed the garrison of a compound the player had never entered.
describe('minimapEnemyDots', () => {
  const alive = (x, y, extra = {}) => ({ x, y, mech: { isDestroyed: () => false }, ...extra });

  it('publishes only the enemies the visibility rule says are visible', () => {
    const seen = alive(10, 20), hidden = alive(300, 400);
    const dots = minimapEnemyDots([seen, hidden], (e) => e === seen);
    expect(dots).toEqual([{ x: 10, y: 20 }]);
  });

  it('still drops dead enemies, gate or no gate', () => {
    const dead = { x: 1, y: 2, mech: { isDestroyed: () => true } };
    expect(minimapEnemyDots([dead], () => true)).toEqual([]);
    expect(minimapEnemyDots([dead])).toEqual([]);
  });

  it('publishes every living enemy when no gate is supplied (scene doubles without the mixin)', () => {
    expect(minimapEnemyDots([alive(1, 2), alive(3, 4)]))
      .toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it('co-op: a gate that is true for ANY live player publishes the dot', () => {
    // The scene's `_enemyPerceivable` already unions over the live players, so this module asks once.
    const players = [{ x: 0, y: 0 }, { x: 900, y: 0 }];
    const nearP2 = alive(880, 0);
    const visibleToAny = (e) => players.some((p) => Math.hypot(e.x - p.x, e.y - p.y) < 100);
    expect(minimapEnemyDots([nearP2], visibleToAny)).toEqual([{ x: 880, y: 0 }]);
    // …and with player 2 gone, the same enemy drops off the map.
    players.pop();
    expect(minimapEnemyDots([nearP2], visibleToAny)).toEqual([]);
  });

  it('copies positions rather than aliasing the enemy record', () => {
    const e = alive(5, 6);
    const [dot] = minimapEnemyDots([e], () => true);
    e.x = 999;
    expect(dot).toEqual({ x: 5, y: 6 });
  });

  it('tolerates a missing/empty enemy list', () => {
    expect(minimapEnemyDots(null, () => true)).toEqual([]);
    expect(minimapEnemyDots([], () => true)).toEqual([]);
  });
});
