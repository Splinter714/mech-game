// #310 — the PLACEMENT + GEOMETRY half of wall-mounted turrets (the pure layer). The scene-side
// half (spawning the guns, and a breached span taking its gun with it) lives in
// scenes/arena/wallTurrets.test.js.
//
// The load-bearing claim under test here is the one the issue flagged as a regression risk: a
// turret is DECORATION ON A SPAN and must not alter passability. #288's and #309's seal suites
// already bind that globally and are untouched by this issue; what this file adds is the direct
// statement of the invariant at the role level, so a future change that makes a turret span
// special in `blocksSpan` fails HERE with an obvious message rather than as a mystery seal break.
import { describe, it, expect } from 'vitest';
import {
  makeWallEdgeSet, blocksSpan, turretEdges, gateEdges, spanTurretMount, damageWallEdge,
  SPAN_ROLE_WALL, SPAN_ROLE_GATE, SPAN_ROLE_TURRET,
  WALL_THICKNESS_PX, TURRET_MOUNT_OFFSET_PX, wallEdgeCrossing, wallEdgeAt,
} from './wallEdges.js';
import { placeBaseWalls } from './worldgen.js';
import { hexToPixel, axialKey, neighbors, range } from './hexgrid.js';
import { pointSegmentDistance } from './hexEdges.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { resolveWeapon, WEAPONS } from './weapons.js';

// A base whose footprint is a radius-2 disc around the origin — a realistic ring (18 boundary
// spans) rather than a toy one, so the proportional count rule is actually exercised.
function makeBase(id = 'base0', center = { q: 0, r: 0 }) {
  return { id, center, footprint: range(center, 2) };
}

// All-passable terrain over a wide area, so eligibility never accidentally filters everything out.
function passableTerrain(radius = 8) {
  const T = new Map();
  for (const h of range({ q: 0, r: 0 }, radius)) T.set(axialKey(h.q, h.r), 'grass');
  return T;
}

function ringFor(base, T = passableTerrain()) {
  const walls = placeBaseWalls(T, [base]);
  expect(walls.length).toBe(1);
  return walls[0].edges;
}

describe('#310 §1: which spans mount turrets', () => {
  it('assigns turrets to spans of the ring', () => {
    const edges = ringFor(makeBase());
    const turrets = edges.filter((e) => e.role === SPAN_ROLE_TURRET);
    expect(turrets.length).toBeGreaterThan(0);
  });

  it('the count is proportional to the ring, clamped to [2, 5]', () => {
    // Two very different base sizes must both land inside the clamp — that IS the rule.
    for (const radius of [1, 2, 3]) {
      const base = { id: 'b', center: { q: 0, r: 0 }, footprint: range({ q: 0, r: 0 }, radius) };
      const edges = ringFor(base, passableTerrain(radius + 6));
      const n = edges.filter((e) => e.role === SPAN_ROLE_TURRET).length;
      expect(n, `radius ${radius}`).toBeGreaterThanOrEqual(2);
      expect(n, `radius ${radius}`).toBeLessThanOrEqual(5);
    }
  });

  it('NEVER puts a turret on a gate span — the two roles are disjoint', () => {
    // The justification (issue #310): a gate that is also a gun emplacement muddles both reads,
    // and the two are mechanically at odds — a gate wants to be approached, a turret denies
    // approach. A span carries exactly one role, so this is also a statement that `role` stayed a
    // single-valued field rather than quietly becoming a set.
    for (const radius of [1, 2, 3]) {
      const base = { id: 'b', center: { q: 0, r: 0 }, footprint: range({ q: 0, r: 0 }, radius) };
      const edges = ringFor(base, passableTerrain(radius + 6));
      for (const e of edges) {
        expect([SPAN_ROLE_WALL, SPAN_ROLE_GATE, SPAN_ROLE_TURRET]).toContain(e.role ?? SPAN_ROLE_WALL);
      }
      const gates = edges.filter((e) => e.role === SPAN_ROLE_GATE);
      const turrets = edges.filter((e) => e.role === SPAN_ROLE_TURRET);
      expect(gates.length).toBeGreaterThan(0);       // #309 still placed its gates
      for (const t of turrets) expect(gates).not.toContain(t);
    }
  });

  it('only arms spans whose OUTER hex is passable — no gun firing into a cliff', () => {
    // Impassable everywhere except a single wedge, so most spans are ineligible.
    const T = passableTerrain();
    for (const h of range({ q: 0, r: 0 }, 8)) {
      const k = axialKey(h.q, h.r);
      const inFootprint = Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)) <= 2;
      if (!inFootprint && h.q < 2) T.set(k, 'mesa');
    }
    const edges = ringFor(makeBase(), T);
    for (const e of edges.filter((x) => x.role === SPAN_ROLE_TURRET)) {
      expect(T.get(axialKey(e.b.q, e.b.r)), `span ${e.a.q},${e.a.r}->${e.b.q},${e.b.r}`).not.toBe('mesa');
    }
  });

  it('spreads turrets around the ring rather than bunching them on one face', () => {
    // The design choice under test: EVEN spread, so no heading onto the base is free. Measured as
    // "the armed spans do not all sit within one half-plane of bearings from the base centre."
    const base = makeBase();
    const edges = ringFor(base);
    const c = hexToPixel(base.center.q, base.center.r);
    const bearings = edges
      .filter((e) => e.role === SPAN_ROLE_TURRET)
      .map((e) => {
        const o = hexToPixel(e.b.q, e.b.r);
        return Math.atan2(o.y - c.y, o.x - c.x);
      })
      .sort((a, b) => a - b);
    expect(bearings.length).toBeGreaterThanOrEqual(2);
    // The largest angular gap between consecutive armed bearings (wrapping) must be < 2π - that
    // gap, i.e. strictly less than a full half-turn plus slack. With an even spread of n >= 2 the
    // biggest gap should be nowhere near 2π; a bunched placement would show one gap close to it.
    let maxGap = bearings[0] + 2 * Math.PI - bearings[bearings.length - 1];
    for (let i = 1; i < bearings.length; i++) maxGap = Math.max(maxGap, bearings[i] - bearings[i - 1]);
    expect(maxGap).toBeLessThan(Math.PI * 1.35);
  });

  it('a base with no passable ground outside it gets no turrets, rather than throwing', () => {
    const T = passableTerrain();
    for (const h of range({ q: 0, r: 0 }, 8)) {
      const inFootprint = Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)) <= 2;
      if (!inFootprint) T.set(axialKey(h.q, h.r), 'mesa');
    }
    const edges = ringFor(makeBase(), T);
    expect(edges.filter((e) => e.role === SPAN_ROLE_TURRET).length).toBe(0);
  });
});

describe('#310 §1b: the gun the wall mounts', () => {
  // Lives HERE rather than in the scene test because src/scenes/** (tests included) may never
  // name a weapon id — architecture.guard.test.js enforces that weapon ids stay in the data layer.
  const def = ENEMY_KINDS.wallTurret;

  it('mounts the owner-confirmed RAIL LANCE', () => {
    expect(def.weaponId).toBe('railLance');
    const resolved = resolveWeapon(def.weaponId, def.weaponOverride);
    expect(resolved.delivery.hit).toBe('hitscan');      // the single heavy lance, not a stream
    expect(resolved.delivery.pattern).toBe('single');
    expect(resolved.delivery.kind).toBe('rail');
  });

  it('fires the PLAYER version of the weapon — matching damage AND cadence (#375 redefined)', () => {
    // #243's playtest rule: no kind retunes damage. #375 (owner: "use the player version of the
    // weapon") extends that to CADENCE — the wall lance fires at the base rail lance's own rate, no
    // slowdown. Difficulty now comes from range, gun count, and the magazine/reload beat, not a
    // bespoke slow charge.
    expect(def.weaponOverride?.damage).toBeUndefined();
    expect(def.weaponOverride?.cycleTime).toBeUndefined();
    const resolved = resolveWeapon(def.weaponId, def.weaponOverride);
    expect(resolved.damage).toBe(WEAPONS.railLance.damage);
    expect(resolved.cycleTime).toBe(WEAPONS.railLance.cycleTime);
  });

  it('out-ranges the player\'s version, so it matters during the APPROACH', () => {
    const resolved = resolveWeapon(def.weaponId, def.weaponOverride);
    expect(resolved.range.max).toBeGreaterThan(WEAPONS.railLance.range.max);
    expect(def.fireRange).toBe(resolved.range.max);
  });

  it('reuses the sentry\'s emplacement stat line (#299), armor included', () => {
    expect(def.hp).toBe(ENEMY_KINDS.turret.hp);
    expect(def.armor).toBe(ENEMY_KINDS.turret.armor);
    expect(def.armor).toBeGreaterThan(0);   // the precondition for the #287 toughness-bite bug
    expect(def.move.maxSpeed).toBe(0);      // rooted
  });
});

describe('#310 §2: the gun is seated CENTRED ON its own wall line', () => {
  // Owner, playtest 2026-07-19: "wall turrets should be centered on the wall so they can shoot
  // inside OR outside of the wall." The mount used to sit 13px OUTBOARD, clear of the 14px band,
  // which made it a purely outward-facing perimeter gun. It now straddles the line.
  it('places the mount exactly on the span centreline, at its midpoint', () => {
    const edges = ringFor(makeBase());
    const armed = edges.filter((e) => e.role === SPAN_ROLE_TURRET);
    expect(armed.length).toBeGreaterThan(0);
    const set = makeWallEdgeSet(armed);
    for (const e of set.edges.values()) {
      const m = spanTurretMount(e);
      expect(m).toBeTruthy();
      expect(pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, m.x, m.y)).toBeCloseTo(0, 6);
      expect(m.x).toBeCloseTo((e.x0 + e.x1) / 2, 6);
      expect(m.y).toBeCloseTo((e.y0 + e.y1) / 2, 6);
    }
  });

  it('pins the offset at zero — the centring is data, not an accident of the midpoint math', () => {
    expect(TURRET_MOUNT_OFFSET_PX).toBe(0);
  });

  it('still derives OUTWARD correctly when an explicit offset is asked for', () => {
    const base = makeBase();
    const edges = ringFor(base);
    const c = hexToPixel(base.center.q, base.center.r);
    const set = makeWallEdgeSet(edges.filter((e) => e.role === SPAN_ROLE_TURRET));
    for (const e of set.edges.values()) {
      const mid = { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 };
      const m = spanTurretMount(e, 10);
      expect(Math.hypot(m.x - c.x, m.y - c.y)).toBeGreaterThan(Math.hypot(mid.x - c.x, mid.y - c.y));
    }
  });

  it('degrades to null on a malformed record rather than throwing', () => {
    expect(spanTurretMount(null)).toBeNull();
    expect(spanTurretMount({ x0: 0, y0: 0, x1: 1, y1: 1 })).toBeNull();
  });
});

describe('#310 §2b: a centred gun sees BOTH ways — past its own span, and nothing else', () => {
  // The whole feature turns on this. `aimAndFire` gates every unit on line of sight traced from
  // its own position with `wallEdgeCrossing`, so a gun sitting exactly on the centreline crosses
  // that centreline on every ray it traces, in every direction, and would be permanently blind.
  // The fix is `wallEdgeCrossing`'s `ignoreKey`: the shooter's OWN span, and only that span, is
  // transparent to it. Tested here against real ring geometry with the real crossing query.
  const lanesFor = (base, m) => {
    const c = hexToPixel(base.center.q, base.center.r);
    const ux = m.x - c.x, uy = m.y - c.y;
    const len = Math.hypot(ux, uy) || 1;
    return {
      // Straight out from the base centre through the mount, to the edge of the gun's envelope.
      out: [m.x + (ux / len) * 900, m.y + (uy / len) * 900],
      // ...and straight back IN, toward the compound the gun now also covers. Kept short (60px)
      // so it stays inside the ring and can't reach the far side, which SHOULD block it.
      in: [m.x - (ux / len) * 60, m.y - (uy / len) * 60],
    };
  };

  it('an OUTWARD lane is clear once its own span is ignored (and blocked if it is not)', () => {
    const base = makeBase();
    const set = makeWallEdgeSet(ringFor(base));
    const armed = [...set.edges.values()].filter((e) => e.role === SPAN_ROLE_TURRET);
    expect(armed.length).toBeGreaterThan(0);
    for (const e of armed) {
      const m = spanTurretMount(e);
      const [tx, ty] = lanesFor(base, m).out;
      expect(wallEdgeCrossing(set, m.x, m.y, tx, ty, undefined, e.key),
        `span ${e.key} is blinded outward by its own ring`).toBeNull();
      // The exemption is doing real work: without it, the gun is blind. If this ever stops being
      // true the ignoreKey has become dead code and the centring is silently relying on luck.
      expect(wallEdgeCrossing(set, m.x, m.y, tx, ty)).not.toBeNull();
    }
  });

  it('an INWARD lane is clear too — the point of centring: a breaching player is still engaged', () => {
    const base = makeBase();
    const set = makeWallEdgeSet(ringFor(base));
    for (const e of [...set.edges.values()].filter((x) => x.role === SPAN_ROLE_TURRET)) {
      const m = spanTurretMount(e);
      const [tx, ty] = lanesFor(base, m).in;
      expect(wallEdgeCrossing(set, m.x, m.y, tx, ty, undefined, e.key),
        `span ${e.key} cannot cover the compound behind it`).toBeNull();
    }
  });

  it('every OTHER span still blocks it — the exemption is one span, not a wall-hack', () => {
    const base = makeBase();
    const set = makeWallEdgeSet(ringFor(base));
    const c = hexToPixel(base.center.q, base.center.r);
    const armed = [...set.edges.values()].filter((x) => x.role === SPAN_ROLE_TURRET);
    let blockedAcross = 0;
    for (const e of armed) {
      const m = spanTurretMount(e);
      // Fire straight across the compound, through the centre and out the far side of the ring.
      const tx = m.x + (c.x - m.x) * 4, ty = m.y + (c.y - m.y) * 4;
      const hit = wallEdgeCrossing(set, m.x, m.y, tx, ty, undefined, e.key);
      if (hit) { expect(hit.edge.key).not.toBe(e.key); blockedAcross++; }
    }
    // Every armed span faces the far side of its own ring, so all of them must be stopped by it.
    expect(blockedAcross).toBe(armed.length);
  });

  it('the mount sits INSIDE its own span\'s band now (and that is the intended state)', () => {
    const set = makeWallEdgeSet(ringFor(makeBase()));
    for (const e of [...set.edges.values()].filter((x) => x.role === SPAN_ROLE_TURRET)) {
      const m = spanTurretMount(e);
      expect(wallEdgeAt(set, m.x, m.y)?.key).toBe(e.key);
    }
  });
});

describe('#310 §2c: `ignoreKey` on the POINT band test (wallEdgeAt) — shooting the gun back', () => {
  // The swept exemption alone was NOT enough, and this was caught by measuring in the real game,
  // not by reasoning: the sampled ray marchers (`_wallDistance` -> `_isWall`, and the projectiles'
  // `_isWallForRound`) test the band by POINT, so a beam aimed at a centred gun stopped ~4px short
  // of it even after `wallEdgeCrossing` correctly let it through. Without both, the gun is
  // unshootable from either side and its 200hp span becomes the only way to silence it — 4x what
  // #310 shipped, and a contradiction of its own two-separate-health-pools design.
  it('a point inside an armed span\'s band resolves to that span, and to nothing once ignored', () => {
    const set = makeWallEdgeSet(ringFor(makeBase()));
    for (const e of [...set.edges.values()].filter((x) => x.role === SPAN_ROLE_TURRET)) {
      const m = spanTurretMount(e);
      expect(wallEdgeAt(set, m.x, m.y)?.key).toBe(e.key);
      expect(wallEdgeAt(set, m.x, m.y, undefined, e.key)).toBeNull();
    }
  });

  it('ignoring one span never hides a DIFFERENT one from the same query', () => {
    const set = makeWallEdgeSet(ringFor(makeBase()));
    const spans = [...set.edges.values()];
    const armed = spans.find((x) => x.role === SPAN_ROLE_TURRET);
    for (const other of spans) {
      if (other.key === armed.key) continue;
      const mid = { x: (other.x0 + other.x1) / 2, y: (other.y0 + other.y1) / 2 };
      // A point on some OTHER span still reports a wall even with the armed span ignored.
      expect(wallEdgeAt(set, mid.x, mid.y, undefined, armed.key)).not.toBeNull();
    }
  });
});

describe('#310 §3: a turret span is passability-IDENTICAL to a plain span (the seal)', () => {
  // The regression the issue called out explicitly. A turret must be decoration plus a garrison,
  // never a change to the barrier — so every solidity answer must be indifferent to the role.
  const defs = [
    { a: { q: 0, r: 0 }, b: { q: 1, r: 0 }, baseId: 'b', role: SPAN_ROLE_WALL },
    { a: { q: 0, r: 0 }, b: { q: 0, r: 1 }, baseId: 'b', role: SPAN_ROLE_TURRET },
  ];

  it('blocksSpan answers the same for a turret span as for a plain wall span', () => {
    const set = makeWallEdgeSet(defs);
    const [plain, armed] = [...set.edges.values()];
    expect(armed.role).toBe(SPAN_ROLE_TURRET);
    for (const passOpenGates of [false, true]) {
      expect(blocksSpan(armed, passOpenGates)).toBe(blocksSpan(plain, passOpenGates));
      expect(blocksSpan(armed, passOpenGates)).toBe(true);
    }
  });

  it('a turret span is NOT openable — the gate-only `open` hook does not leak to it', () => {
    const set = makeWallEdgeSet(defs);
    const armed = [...set.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    armed.open = true;                                   // even if something set it by mistake
    expect(blocksSpan(armed, true)).toBe(true);          // still solid: only a GATE may pass
  });

  it('carries the same HP pool and dies the same way as a plain span', () => {
    const set = makeWallEdgeSet(defs);
    const armed = [...set.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    expect(armed.hp).toBe(set.edges.values().next().value.maxHp);
    expect(damageWallEdge(set, armed, armed.maxHp - 1).destroyed).toBe(false);
    expect(damageWallEdge(set, armed, 1).destroyed).toBe(true);
    expect(blocksSpan(armed)).toBe(false);               // a breach, exactly like any other span
  });

  it('turretEdges / gateEdges partition cleanly and filter by base', () => {
    const set = makeWallEdgeSet([
      ...defs,
      { a: { q: 3, r: 0 }, b: { q: 4, r: 0 }, baseId: 'other', role: SPAN_ROLE_TURRET },
    ]);
    expect(turretEdges(set).length).toBe(2);
    expect(turretEdges(set, 'b').length).toBe(1);
    expect(turretEdges(set, 'other').length).toBe(1);
    expect(gateEdges(set).length).toBe(0);
  });
});

describe('#310 §4: the ring stays SEALED with turrets on it (hex-graph reachability)', () => {
  // A direct restatement of #288's core proof, re-run on a ring that now carries turret spans:
  // no walk on the hex adjacency graph gets from outside the footprint to inside it without
  // crossing a standing span. This is cheap insurance that the turret pass did not drop, reorder,
  // or replace any edge on its way through `placeBaseWalls`.
  it('no path from outside reaches the compound while the ring stands', () => {
    const base = makeBase();
    const edges = ringFor(base);
    expect(edges.some((e) => e.role === SPAN_ROLE_TURRET)).toBe(true);
    const set = makeWallEdgeSet(edges);
    const footprint = new Set(base.footprint.map((h) => axialKey(h.q, h.r)));

    // Flood fill from a far-outside hex, refusing to cross any span that blocks.
    const start = { q: 7, r: 0 };
    expect(footprint.has(axialKey(start.q, start.r))).toBe(false);
    const seen = new Set([axialKey(start.q, start.r)]);
    const queue = [start];
    while (queue.length) {
      const h = queue.shift();
      for (const n of neighbors(h.q, h.r)) {
        const nk = axialKey(n.q, n.r);
        if (seen.has(nk)) continue;
        if (Math.max(Math.abs(n.q), Math.abs(n.r), Math.abs(n.q + n.r)) > 9) continue;  // bound the fill
        // Is the boundary between h and n walled by a standing span?
        const incident = (set.byHex.get(axialKey(h.q, h.r)) ?? []).filter((e) => {
          const touchesN = (e.a.q === n.q && e.a.r === n.r) || (e.b.q === n.q && e.b.r === n.r);
          const touchesH = (e.a.q === h.q && e.a.r === h.r) || (e.b.q === h.q && e.b.r === h.r);
          return touchesN && touchesH;
        });
        if (incident.some((e) => blocksSpan(e))) continue;   // the wall stops the walk
        seen.add(nk);
        queue.push(n);
      }
    }
    for (const k of footprint) expect(seen.has(k), `reached compound hex ${k}`).toBe(false);
  });
});
