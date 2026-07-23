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
  HUD_COLUMN_W,
} from './hudLayout.js';

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
