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
  HUD_COLUMN_W, integrityLayout, INTEGRITY_BARS, INTEGRITY_ORDER,
  consoleLayout, targetPodAnchor, targetPodLayout, bodyPools, hudTargetSnapshot,
  minimapEnemyDots,
} from './hudLayout.js';
import { LOCATIONS } from './anatomy.js';

const W = 1280;

describe('hudLayout — solo is exactly the pre-#366 HUD', () => {
  const l = hudLayout(1, W);

  it('has one panel', () => {
    expect(l.panels).toHaveLength(1);
    expect(l.count).toBe(1);
  });

  it('puts the integrity column at x=16, as it always was', () => {
    expect(l.panels[0].columnX).toBe(16);
  });

  it('spans the tile row across W*0.12 .. W*0.88, as it always was', () => {
    expect(l.panels[0].tilesX).toBe(W * 0.12);
    expect(l.panels[0].tilesW).toBe(W * 0.76);
  });

  it('keeps the objective line right-aligned and the buff rings on the right edge', () => {
    expect(l.shared.objectiveX).toBe(W - 16);
    expect(l.shared.objectiveOriginX).toBe(1);
    expect(l.shared.buffCx).toBe(W - 16 - 15);
  });

  it('keeps the 24px wayfinding margins', () => {
    expect(l.margins).toEqual({ left: 24, right: 24 });
  });

  it('labels the column plainly, with no player number', () => {
    expect(panelLabel(0, 1)).toBe('INTEGRITY');
  });

  it('is the same layout at any width — no co-op branch leaks into one player', () => {
    for (const w of [640, 900, 1920]) {
      expect(hudLayout(1, w).panels[0].columnX).toBe(16);
      expect(hudLayout(1, w).shared.objectiveOriginX).toBe(1);
    }
  });
});

describe('hudLayout — co-op mirrors a second panel', () => {
  const l = hudLayout(2, W);

  it('builds one panel per player', () => {
    expect(l.panels.map((p) => p.index)).toEqual([0, 1]);
  });

  it('keeps player 1 on the left and puts player 2 on the right', () => {
    expect(l.panels[0].side).toBe('left');
    expect(l.panels[0].columnX).toBe(16);
    expect(l.panels[1].side).toBe('right');
    expect(l.panels[1].columnX).toBe(W - 16 - HUD_COLUMN_W);
  });

  it('does not let the two integrity columns overlap', () => {
    const [a, b] = l.panels;
    expect(a.columnX + HUD_COLUMN_W).toBeLessThanOrEqual(b.columnX);
  });

  it('does not let the two tile rows overlap, and keeps both on screen', () => {
    const [a, b] = l.panels;
    expect(a.tilesX + a.tilesW).toBeLessThanOrEqual(b.tilesX);
    expect(b.tilesX + b.tilesW).toBeLessThanOrEqual(W);
    expect(a.tilesX).toBeGreaterThanOrEqual(0);
  });

  it('moves the shared objective/buff readouts off the right edge, clear of panel 2', () => {
    expect(l.shared.objectiveOriginX).toBe(0.5);
    expect(l.shared.objectiveX).toBe(W / 2);
    expect(l.shared.buffCx).toBeLessThan(l.panels[1].columnX);
  });

  it('widens the right wayfinding margin past the second column', () => {
    expect(l.margins.right).toBeGreaterThan(HUD_COLUMN_W);
  });

  it('names each column by player once there is somebody to tell apart', () => {
    expect(panelLabel(0, 2)).toBe('P1 INTEGRITY');
    expect(panelLabel(1, 2)).toBe('P2 INTEGRITY');
  });

  it('still lays out sanely at a narrow window (#330/#342: no negative or off-screen boxes)', () => {
    for (const w of [700, 820, 1024]) {
      const n = hudLayout(2, w);
      expect(n.panels[1].columnX).toBeGreaterThan(n.panels[0].columnX);
      expect(n.panels[1].tilesX + n.panels[1].tilesW).toBeLessThanOrEqual(w);
      for (const p of n.panels) expect(p.tilesW).toBeGreaterThan(0);
    }
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

// ── #452 — the console shell and the target readout ──────────────────────────────────────────
//
// What is easy to get silently wrong here: the pod landing ON TOP of player 2's integrity block in
// co-op (the corner it would naturally want is taken), and the target's bars drifting out of the
// language the player's own block is drawn in.
describe('consoleLayout — the shell that frames the whole bottom band', () => {
  it('spans the screen and runs flush to the bottom edge', () => {
    const c = consoleLayout(1280, 800, 676);
    expect(c.x).toBeGreaterThan(0);
    expect(c.x + c.w).toBe(1280 - c.x);
    expect(c.y + c.h).toBe(800 - c.x);   // the same gap all the way round the three outer edges
  });

  it('wraps whatever the band\'s tallest readout is, never less', () => {
    const c = consoleLayout(1280, 800, 676);
    expect(c.y).toBeLessThan(676);
  });
});

describe('targetPodAnchor — where the target readout hangs', () => {
  it('takes the far bottom-RIGHT in solo, mirroring the integrity block', () => {
    expect(targetPodAnchor(0, 1, 1280)).toEqual({ anchorX: 1280 - 16, side: 'right' });
  });

  it('moves BOTH pods inboard in co-op, clear of player 2\'s right-hand integrity block', () => {
    const [a, b] = [targetPodAnchor(0, 2, 1280), targetPodAnchor(1, 2, 1280)];
    // Player 2's block hangs off the right edge (hudLayout co-op panel 1), so nothing else may.
    const p2 = hudLayout(2, 1280).panels[1];
    expect(a.anchorX).toBeLessThan(p2.columnX);
    expect(b.anchorX).toBeLessThan(p2.columnX);
    // ...and the two pods sit either side of the centre line, never overlapping each other.
    expect(a.side).toBe('right');
    expect(b.side).toBe('left');
    expect(a.anchorX).toBeLessThan(b.anchorX);
  });
});

describe('targetPodLayout — the target reads in the player\'s own bar language', () => {
  const pod = targetPodLayout({ anchorX: 1264, bottomY: 790, availW: 400, side: 'right' });

  it('hangs off its anchor edge and shares the tile row\'s baseline', () => {
    expect(pod.x + pod.w).toBeCloseTo(1264, 5);
    expect(pod.bars.bottom).toBe(790 - INTEGRITY_BARS.labelH);
    expect(pod.bars.barH).toBe(INTEGRITY_BARS.barH);   // same bar length as the player's own
  });

  it('keeps HP left of armor, with the shield rightmost — exactly the integrity block\'s order', () => {
    const seg = pod.bars.segments[0];
    expect(seg.hpX).toBeLessThan(seg.armorX);
    expect(pod.bars.shield.x).toBeGreaterThan(seg.armorX);
    expect(pod.bars.shield.x + pod.bars.shield.w).toBeCloseTo(pod.x + pod.w, 5);
  });

  it('puts the preview bay inboard of the bars, inside the pod', () => {
    expect(pod.showArt).toBe(true);
    expect(pod.art.x).toBe(pod.x);
    expect(pod.art.x + pod.art.w).toBeLessThanOrEqual(pod.bars.x);
  });

  it('gives up its art rather than squeezing it to nothing in a cramped co-op half', () => {
    const tight = targetPodLayout({ anchorX: 400, bottomY: 790, availW: 50, side: 'right' });
    expect(tight.showArt).toBe(false);
    expect(tight.w).toBeCloseTo(tight.bars.w, 5);
  });

  it('mirrors onto a left anchor without reordering the bars', () => {
    const left = targetPodLayout({ anchorX: 600, bottomY: 790, availW: 400, side: 'left' });
    expect(left.x).toBe(600);
    expect(left.bars.segments[0].hpX).toBeLessThan(left.bars.segments[0].armorX);
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
