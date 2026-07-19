// #288 (rebuilt as edge geometry): the arena world mixin's side of edge walls. The pure geometry is
// covered in data/wallEdges.test.js; what's pinned HERE is that the scene's existing, entirely
// tile-shaped world queries — passability, swept movement collision, line-of-sight, weapon damage
// routing — all honour a wall that owns no tile.
//
// WorldMixin's query methods have no Phaser dependency (they read `this.terrain`/`this.wallEdges`
// and pure helpers), so they're exercised against a minimal fake ArenaScene `this`, the same way
// world.test.js does.
import { describe, it, expect } from 'vitest';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, WALL_EDGE_HP, WALL_THICKNESS_PX, gateEdges, setGateOpen } from '../../data/wallEdges.js';
import { edgeMidpoint } from '../../data/hexEdges.js';
import { hexToPixel, pixelToHex, axialKey, neighbors, HEX_SIZE } from '../../data/hexgrid.js';

const A = { q: 0, r: 0 };
const B = neighbors(A.q, A.r)[0];

// Open grass everywhere, with one wall span on the A|B boundary — so anything that blocks in these
// tests is unambiguously the WALL and not the terrain.
function makeScene(defs = [{ a: A, b: B }]) {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  const scene = Object.assign({}, WorldMixin, {
    terrain,
    wallEdges: makeWallEdgeSet(defs),
    time: { now: 0 },
    buildingHp: new Map(),
    coverHp: new Map(),
    _redrawWallEdges() {},
    _outpostCollapseFx() { scene.fxCount = (scene.fxCount ?? 0) + 1; },
  });
  return scene;
}

const centre = (h) => hexToPixel(h.q, h.r);

describe('#288 movement collision against a wall span', () => {
  it('the hexes either side of a wall are still fully passable — the wall consumes no tile', () => {
    const s = makeScene();
    for (const h of [A, B]) {
      const c = centre(h);
      expect(s._blocked(c.x, c.y)).toBe(false);
      expect(s.terrain.get(axialKey(h.q, h.r))).toBe('grass');
    }
  });

  it('the wall band itself is impassable', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    expect(s._blocked(m.x, m.y)).toBe(true);
  });

  // The headline: you cannot walk from one side to the other, at any speed. A frame's movement at
  // full chassis speed is many times the wall's 14px painted thickness, so this has to be a swept
  // segment test rather than a sampled one.
  it('you cannot cross the wall in one step, however fast the step is', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    const ux = (cb.x - ca.x) / HEX_SIZE, uy = (cb.y - ca.y) / HEX_SIZE;
    for (const speed of [20, 100, 1000, 20000]) {
      const m = edgeMidpoint(A, B);
      expect(s._blockedAlongSegment(m.x - ux * speed, m.y - uy * speed, m.x + ux * speed, m.y + uy * speed)).toBe(true);
    }
  });

  it('movement that never touches the wall is unaffected', () => {
    const s = makeScene();
    const ca = centre(A);
    const far = centre({ q: 0, r: 3 });
    expect(s._blockedAlongSegment(ca.x, ca.y, far.x, far.y)).toBe(false);
    expect(s._blocked(far.x, far.y)).toBe(false);
  });

  // Breach and drive through: the whole point of the feature.
  it('once the span is shot down, the same crossing goes straight through', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(true);
    const span = [...s.wallEdges.edges.values()][0];
    s._damageWallEdge(span, WALL_EDGE_HP);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    const m = edgeMidpoint(A, B);
    expect(s._blocked(m.x, m.y)).toBe(false);
  });

  it('a scene with no walls at all behaves exactly as before', () => {
    const s = makeScene([]);
    const ca = centre(A), cb = centre(B);
    expect(s._blocked(ca.x, ca.y)).toBe(false);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    expect(s._isWall(ca.x, ca.y)).toBe(false);
  });
});

describe('#288 line-of-sight against a wall span', () => {
  const rayArgs = (from, to) => {
    const p0 = centre(from), p1 = centre(to);
    return [p0.x, p0.y, Math.atan2(p1.y - p0.y, p1.x - p0.x), Math.hypot(p1.x - p0.x, p1.y - p0.y), p1.x, p1.y];
  };

  it('a wall breaks line of sight between the hexes it separates', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs(A, B);
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).not.toBe(Infinity);
    expect(s._wallDistance(x0, y0, ang, maxT)).not.toBe(Infinity);
    const m = edgeMidpoint(A, B);
    expect(s._isWall(m.x, m.y)).toBe(true);
    expect(s._isWallForRound(m.x, m.y, null, null)).toBe(true);
  });

  // `_wallDistanceLos` deliberately skips samples that land in the same hex as the previous one —
  // a point-sampled wall check could not survive that, so the wall half is an exact crossing test.
  it('blocks LOS even on a long ray whose sampling would skip past the span', () => {
    const s = makeScene();
    const far = { q: -4, r: 0 };
    const beyond = { q: 4, r: 0 };
    const p0 = centre(far), p1 = centre(beyond);
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x), maxT = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d = s._wallDistanceLos(p0.x, p0.y, ang, maxT, p1.x, p1.y);
    expect(d).not.toBe(Infinity);
    // …and it's blocked AT the wall, not at some arbitrary point along the lane.
    const m = edgeMidpoint(A, B);
    expect(d).toBeCloseTo(Math.hypot(m.x - p0.x, m.y - p0.y), 0);
  });

  it('sight is clear again once the span falls', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs(A, B);
    s._damageWallEdge([...s.wallEdges.edges.values()][0], WALL_EDGE_HP);
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).toBe(Infinity);
    expect(s._wallDistance(x0, y0, ang, maxT)).toBe(Infinity);
  });

  it('sight past open ground is unaffected by a wall elsewhere', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs({ q: 0, r: -3 }, { q: 0, r: 3 });
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).toBe(Infinity);
  });
});

describe('#288 weapon damage routing', () => {
  it('a hit landing on the wall damages the SPAN, not the terrain hex under it', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    const span = [...s.wallEdges.edges.values()][0];
    expect(s._damageBuildingAt(m.x, m.y, 10)).toBe(false);
    expect(span.hp).toBe(WALL_EDGE_HP - 10);
    expect(s.terrain.get(axialKey(A.q, A.r))).toBe('grass');   // the ground is untouched
    expect(s.terrain.get(axialKey(B.q, B.r))).toBe('grass');
  });

  it('the killing blow destroys the span and plays the collapse', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    const span = [...s.wallEdges.edges.values()][0];
    expect(s._damageBuildingAt(m.x, m.y, WALL_EDGE_HP)).toBe(true);
    expect(span.destroyed).toBe(true);
    expect(s.fxCount).toBe(1);
    expect(s._liveWallEdges()).toHaveLength(0);
  });

  it('a hit well clear of the wall never touches it', () => {
    const s = makeScene();
    const far = centre({ q: 0, r: 3 });
    s._damageBuildingAt(far.x, far.y, 999);
    expect([...s.wallEdges.edges.values()][0].hp).toBe(WALL_EDGE_HP);
  });

  // A round's step is a swept segment, so a fast round detonates ON the wall's face rather than
  // sailing through it (scenes/arena/projectiles.js reads this).
  it('_wallEdgeHit reports where a fast round meets the wall', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    const ux = (cb.x - ca.x) / HEX_SIZE, uy = (cb.y - ca.y) / HEX_SIZE;
    const m = edgeMidpoint(A, B);
    const hit = s._wallEdgeHit(m.x - ux * 900, m.y - uy * 900, m.x + ux * 900, m.y + uy * 900);
    expect(hit).toBeTruthy();
    expect(Math.hypot(hit.x - m.x, hit.y - m.y)).toBeLessThan(WALL_THICKNESS_PX);
  });
});

// #288 (placement re-specced to a full RING): the seal, in PIXEL space. The hex-graph proof lives
// in worldgen.test.js ("SEALS the base…"), which shows no hex-to-hex STEP can cross the ring. That
// is the right proof for the construction, but the mech doesn't move on the hex graph — it moves
// with free physics on top of it, so what matters in play is that no continuous pixel-space path
// gets out either, including one that threads a ring VERTEX where three hexes meet. That "slip
// through a corner/seam" case is exactly what the owner asked to be verified, and it's the failure
// mode two earlier wall constructions had, so it's pinned directly against the scene's own
// collision method rather than argued from the hex proof.
describe('#288 a RING seals in pixel space, not just on the hex graph', () => {
  // Every boundary edge of the radius-`radius` hex disc centred on the origin — built the same way
  // worldgen's `placeBaseWalls` builds a base's ring (wall every edge whose far side is outside the
  // footprint), so this is the real shape, not a hand-drawn approximation.
  function ringDefs(radius = 2) {
    const inside = new Set();
    for (let q = -radius; q <= radius; q++) {
      for (let r = -radius; r <= radius; r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius) inside.add(axialKey(q, r));
      }
    }
    const defs = [];
    for (const k of inside) {
      const [q, r] = k.split(',').map(Number);
      for (const n of neighbors(q, r)) {
        if (!inside.has(axialKey(n.q, n.r))) defs.push({ a: { q, r }, b: n });
      }
    }
    return defs;
  }

  it('no straight dash from the centre escapes the ring, at any bearing or speed', () => {
    const s = makeScene(ringDefs());
    const c = centre({ q: 0, r: 0 });
    // 720 bearings — a much finer sweep than the 6 hex directions — deliberately including the
    // bearings that aim straight at a ring VERTEX (where two spans meet and a naive construction
    // leaves a pinhole).
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      // Every probe distance must actually REACH the ring: a radius-2 compound's outer wall face
      // sits at most ~2.5 hex steps (~210px) from the centre, so 300px is the floor. (Probing
      // short of the wall was the first draft of this test, and it "failed" for the trivial reason
      // that the dash stopped inside the compound.)
      for (const dist of [300, 400, 5000]) {
        const x = c.x + Math.cos(a) * dist, y = c.y + Math.sin(a) * dist;
        expect(s._blockedAlongSegment(c.x, c.y, x, y)).toBe(true);
      }
    }
  });

  it('…and no dash from OUTSIDE gets in, either', () => {
    const s = makeScene(ringDefs());
    const c = centre({ q: 0, r: 0 });
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      const from = { x: c.x + Math.cos(a) * 300, y: c.y + Math.sin(a) * 300 };
      expect(s._blockedAlongSegment(from.x, from.y, c.x, c.y)).toBe(true);
    }
  });

  // The enemy-pathing consequence the re-spec calls out: a ground unit sealed inside the ring
  // cannot reach the player until a breach (or #309's gate) opens. That is expected — what must
  // NOT happen is the unit ending up in a broken state (escaping, tunnelling, or teleporting out
  // via the stuck-unit rescue) while it grinds against the inside of the wall.
  //
  // This drives the SAME collide-and-slide rule the enemy integrator uses (enemies.js: try the
  // full step, else drop one axis, else stop) frame after frame, with the unit steering flat-out
  // at the player standing outside.
  it('a ground unit trapped inside grinds to a halt against the wall and never escapes', () => {
    const s = makeScene(ringDefs());
    const c = centre({ q: 0, r: 0 });
    const inside = (x, y) => Math.max(
      Math.abs(pixelToHex(x, y).q), Math.abs(pixelToHex(x, y).r),
      Math.abs(pixelToHex(x, y).q + pixelToHex(x, y).r),
    ) <= 2;
    // Start at the compound's centre, charge at a "player" far outside in each hex direction.
    for (const n of neighbors(0, 0)) {
      const target = centre({ q: n.q * 8, r: n.r * 8 });
      let x = c.x, y = c.y;
      for (let frame = 0; frame < 400; frame++) {
        const d = Math.hypot(target.x - x, target.y - y) || 1;
        const vx = ((target.x - x) / d) * 6, vy = ((target.y - y) / d) * 6;   // ~360px/s at 60fps
        let nx = x + vx, ny = y + vy;
        if (s._blocked(nx, ny)) {
          if (!s._blocked(x + vx, y)) ny = y;
          else if (!s._blocked(x, y + vy)) nx = x;
          else { nx = x; ny = y; }
        }
        x = nx; y = ny;
        // Never inside the wall band (which is what would trigger the stuck-unit teleport that
        // could pop it outside), and never out of the compound.
        expect(s._blocked(x, y)).toBe(false);
        expect(inside(x, y)).toBe(true);
      }
    }
  });

  // ── #309: THE SAME SEAL, WITH GATES PRESENT AND STANDING WIDE OPEN ────────────────────
  // This is the single most important property of the gate mechanic. #309's spec is that the gate
  // is a SALLY PORT: enemies come out, the player never gets in, and breaching a span stays his
  // only route inside. So every probe #288 ran against a blank ring is re-run here against a ring
  // whose gates are OPEN — if any of these leak, the whole design is defeated, because an
  // unbreached base would no longer be something he has to break into.
  //
  // The seal survives by CONSTRUCTION rather than by tuning: `_blockedAlongSegment` (the player's
  // movement query) never passes `passOpenGates`, so `blocksSpan` (data/wallEdges.js) reports an
  // open gate as solid to it exactly as it reports a shut one. There is no geometry involved and
  // therefore no angle, speed, or vertex that can defeat it.
  describe('#309 gates do not break the seal — an OPEN gate is still solid to the player', () => {
    // The radius-2 ring again, with two spans on opposite sides flagged as gates and cranked open
    // — the real live state the player meets when he wakes a base.
    function openGatedScene() {
      const defs = ringDefs();
      // Two spans as far apart as the def list allows: the first, and the one halfway round.
      defs[0].role = 'gate';
      defs[Math.floor(defs.length / 2)].role = 'gate';
      const s = makeScene(defs);
      const gates = gateEdges(s.wallEdges);
      expect(gates.length).toBe(2);
      for (const g of gates) expect(setGateOpen(s.wallEdges, g, true)).toBe(true);
      // Sanity: they really are open, or every assertion below would pass vacuously.
      for (const g of gates) expect(g.open).toBe(true);
      return { s, gates };
    }

    it('no straight dash from the centre escapes, at any bearing or speed, with both gates open', () => {
      const { s } = openGatedScene();
      const c = centre({ q: 0, r: 0 });
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * Math.PI * 2;
        for (const dist of [300, 400, 5000]) {
          const x = c.x + Math.cos(a) * dist, y = c.y + Math.sin(a) * dist;
          expect(s._blockedAlongSegment(c.x, c.y, x, y)).toBe(true);
        }
      }
    });

    it('…and no dash from OUTSIDE gets in through an open gate, either', () => {
      const { s } = openGatedScene();
      const c = centre({ q: 0, r: 0 });
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * Math.PI * 2;
        const from = { x: c.x + Math.cos(a) * 300, y: c.y + Math.sin(a) * 300 };
        expect(s._blockedAlongSegment(from.x, from.y, c.x, c.y)).toBe(true);
      }
    });

    // The most pointed version of the same check: aim the player STRAIGHT at the middle of an open
    // gate, from outside, dead on the normal. This is the exact approach a player would try the
    // moment he sees a gate stand open, so it is the one that must not work.
    it('driving dead-on into the mouth of an open gate stops the player', () => {
      const { s, gates } = openGatedScene();
      const c = centre({ q: 0, r: 0 });
      for (const g of gates) {
        const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
        const ux = (m.x - c.x) / (Math.hypot(m.x - c.x, m.y - c.y) || 1);
        const uy = (m.y - c.y) / (Math.hypot(m.x - c.x, m.y - c.y) || 1);
        // From well outside, straight through the gate's midpoint, to the compound's centre.
        expect(s._blockedAlongSegment(m.x + ux * 400, m.y + uy * 400, c.x, c.y)).toBe(true);
        // And the point query — the gate's own band is solid ground he cannot stand in.
        expect(s._blocked(m.x, m.y)).toBe(true);
      }
    });

    // The other half of the mechanic, and the one that makes the base able to fight back: the SAME
    // open gate is walkable for an enemy. The two queries differ at the gate and nowhere else.
    it('an enemy CAN cross the same open gate the player cannot', () => {
      const { s, gates } = openGatedScene();
      for (const g of gates) {
        const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
        expect(s._blocked(m.x, m.y)).toBe(true);          // player: solid
        expect(s._blockedForEnemy(m.x, m.y)).toBe(false); // enemy: through you go
      }
    });

    it('a CLOSED gate is solid to the enemy too — the sally port only works while it is open', () => {
      const { s, gates } = openGatedScene();
      for (const g of gates) {
        setGateOpen(s.wallEdges, g, false);
        const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
        expect(s._blockedForEnemy(m.x, m.y)).toBe(true);
      }
    });

    it('a plain span is solid to the enemy no matter what — only GATES ever open', () => {
      const { s } = openGatedScene();
      const plain = [...s.wallEdges.edges.values()].filter((e) => e.role !== 'gate');
      // Try to open one anyway: `setGateOpen` must refuse, because the role is the gate.
      expect(setGateOpen(s.wallEdges, plain[0], true)).toBe(false);
      const m = { x: (plain[0].x0 + plain[0].x1) / 2, y: (plain[0].y0 + plain[0].y1) / 2 };
      expect(s._blockedForEnemy(m.x, m.y)).toBe(true);
    });

    // The SORTIE itself, driven frame by frame through the real enemy collide-and-slide rule (the
    // mirror of #288's "trapped inside" test above, which asserted the opposite outcome on a
    // gateless ring). A garrison unit steering flat-out at a player outside must actually GET OUT
    // through the open gate — no waypoint, no pathfinding (#312 is not built), just the straight-
    // line steering it already has, which is precisely why the gate geometry has to be forgiving.
    it('a garrison unit steers out through an open gate and reaches the player outside', () => {
      const { s, gates } = openGatedScene();
      const c = centre({ q: 0, r: 0 });
      const outsideRing = (x, y) => {
        const h = pixelToHex(x, y);
        return Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)) > 2;
      };
      let escaped = 0;
      for (const g of gates) {
        // The player stands out beyond this gate, on its own outward normal — the natural case the
        // gate placement is chosen for (worldgen `assignGates` puts one gate on the approach).
        const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
        const d0 = Math.hypot(m.x - c.x, m.y - c.y) || 1;
        const target = { x: c.x + ((m.x - c.x) / d0) * 420, y: c.y + ((m.y - c.y) / d0) * 420 };
        let x = c.x, y = c.y;
        for (let frame = 0; frame < 400; frame++) {
          const d = Math.hypot(target.x - x, target.y - y) || 1;
          const vx = ((target.x - x) / d) * 4, vy = ((target.y - y) / d) * 4;
          let nx = x + vx, ny = y + vy;
          if (s._blockedForEnemy(nx, ny)) {
            if (!s._blockedForEnemy(x + vx, y)) ny = y;
            else if (!s._blockedForEnemy(x, y + vy)) nx = x;
            else { nx = x; ny = y; }
          }
          x = nx; y = ny;
          if (outsideRing(x, y)) { escaped++; break; }
        }
      }
      expect(escaped).toBe(gates.length);
    });

    // …and the counterpart that proves the gate is what did it: shut the gates, run the identical
    // drive, and the unit is trapped exactly as #288's test says it should be.
    it('…and with the gates shut, that same unit is trapped inside', () => {
      const { s, gates } = openGatedScene();
      for (const g of gates) setGateOpen(s.wallEdges, g, false);
      const c = centre({ q: 0, r: 0 });
      const g = gates[0];
      const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
      const d0 = Math.hypot(m.x - c.x, m.y - c.y) || 1;
      const target = { x: c.x + ((m.x - c.x) / d0) * 420, y: c.y + ((m.y - c.y) / d0) * 420 };
      let x = c.x, y = c.y;
      for (let frame = 0; frame < 400; frame++) {
        const d = Math.hypot(target.x - x, target.y - y) || 1;
        const vx = ((target.x - x) / d) * 4, vy = ((target.y - y) / d) * 4;
        let nx = x + vx, ny = y + vy;
        if (s._blockedForEnemy(nx, ny)) {
          if (!s._blockedForEnemy(x + vx, y)) ny = y;
          else if (!s._blockedForEnemy(x, y + vy)) nx = x;
          else { nx = x; ny = y; }
        }
        x = nx; y = ny;
        const h = pixelToHex(x, y);
        expect(Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r))).toBeLessThanOrEqual(2);
      }
    });

    // A gate is a span like any other: same HP pool, shootable down, and once down it is a
    // permanent ordinary breach — which is the answer to "what if he destroys a CLOSED gate".
    it('a gate span is destructible like any other, and a destroyed gate is a permanent breach', () => {
      const { s, gates } = openGatedScene();
      const g = gates[0];
      setGateOpen(s.wallEdges, g, false);
      expect(g.maxHp).toBe(WALL_EDGE_HP);          // no special toughness either way
      s._damageWallEdge(g, WALL_EDGE_HP);
      expect(g.destroyed).toBe(true);
      const m = { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
      expect(s._blocked(m.x, m.y)).toBe(false);    // the PLAYER can now walk through it
      // …and it can never be re-opened/re-closed as a gate again — it is just a hole now.
      expect(setGateOpen(s.wallEdges, g, true)).toBe(false);
    });
  });
});
