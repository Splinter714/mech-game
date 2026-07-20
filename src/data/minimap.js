// Pure world→minimap-window projection for the corner map (#383).
//
// The corner minimap used to letterbox the ENTIRE corridor into the box (a one-time whole-world
// fit). With #340's 24,000px corridor that made the world a tiny smear. Instead the map is now a
// WINDOW that follows the player: it shows 4× the AREA the camera currently frames — 2× on each
// linear axis — centred on the camera focus and scrolling as the player moves.
//
// This file is the pure geometry (no Phaser): given the camera's world-space view rect and the
// minimap box, it hands back a `toMini` projector and an `inBox` clip test. HudScene builds one
// per frame off the live `cameraView` channel, so the projection survives zoom/resolution changes
// for free (the view rect shrinks/grows with them and the window tracks it).

// Build the per-frame projector.
//
// `view`  — the camera's world-space view rect {x, y, width, height} (Phaser `worldView` shape),
//           republished each frame by ArenaScene as the `cameraView` registry channel.
// `box`   — the minimap panel rect {x, y, w, h} in HUD logical space.
//
// The window's world half-extents are the camera view's FULL width/height (half of 2× the view →
// 4× the area). A single UNIFORM min-fit scale keeps the map undistorted (circles stay circles):
// on the tighter axis the window covers exactly 2× the view, on the other it covers ≥2× (the
// surplus is letterbox margin inside the box). The window is centred on the camera focus — which
// IS the view-rect centre, i.e. the centroid the follow-camera already frames — so in co-op both
// leash-bound player chevrons stay on the window.
export function miniProjector(view, box) {
  const focusX = view.x + view.width / 2;
  const focusY = view.y + view.height / 2;
  const halfX = view.width;    // full window width  = 2 × view.width  ⇒ half-extent = view.width
  const halfY = view.height;   // full window height = 2 × view.height ⇒ half-extent = view.height
  const scale = Math.min(box.w / (2 * halfX), box.h / (2 * halfY));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const toMini = (wx, wy) => ({ x: cx + (wx - focusX) * scale, y: cy + (wy - focusY) * scale });
  const inBox = (m) => m.x >= box.x && m.x <= box.x + box.w && m.y >= box.y && m.y <= box.y + box.h;
  return { scale, focusX, focusY, halfX, halfY, cx, cy, toMini, inBox };
}

// Pin a marker to the minimap's edge, pointing toward a target that sits OUTSIDE the window.
// `target` is a point already in mini-space (the projector's `toMini` output, which may land
// beyond the box). Casts a ray from the box centre (cx, cy) toward it and clamps to the inset
// box border, returning {x, y, angle} — the border landing point plus the heading toward the
// target (atan2 convention). Used for the objective's on-map edge marker (#383): when the
// objective is off-window it rides the map edge instead of vanishing, preserving the navigational
// value the old whole-world view used to give.
export function clampToBox(box, cx, cy, target, inset = 0) {
  let dx = target.x - cx, dy = target.y - cy;
  if (dx === 0 && dy === 0) dx = 1;   // degenerate (target exactly at centre) — arbitrary direction
  const halfW = box.w / 2 - inset, halfH = box.h / 2 - inset;
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) };
}
