import Phaser from 'phaser';
import { drawProjectileBody, drawBeam, drawSlash, drawGroundFire, mountIconKey, MOUNT_FRONT_Y, DESIGN } from '../art/index.js';
import { planEmissions, makeProjectile, stepProjectile } from '../data/delivery.js';
import { CATEGORIES } from '../data/categories.js';
import { getItem, isWeapon } from '../data/items.js';
import { catalogMaxRange, previewRangeFrac } from '../data/weapons.js';
import { magazineReadout } from '../data/weaponStats.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY, hasHeldSfx, WEAPON_TRAJECTORY_SOUNDS_ENABLED, WEAPON_IMPACT_SOUNDS_ENABLED } from '../audio/sfxParams.js';
// #224 (temporary): both flags gate the Weapon Lab preview's trajectory/impact cues below —
// see sfxParams.js for the full list of gated call sites and how to revert.
import { scheduleFireCues } from '../audio/fireCues.js';
import { scrollToShow } from './padNav.js';
import { orderByLock } from './catalogOrder.js';
// #534: the ability half of the live preview. Weapon cards live-fire through the shared delivery
// sim; ability cards replay their own real effect (shared FX specs, the real intercept selector,
// the real smoke art, the real drone AI) through this — see its header for what's real per
// ability and what's a declared stand-in.
import { AbilityCardPreview } from './abilityPreview.js';

// Shared weapon/ability card list — the SINGLE implementation behind both the standalone
// Weapon Lab tab and the garage catalog, so the two can't drift. It renders a scrollable
// GRID of cards inside a bounded region (#610 — as many fixed-width cards across as fit, see
// _layout; it was a strictly single column before); each weapon card auto-fires a live shot/beam
// preview using the same delivery sim + art primitives the arena uses, and (#534) each ability
// card loops its real effect on the same principle — shared blast specs, the real intercept
// selector, the real smoke art, the real drone AI (ui/abilityPreview.js). Optional `onSelect(id)`
// makes a card clickable (the garage arms the picked item); `selectedId` highlights one.
//
// Usage:
//   const list = new WeaponCardList(scene, { x, y, w, h, ids, onSelect, selectedId, compact });
//   // in scene.update(): list.update(time, delta);
//   list.setIds(newIds);        // refilter (e.g. eligible items for a slot)
//   list.setSections([{ id, label, ids }, …]);   // #607: ONE continuous list, labelled bands
//   list.setSelected(id);       // #607: or a Set/array of ids
//   list.setBinds({ id: 'RT' }); // #610: mounted-slot glyph on a card's preview stage
//   list.setRegion(x, y, w, h); // on resize
//   list.destroy();
//
// #611: a section can also be a CUSTOM kind — `{ id, label, kind: 'chassis', cards: [desc] }` —
// whose cards carry caller-supplied content instead of an item id (see `_buildCard` for the
// descriptor shape). That is how the Garage's CHASSIS and COLOR pickers became ordinary cards in
// this same grid, replacing the caller-owned block of rows that used to hang below the cards on
// the deleted `setExtraHeight`/`onScroll` seams. Everything else — the state painter, hover moving
// the cursor, grid navigation, the scroll/mask — is shared with the item cards by construction.
//
// #505 (second correction): `compact: true` (see COMPACT_* below) shrinks every card's
// height/label width/emitter size for use inside a narrow Garage column — GarageScene's one
// catalog per player, up to 4 on screen at once. The full-size default is unchanged and stays
// what ArtPreviewScene's standalone Weapon Lab tab uses.

// #611: ONE state palette for EVERY card, item or otherwise. Cyan means CURSOR and only cursor —
// the gold that used to mean "equipped" here is gone, because it meant the exact opposite on the
// chassis/color rows this list absorbed (they painted the cursor gold and the equipped pick cyan).
// PauseMenuScene._highlight() paints its own row cursor cyan, so cyan-as-cursor is the house rule.
//   idle             → panel      + 1px panelEdge
//   selected         → panelSel   + 2px panelEdge   (neutral: no colour claims "equipped")
//   focused / both   → panelSel   + 2px focus
// #615 REVISES the cursor colour only: `focus` below is still cyan, but it is now just the DEFAULT
// (what the standalone Weapon Lab, which has no player identity to draw from, keeps). The Garage
// overrides it per column with that player's own mech colour — solo included — so a cursor always
// says WHOSE it is. See `focusColor`/`setFocusColor`. Everything else about the table above is
// unchanged: selected is still a neutral thicker edge, and only the cursor is ever coloured.
// `panelSel` therefore has to carry "you have this" ON ITS OWN — a COLOR card has no bind glyph to
// fall back on — so it is meaningfully brighter than `panel` rather than the ~5% lift (0x1b2430)
// it was while gold did that job. One named constant, expected to be tuned in play.
const UI = {
  panel: 0x161b22, panelEdge: 0x2a333f, panelSel: 0x24303f, stage: 0x0b0e12,
  text: '#c8d2dd', dim: '#7c8794', focus: 0x5ec8e0,
};

// The mounted-slot bind glyph (#610) keeps its gold: it is a LABEL naming a slot, not one of the
// panel states above, and gold is still the garage's colour for that (the loadout tiles' own bind
// glyphs, the locked-card cost label). #611's "no gold" rule is about the panel fill/stroke only.
const BIND_GOLD = '#efc14a';

// #65's locked-card label colour, now the DEFAULT for the generalised "you can't pick this" label
// (see `unavailable` below) rather than a hard-coded one — the #614 taken-colour card overrides it
// with the holding player's own identity colour.
const LOCK_GOLD = '#f5c542';

const CARD_H = 96;
const CARD_GAP = 12;
const LABEL_W = 200;     // left block: name + stats
// The card's MINIMUM width — the one dial that decides how many cards go across.
//
// #610 made the list a responsive grid packed at a FIXED card width, leaving whatever didn't
// divide evenly as dead space at the right. #611's follow-up replaced that: the minimum width
// decides the COLUMN COUNT only, and the cards then STRETCH to consume the region exactly.
//   n     = max(1, floor((avail + colGap) / (CARD_MIN_W + colGap)))
//   cardW = (avail - (n - 1) * colGap) / n
// So the count steps at thresholds and there is never a leftover gutter. There is deliberately
// NO maximum (Jackson's explicit pick over capping the stretch, having been told a low column
// count means very wide cards): at a 2-across window a card really is ~500-570px, and that is
// the intended look rather than a bug to clamp.
//
// 380 is Jackson's number, chosen over ~465 (the fixed width this replaced) and ~340 (the
// pre-#611 width): it gives 3 across from ~1170px of room and 4 from ~1560px. A garage column's
// catalog rect is the column's inner width (colW - 2*12 since #615 added the frame's own clearance
// to the column padding, see garage/columnLayout.js), so on a 1440-wide window: solo → 1416px → 3
// across at ~464px each; two players → 696px → 1 across at 696px; three or four → narrower than the
// minimum, so 1 across clamped to the column, which is exactly the single-column full-bleed row the
// list drew before #610.
//
// Whatever width a card lands at, the LEFT text block stays pinned at LABEL_W and the live-fire
// PREVIEW STAGE absorbs every extra pixel (see _layout) — a wide card buys a longer shot/beam
// travel and a bigger chassis pose, never a 400px-wide name field.
const CARD_MIN_W = 380;
const CARD_COL_GAP = 12;

// #505 (second correction): a `compact` list keeps the exact same live-fire-preview card shape
// (mount emitter + real shot/beam sim + name/category/stats) at a much smaller footprint, so it
// fits inside a Garage COLUMN that can be as narrow as 1/4 of the screen at 4 players — the
// full-size numbers above stay the Weapon Lab's (ArtPreviewScene) untouched default. Text still
// word-wraps within labelW regardless of mode, so neither size ever overflows into the stage.
const COMPACT_CARD_H = 60;
const COMPACT_CARD_GAP = 6;
const COMPACT_LABEL_W = 108;
// Kept proportional to the full-size width through every re-tune (240 at 340, 328 at 465, and now
// 268 at 380 — 328 × 380/465 ≈ 268), even though nothing builds a `compact` list any more, so if
// the compact path is ever revived it isn't silently the only card shape still sized to an old
// grid. It is a MINIMUM now too: a compact list stretches its cards to fill exactly like the
// full-size one does.
const COMPACT_CARD_MIN_W = 268;
const COMPACT_CARD_COL_GAP = 6;

// #607: a SECTIONED list — the Garage's catalog is now ONE continuous scrolling list with a
// labelled band per section (ABILITIES, then WEAPONS) instead of the per-column tab system
// (#529/#532) that used to swap whole catalogs in and out. A section header is a plain label row
// in the same scroll space as the cards; `SECTION_GAP` is the breathing room after a section's
// last card. An UNLABELLED single section (what `setIds` builds — the Weapon Lab's usage) draws
// no header and takes no gap, so that path lays out byte-identically to before.
// #610: a section also always STARTS A FRESH GRID ROW — ABILITIES never shares a row with
// WEAPONS. A section whose card count isn't a multiple of the column count simply leaves the
// gap at the end of its last row, which is the accepted trade for that clean break.
const SECTION_HEADER_H = 20;
const COMPACT_SECTION_HEADER_H = 15;
const SECTION_GAP = 12;
const COMPACT_SECTION_GAP = 8;

// #197 (re-scoped): every catalog card auto-fires a live shot/beam demo on a loop and plays
// its real fire/trajectory/impact sound automatically — with no way to turn it off, that's
// noisy/distracting just browsing the catalog or tuning sounds in the adjacent panel. This
// gates only the automatic SOUND (Audio.fire/impact/trajectory/startHeld, all routed through
// _isAudible) behind a toggle, OFF by default — the visual demo itself (each card's shot/beam
// animation) keeps running regardless, muted or not. Same tiny try/catch localStorage pattern
// as sfxParams.js's loadSfxParams/saveSfxParams and weaponSfxPanel.js's
// loadAutoPreviewEnabled — a single flag doesn't warrant new persistence infrastructure.
const AUTO_FIRE_STORAGE_KEY = 'mech-game-catalog-autofire-v1';

export function loadAutoFireEnabled() {
  try {
    return localStorage.getItem(AUTO_FIRE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAutoFireEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_FIRE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // localStorage blocked/unavailable — the toggle still works this session.
  }
}
// The mount texture (see art/mounts/icons.js) is a DESIGN-px square (mechPrims CENTER=32)
// with the weapon anchored at (centre-x, frontY). MOUNT_BASE_OY is that base as a normalised
// origin so the emitter image pivots on the weapon's base. EMIT_SIZE is its on-card display
// size; EMIT_BACK nudges the base left of the muzzle so the barrel reaches over the shots.
const MOUNT_BASE_OY = (DESIGN / 2 + MOUNT_FRONT_Y) / DESIGN;   // weapon base within the texture
const EMIT_SIZE = 44;
const EMIT_BACK = 8;
const COMPACT_EMIT_SIZE = 26;
const COMPACT_EMIT_BACK = 4;

// #120: the card preview's travel distance used to just be `Math.min(card.stageW, ...)` —
// since almost every weapon's real range comfortably exceeds a card's pixel width, nearly
// every shot/beam maxed out the same stage width regardless of the weapon's actual range,
// so range differences (Scatter Gun's short spread vs. Autocannon's long reach) were
// invisible. CATALOG_MAX_RANGE (computed once against WEAPON_IDS, the player-facing set both
// scenes render as cards — see data/weapons.js) lets _rangeLen() scale each weapon's shot
// proportionally: the farthest-reaching weapon fills the card, everything else draws shorter.
const CATALOG_MAX_RANGE = catalogMaxRange();

export class WeaponCardList {
  // #65: `isLocked(id)`/`costOf(id)` are optional — when given, a locked card renders dimmed
  // with a "🔒 N SCRAP" overlay in place of its stats. `onSelect` still fires on click either
  // way; the caller (GarageScene) decides whether that's an attempted purchase or a mount.
  // Omitting them (the Weapon Lab's usage) shows every card fully unlocked, unchanged.
  // #505 (second correction): `compact` shrinks card height/gap/label width/emitter size for a
  // narrow Garage column (see COMPACT_* above) — everything else (the live delivery sim, the
  // scroll/mask/drag behaviour, onSelect/isLocked/costOf) is identical to the full-size list.
  // #607: `sections` ([{ id, label, ids }]) builds ONE continuous list with a labelled band per
  // section — what the Garage's tab-less catalog uses. `ids` (a single unlabelled section) is
  // unchanged and stays the Weapon Lab's usage. `onHover(id, index)` fires when the pointer
  // enters a card, so a caller can keep its own cursor model in step with the mouse (the Garage
  // binds off whatever row is FOCUSED, and hovering is how a mouse focuses).
  // #611 deleted the `onScroll`/`setExtraHeight` pair: they existed solely so the Garage could park
  // its CHASSIS/COLOR rows below the cards in this list's scroll space, and those are ordinary
  // cards now.
  // #612: `caster` — `{ mech, textureKey }` — is whose mech stands on every ABILITY card's preview
  // stage, in place of the accent-coloured chip that used to represent one. It's the caller's LIVE
  // handle (the Garage passes its column's own build, mutated in place), so `refreshCaster()` after
  // a mount/chassis/colour change is all the re-sync there is. Omitting it draws no caster and is
  // exactly what the Weapon Lab does — that list is weapons-only, so it has no ability cards at all.
  // #614: `unavailable(id, kind)` is the GENERAL form of the lock above — return null for a normal
  // card, or `{ text, color }` to give it the identical scrim + centred label treatment with a
  // caller-written reason. It applies to EVERY card kind (a colour held by another co-op player has
  // no SCRAP price and isn't an item at all), and the weapon-cost path is untouched: `isLocked`
  // still wins, and a list that passes neither behaves exactly as before.
  constructor(scene, {
    x, y, w, h, ids, sections = null, onSelect = null, onHover = null,
    selectedId = null, isLocked = null, costOf = null, unavailable = null,
    compact = false, caster = null, focusColor = UI.focus,
  } = {}) {
    this.scene = scene;
    this.caster = caster;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.selectedId = selectedId;
    this._selectedIds = null;
    this.isLocked = isLocked;
    this.costOf = costOf;
    this.unavailable = unavailable;
    // #615: the CURSOR ring's colour — cyan unless the caller owns a per-player identity to use
    // instead. The Garage passes a BRIGHTENED variant of that column's mech colour
    // (mechColors.js's legibleColor), never the raw swatch: a swatch is picked to read as paint on
    // a mech, and a dark one (CHARCOAL, NAVY) makes an invisible 2px ring on a near-black panel.
    this.focusColor = focusColor;
    this.compact = compact;
    this.cardH = compact ? COMPACT_CARD_H : CARD_H;
    this.cardGap = compact ? COMPACT_CARD_GAP : CARD_GAP;
    // #611 follow-up: the grid's MINIMUM card width (what decides the column count — the cards
    // themselves stretch to fill, see _layout) + the gap BETWEEN columns (cardGap stays vertical).
    this.cardMinW = compact ? COMPACT_CARD_MIN_W : CARD_MIN_W;
    this.colGap = compact ? COMPACT_CARD_COL_GAP : CARD_COL_GAP;
    this.labelW = compact ? COMPACT_LABEL_W : LABEL_W;
    this.emitSize = compact ? COMPACT_EMIT_SIZE : EMIT_SIZE;
    this.emitBack = compact ? COMPACT_EMIT_BACK : EMIT_BACK;
    this.headerH = compact ? COMPACT_SECTION_HEADER_H : SECTION_HEADER_H;
    this.sectionGap = compact ? COMPACT_SECTION_GAP : SECTION_GAP;
    this.region = { x, y, w, h };
    this._scrollY = 0;
    this._maxScroll = 0;
    this._focus = -1;      // pad focus cursor (#70); -1 = none (the Weapon Lab never sets one)
    this.cards = [];
    this._sections = [];
    // #610: the grid's rows, as arrays of card indices — what left/right (within a row) and
    // up/down (between rows) navigate. Rebuilt by _layout(), so a resize that changes the column
    // count re-rows everything without touching the cards themselves.
    this._rows = [];
    // #610 (added scope): item id → the bind glyph(s) of the slot(s) it's currently mounted in,
    // drawn at the top-right of each card's preview stage. Null/absent = nothing drawn.
    this._binds = null;
    // #197: gates the auto-fire demo's automatic SOUND only (the visual shot/beam animation
    // always runs) — OFF by default. Loaded from localStorage so a returning session
    // remembers the owner's last choice, but a fresh browser/session (no stored value yet)
    // always starts muted until switched on.
    this.autoFireEnabled = loadAutoFireEnabled();

    this.root = scene.add.container(x, y);
    this.scroller = scene.add.container(0, 0);
    this.root.add(this.scroller);

    // Clip the scrolling cards to the region so they never spill past it.
    this.maskG = scene.make.graphics();
    this._paintMask();
    this.scroller.setMask(this.maskG.createGeometryMask());

    this._onWheel = (p, _o, _dx, dy) => { if (this._inRegion(p)) this._setScroll(this._scrollY + dy); };
    this._onDown = (p) => { if (this._inRegion(p)) { this._dragY = p.y; this._dragFrom = this._scrollY; } };
    this._onMove = (p) => {
      if (!p.isDown || this._dragY == null) return;
      const dpr = scene.registry.get('dpr') || 1;
      this._setScroll(this._dragFrom - (p.y - this._dragY) / dpr);
    };
    this._onUp = () => { this._dragY = null; };
    scene.input.on('wheel', this._onWheel);
    scene.input.on('pointerdown', this._onDown);
    scene.input.on('pointermove', this._onMove);
    scene.input.on('pointerup', this._onUp);

    if (sections) this.setSections(sections);
    else this.setIds(ids ?? []);
  }

  _paintMask() {
    // The mask renders through the same camera (zoom = dpr) as the cards, so it's painted in
    // logical coords — the camera scales it to physical to match.
    const { x, y, w, h } = this.region;
    this.maskG.clear().fillStyle(0xffffff).fillRect(x, y, w, h);
  }

  _inRegion(p) {
    const dpr = this.scene.registry.get('dpr') || 1;
    const { x, y, w, h } = this.region;
    const lx = p.x / dpr, ly = p.y / dpr;
    return lx >= x && lx <= x + w && ly >= y && ly <= y + h;
  }

  setRegion(x, y, w, h) {
    this.region = { x, y, w, h };
    this.root.setPosition(x, y);
    this._paintMask();
    this._layout();
  }

  // #607: also accepts a COLLECTION of ids (array/Set). With the Garage's tab-less catalog there
  // is no single "selected slot" any more, so it highlights every item mounted anywhere in that
  // column's build at once. A bare id (the Weapon Lab's usage, and what drives `_isAudible`)
  // behaves exactly as before.
  setSelected(id) {
    if (id && typeof id === 'object') {
      this._selectedIds = new Set(id);
      this.selectedId = null;
    } else {
      this.selectedId = id;
      this._selectedIds = null;
    }
    for (const c of this.cards) this._paintSelection(c);
  }

  _isSelected(card) {
    return this._selectedIds ? this._selectedIds.has(card.id) : card.id === this.selectedId;
  }

  // #610 (added scope): declare which slot each mounted item lives in, as `{ [itemId]: 'RT' }` —
  // whatever glyph string the caller wants drawn (it owns the pad-vs-keyboard choice, since only
  // it knows which device that column's player is holding). An id that isn't in the map draws
  // nothing at all. Pass null/{} to clear. Companion to setSelected, which already carries the
  // "this item is mounted somewhere" half of the same fact.
  setBinds(binds) {
    this._binds = binds || null;
    for (const c of this.cards) this._paintBind(c);
  }

  _paintBind(card) {
    const glyph = this._binds?.[card.id] ?? '';
    card.bindText.setText(glyph).setVisible(!!glyph);
  }

  // ── Pad focus cursor (#70) — optional; only the garage drives it. ──────────────────────
  // setFocus(i) highlights card i (null/-1 clears) and, by default, auto-scrolls it into view;
  // moveFocusRow/moveFocusCol step it through the GRID (#610); focusedId() is what a slot bind
  // acts on. setIds() clears the focus, so a refilter needs a fresh setFocus.
  // #541: `{ scroll: false }` moves the focus cursor (and its highlight) WITHOUT touching
  // scroll — the garage uses this when re-seeding focus on the still-mounted item after a slot
  // switch that didn't change the underlying id list, so browsing position is never disturbed
  // just because the pad-nav cursor needs to agree with what's mounted.

  setFocus(i, { scroll = true } = {}) {
    this._focus = (i == null || i < 0 || !this.cards.length)
      ? -1 : Math.min(this.cards.length - 1, i);
    for (const c of this.cards) this._paintSelection(c);
    if (scroll && this._focus >= 0) {
      // #607: a card's content-space top comes from the section layout now (headers/section gaps
      // sit between cards), not `i * (cardH + cardGap)`.
      const top = this.cards[this._focus].top ?? 0;
      this._setScroll(scrollToShow(this._scrollY, top, this.cardH, this.region.h, this._maxScroll));
    }
  }

  // #610: up/down between GRID ROWS. The column is preserved where the target row has one and
  // clamped to that row's last card otherwise (a section's final row can be short). Returns false
  // when there is no row that way — i.e. the cursor is already at the top/bottom of the whole
  // catalog. (#611: it used to mean "step off into the caller's own trailing rows"; there is no
  // such block any more, so the Garage just ignores the answer and the cursor clamps.)
  moveFocusRow(dir) {
    if (!this.cards.length) return false;
    if (this._focus < 0) { Audio.ui('menuNav'); this.setFocus(0); return true; }
    const card = this.cards[this._focus];
    const row = this._rows[card.row + dir];
    if (!row) return false;
    Audio.ui('menuNav');   // #178: short quiet blip — pad/keyboard catalog browsing
    this.setFocus(row[Math.min(card.col, row.length - 1)]);
    return true;
  }

  // #610: left/right WITHIN the focused card's grid row — this replaces #607's section-snap
  // entirely. It STOPS at either edge of the row rather than wrapping onto the row above/below:
  // the grid is deliberately ragged (every section starts a fresh row, so a section's last row is
  // usually short), and wrapping there would silently carry the cursor across a section divider.
  // "Left/right moves within the row, up/down changes row" stays literally true this way — and in
  // a narrow one-card-wide co-op column left/right correctly does nothing at all.
  moveFocusCol(dir) {
    if (!this.cards.length) return false;
    if (this._focus < 0) { Audio.ui('menuNav'); this.setFocus(0); return true; }
    const card = this.cards[this._focus];
    const row = this._rows[card.row];
    const next = row?.[card.col + dir];
    if (next == null) return false;
    Audio.ui('menuNav');
    this.setFocus(next);
    return true;
  }

  focusedId() { return this.cards[this._focus]?.id ?? null; }

  // #611: WHAT the focused card is — 'item' for a weapon/ability, or whatever `kind` its custom
  // section declared ('chassis'/'color' in the Garage). The caller needs this to know whether a
  // slot-bind button applies at all, or whether A should confirm a chassis/colour pick instead.
  focusedKind() { return this.cards[this._focus]?.kind ?? null; }

  indexOfId(id) { return this.cards.findIndex((c) => c.id === id); }

  // (#610 removed `sectionIdOf`/`sectionFirstIndex` along with the section-jump control they
  // existed for — D-pad left/right navigates the grid row now, and nothing asks which section a
  // card is in any more. #611 removed `cardCount`/`focusIndex`/`clearFocus`/`scrollY`/
  // `cardsHeight`/`setExtraHeight`/`scrollToContent`/`lastRowFirstIndex` — the whole seam a caller
  // needed to run one cursor across this list AND its own trailing block, now that there is no
  // trailing block.)

  // #541: true when `ids` (pre lock-sort, the same shape setIds() takes) is identical — same
  // length, same order — to the canonical id list this list was last built from. Lets a caller
  // skip a setIds() rebuild (and the scroll-to-top/lost-focus it causes) when a refilter
  // produces the exact same eligible set it already has, e.g. switching between two ordinary
  // weapon slots that share the same eligibility.
  sameIds(ids) {
    return !!this._ids && this._ids.length === ids.length && this._ids.every((id, i) => id === ids[i]);
  }

  // Rebuild the card set (e.g. filtered to a slot's eligible items). Reuses nothing — cards
  // are cheap and this only fires on a slot change, not per frame. The given order is the
  // CANONICAL order; when lock info is available (#78) locked items sort to the bottom, so we
  // stash the canonical ids for refreshAvailability() to re-sort against on unlock.
  setIds(ids) {
    this.setSections([{ id: 'all', label: null, ids }]);
  }

  // #607: the sectioned form of setIds. `sections` is [{ id, label, ids }] in display order; a
  // null/absent `label` draws no header row (and takes no trailing section gap), so the single
  // unlabelled section `setIds` builds lays out exactly as the pre-#607 flat list did. Lock
  // sorting (#78) applies WITHIN each section, so a locked weapon never sorts out of its band.
  //
  // #611: a section may instead declare `{ kind, cards: [descriptor] }` — see `_buildCard` for the
  // descriptor shape — for content this module has no item table for (the Garage's CHASSIS and
  // COLOR pickers). Those sections skip `getItem`/lock-sorting entirely and keep the caller's own
  // order; everything downstream (grid layout, cursor, hover, the state painter) is shared.
  setSections(sections) {
    for (const c of this.cards) {
      c.preview?.destroy();   // #534: drops the ability preview's own sprites before the card goes
      c.container.destroy();
      if (c._heldOn) Audio.stopHeld(c.id);
    }
    for (const s of this._sections) s.headerText?.destroy();
    this.cards = [];
    this._sections = [];
    this._focus = -1;
    this._ids = [];   // canonical order, pre lock-sort — remembered for refreshAvailability()/sameIds()
    for (const sec of sections) {
      const kind = sec.kind ?? 'item';
      const ids = [...(sec.ids ?? [])];
      const descs = kind === 'item'
        ? orderByLock(ids, this.isLocked).map((id) => this._itemDescriptor(id))
        : (sec.cards ?? []).map((d) => ({ ...d, kind }));
      const meta = { id: sec.id, label: sec.label ?? null, first: this.cards.length, count: descs.length, headerText: null, top: 0 };
      if (meta.label) {
        meta.headerText = this.scene.add.text(0, 0, meta.label, {
          fontFamily: 'monospace', fontSize: this.compact ? '9px' : '12px', color: UI.dim,
        });
        this.scroller.add(meta.headerText);
      }
      for (const d of descs) this._buildCard(d);
      this._sections.push(meta);
      this._ids.push(...(kind === 'item' ? ids : descs.map((d) => d.id)));
    }
    this._scrollY = 0;
    this._layout();
  }

  // An item id, expressed in the same descriptor shape a custom (#611) card arrives in — so
  // `_buildCard` has exactly one input format and the two kinds can't drift apart visually.
  _itemDescriptor(id) {
    const item = getItem(id);
    const weapon = isWeapon(id) ? item : null;
    // #506: abilities are their own visually distinct kind, with their own accent color.
    const accent = weapon ? (CATEGORIES[weapon.category]?.color ?? 0xffffff) : 0x7bd17b;
    return {
      id, kind: 'item', item, weapon, accent,
      name: item.name,
      sub: weapon ? (CATEGORIES[weapon.category]?.label ?? weapon.category) : 'Ability',
      stats: this._statLines(item, weapon),
    };
  }

  // Build one card from a descriptor:
  //   { id, kind, name, sub, stats, accent, item?, weapon?, art? }
  // `accent` colours the left edge strip and the `sub` line. `art` (#611) is the caller's own
  // display objects for the preview stage — `{ objects: [...], place({x,y,w,h}) }`, where `place`
  // is re-run on every layout with the stage rect in CARD-LOCAL coordinates. That is how a CHASSIS
  // card poses a real mech and a COLOR card shows its big swatch, without this module knowing
  // anything about mech art or the swatch palette.
  _buildCard(desc) {
    const index = this.cards.length;   // #607: this card's flat index, for the onHover callback
    const { id, kind, item = null, weapon = null } = desc;
    const color = desc.accent ?? 0xffffff;
    const c = this.scene.add.container(0, 0);

    // #505 (second correction): row geometry/font sizes scale down in `compact` mode (a narrow
    // Garage column) — everything else about the card (live emitter + delivery-sim preview,
    // lock overlay, selection) is identical between the two sizes.
    const cardH = this.cardH;
    const nameY = this.compact ? 6 : 14, catY = this.compact ? 18 : 33, statsY = this.compact ? 29 : 50;
    const nameSize = this.compact ? '10px' : '14px', catSize = this.compact ? '8px' : '11px', statsSize = this.compact ? '8px' : '10px';
    const wrapW = Math.max(40, this.labelW - 24);

    const panel = this.scene.add.rectangle(0, 0, 100, cardH, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
    const stage = this.scene.add.rectangle(0, 0, 100, 100, UI.stage).setOrigin(0, 0);
    const swatch = this.scene.add.rectangle(14, 16, 4, cardH - (this.compact ? 12 : 32), color).setOrigin(0, 0);
    // The weapon's actual on-mech mount hardware IS the emitter the live preview fires from —
    // the same silhouette drawWeaponMount() paints on the body. The texture points up and is
    // anchored at its base (design centre-x, frontY); rotating +90° aims the barrel to the
    // right (the fire direction), base-pivoted so every weapon's hardware sits at the same
    // spot with its muzzle reaching toward the shots. Abilities have no mount, so no emitter.
    const emitter = weapon
      ? this.scene.add.image(0, 0, mountIconKey(id)).setOrigin(0.5, MOUNT_BASE_OY).setRotation(Math.PI / 2)
      : null;
    const name = this.scene.add.text(0, nameY, desc.name ?? '', {
      fontFamily: 'monospace', fontSize: nameSize, color: UI.text, wordWrap: { width: wrapW },
    });
    const cat = this.scene.add.text(0, catY, desc.sub ?? '', {
      fontFamily: 'monospace', fontSize: catSize, color: Phaser.Display.Color.IntegerToColor(color).rgba, wordWrap: { width: wrapW },
    });
    const stats = this.scene.add.text(0, statsY, desc.stats ?? '', {
      fontFamily: 'monospace', fontSize: statsSize, color: UI.dim, lineSpacing: this.compact ? 1 : 2, wordWrap: { width: wrapW },
    });
    const fxG = this.scene.add.graphics();
    // #534: an ability card's live preview. It owns a `layer` container that sits BELOW fxG,
    // matching the arena's own depth order — the Smoke Screen puffs are ground FX, the caster mech
    // (#612) stands over them, and the blasts/drones/rounds in fxG draw over both. Vector work goes
    // straight into fxG alongside the weapon cards', so a card is still one Graphics redraw a frame.
    const preview = kind === 'item' && !weapon
      ? new AbilityCardPreview(this.scene, id, item, color, this.cards.length, this.caster) : null;
    // #611: a custom card's own stage content (a posed chassis mech, a colour swatch), created by
    // the caller and reparented into this card so it scrolls, masks and layers with everything else.
    const art = desc.art ?? null;

    // #65: a lock overlay — a dim scrim over the whole card plus a centred "🔒 N SCRAP" label
    // — sits on TOP of everything when the item is locked, hiding the live preview without
    // tearing it down (still simulated underneath so unlocking it needs no rebuild of state).
    // #614: the SAME two objects are now the one "you can't pick this" state for any reason, not
    // just an unpaid SCRAP price — see `_paintLock`. One scrim, one language, everywhere.
    const lockScrim = this.scene.add.rectangle(0, 0, 100, cardH, 0x05070a, 0.72).setOrigin(0, 0).setVisible(false);
    const lockLabel = this.scene.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: this.compact ? '10px' : '13px', color: LOCK_GOLD, align: 'center',
    }).setOrigin(0.5).setVisible(false);

    // #610 (added scope): the bind glyph of whichever slot this item is currently mounted in — the
    // same gold as the "you have this" panel highlight it accompanies, because it is the second
    // half of that one fact (the highlight says WHETHER, this says WHICH SLOT). Empty and hidden
    // unless the caller's `setBinds` names this id, so an unmounted card shows nothing — it is
    // deliberately NOT a "which slots could take this" hint.
    const bindText = this.scene.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: this.compact ? '9px' : '11px', color: BIND_GOLD,
    }).setOrigin(1, 0).setVisible(false);

    // emitter sits under fxG so projectiles/beams render over the muzzle; the bind glyph sits over
    // the live preview so a passing shot can't hide it; the lock overlay sits above everything.
    c.add([panel, stage, swatch, ...(emitter ? [emitter] : []), ...(art?.objects ?? []), name, cat, stats,
      ...(preview ? [preview.layer] : []), fxG, bindText, lockScrim, lockLabel]);
    this.scroller.add(c);

    const card = {
      id, kind, item, weapon, color, art, container: c, panel, stage, emitter, name, cat, stats, fxG,
      lockScrim, lockLabel, preview, bindText,
      cd: this.cards.length * 120, streamPhase: 0, holdBeam: false,
      pending: [], projectiles: [], beams: [], dyingBeams: [], bursts: [], slashes: [], patches: [],
    };

    if (this.onSelect) {
      panel.setInteractive({ useHandCursor: true });
      // #607/#611: hovering a card is how the MOUSE moves the shared cursor — the Garage binds
      // whatever card is FOCUSED into whichever slot button gets pressed, so the pointer has to
      // drive that same focus rather than a separate hover-only highlight. That is also why there
      // is no hover paint of its own: the caller's `onHover` moves the cursor, and the cursor's
      // own repaint is the feedback. It applies to EVERY card, chassis and colour included (#611).
      panel.on('pointerover', () => {
        Audio.ui('menuNav');
        this.onHover?.(id, index);
        this._paintSelection(card);
      });
      panel.on('pointerout', () => this._paintSelection(card));
      panel.on('pointerdown', () => this.onSelect(id));
    }
    this.cards.push(card);
    this._paintSelection(card);
    this._paintLock(card);
    this._paintBind(card);
  }

  // #65: apply/refresh a single card's unavailable look without rebuilding it. Call after a
  // purchase (or any balance change) to redraw locks in place — cheaper than setIds().
  //
  // #614: TWO reasons can now put a card behind the scrim, and they share it deliberately so the
  // catalog speaks one "you can't pick this" language rather than inventing a second dim state:
  //   1. the #65 SCRAP lock — item cards only, gold "🔒 LOCKED / N SCRAP",
  //   2. the caller's general `unavailable(id, kind)` — any card kind, caller's own text/colour
  //      (the Garage names the co-op player holding a colour, in that player's colour).
  // The lock wins where both could apply, so the weapon-cost path is exactly what it always was.
  _paintLock(card) {
    // #611: only ITEM cards can be locked — a chassis or a colour has no SCRAP price, and asking
    // the caller's `isLocked` about one would be asking a weapon-shop question about a paint chip.
    const locked = card.kind === 'item' && (this.isLocked?.(card.id) ?? false);
    const blocked = locked ? null : (this.unavailable?.(card.id, card.kind) ?? null);
    const on = locked || !!blocked;
    card.lockScrim.setVisible(on);
    card.lockLabel.setVisible(on);
    if (locked) {
      const cost = this.costOf?.(card.id) ?? 0;
      card.lockLabel.setText(`🔒 LOCKED\n${cost} SCRAP`).setColor(LOCK_GOLD);
    } else if (blocked) {
      card.lockLabel.setText(blocked.text ?? '').setColor(blocked.color ?? LOCK_GOLD);
    }
  }

  // Re-evaluate every card's locked state in place (e.g. after a purchase changes the
  // unlocked set or the SCRAP balance) — no rebuild, no preview-sim reset, and (per the #78
  // follow-up) no re-sort: reordering the instant a purchase completes moved cards out from
  // under the player's cursor. The list keeps its current order until the next natural
  // rebuild (setIds(), e.g. a slot change or leaving/re-entering the garage), which already
  // applies orderByLock() against the live isLocked state — so a purchased item settles into
  // its canonical slot on the next real navigation, not mid-interaction.
  // #614: renamed from `refreshLocks` now that the scrim covers more than the SCRAP lock — the
  // Garage calls it both after a purchase and whenever another player's colour changes.
  refreshAvailability() {
    for (const c of this.cards) this._paintLock(c);
  }

  // #611: THE one state painter, for every card kind. See the UI palette above for the table it
  // implements. Selected and focused are two independent facts that can coincide, and only the
  // cursor is ever coloured — a selected-but-not-focused card says so with its brighter fill and a
  // thicker but still NEUTRAL edge.
  _paintSelection(card) {
    const on = this._isSelected(card);
    const focused = this._focus >= 0 && this.cards[this._focus] === card;
    card.panel.setFillStyle(on || focused ? UI.panelSel : UI.panel)
      .setStrokeStyle(on || focused ? 2 : 1, focused ? this.focusColor : UI.panelEdge);
  }

  // #615: recolour the cursor in place — the Garage calls this when its column's player picks a new
  // mech colour, so the ring follows the identity it stands for without rebuilding a single card.
  setFocusColor(color) {
    if (this.focusColor === color) return;
    this.focusColor = color;
    for (const c of this.cards) this._paintSelection(c);
  }

  _statLines(item, weapon) {
    if (!weapon) {
      const cd = item.cooldown != null ? `${item.cooldown}s cooldown` : '';
      // #500: an until-broken ability has no `duration` to quote — what it costs you is the
      // thing that ends it, so the card says that instead.
      const extra = item.breaksOnFire ? 'until you fire'
        : item.duration ? `${item.duration}s active`
        : item.speedMult ? 'mobility burst' : '';
      return ['ability', [cd, extra].filter(Boolean).join(' · ')].join('\n');
    }
    const d = weapon.delivery;
    const parts = [];
    if (d.hit === 'hitscan') parts.push('hitscan');
    else if (d.hit === 'contact') parts.push('melee');
    else parts.push(`proj ${d.velocity}px/s${d.path === 'arcing' ? ' · arc' : ''}`);
    if (d.pattern === 'spread') parts.push(`spread×${d.count ?? 1}`);
    else if (d.pattern === 'stream') parts.push(`stream ${d.fireRate}/s${(d.count ?? 1) > 1 ? ` ×${d.count}` : ''}`);
    if (d.burst) parts.push(`burst×${d.count ?? 1}`);
    if (d.guidance === 'homing') parts.push('homing');
    // #402: mag size only (no trickle). #451: counted in PROJECTILES, the same unit the arena HUD
    // now shows — a 4-round rack of 5-missile salvoes reads 20 in both places or the two disagree.
    const mag = magazineReadout(weapon, weapon.ammoMax);
    const ammo = mag == null ? '∞' : `${mag.max}`;
    const cadence = d.pattern === 'stream' ? `${d.fireRate}/s` : `${(weapon.cycleTime / 1000).toFixed(2)}s`;
    return [parts.join(' · '), `dmg ${weapon.damage} · rng ${weapon.range.max} · ${cadence} · ammo ${ammo}`].join('\n');
  }

  // Flow cards into a responsive GRID within the region; compute max scroll. Margins shrink in
  // `compact` mode alongside cardH/labelW/emitSize (see the constructor) — the shape (label
  // block, live-fire stage, emitter at the muzzle) is unchanged, only the numbers are smaller.
  //
  // #611 follow-up: the column COUNT is driven by CARD_MIN_W (how many minimum-width cards fit
  // across the region, min 1) and the cards then STRETCH to consume that region exactly — no
  // fixed width, no leftover gutter at the right. #610's fixed-width packing left a dead strip at
  // every width between two thresholds, which is the whole reason this changed. The grid stays
  // left-aligned/full-bleed so it lines up with the section headers and with whatever the caller
  // parks below it. A region narrower than one minimum card is 1 column clamped to the region —
  // the same full-bleed single row this drew before #610, and it falls straight out of the
  // formula rather than needing its own case.
  //
  // cardW is floored so panel edges, the stage rect and the bind glyph all land on whole pixels;
  // that leaves at most (cols - 1) px unconsumed at the far right, which is invisible.
  _layout() {
    const cardH = this.cardH;
    const colGap = this.colGap;
    const avail = Math.max(0, this.region.w);
    const cols = Math.max(1, Math.floor((avail + colGap) / (this.cardMinW + colGap)));
    const cardW = Math.max(20, Math.floor((avail - (cols - 1) * colGap) / cols));
    const nameX = this.compact ? 6 : 20;
    const stageGap = this.compact ? 4 : 8;
    const stageMargin = this.compact ? 6 : 12;
    const muzzleInset = this.compact ? 8 : 14;
    const stageX = this.labelW + stageGap;
    // The text column is a FIXED labelW at every card width, so the preview stage is what absorbs
    // the stretch: a 700px 1-across card buys ~480px of shot travel / a bigger chassis pose, not a
    // 500px-wide name field (the name/category/stats all word-wrap at labelW - 24, set once at
    // build time). Clamped once here rather than at each use in _layoutCard, so every consumer of
    // the stage rect — panel, ability preview, custom `art.place`, bind glyph — agrees on the same
    // number when a 4-player column is narrower than the label block itself.
    const stageW = Math.max(20, cardW - stageX - stageMargin);
    // #607: cards flow section by section (header row, then that section's cards, then a gap)
    // rather than as one uniform stride, and each card remembers its own content-space `top` so
    // focus-scrolling can address it directly. #610: within a section they now also wrap across
    // `cols` columns, and every section restarts at column 0 on a fresh row.
    this._rows = [];
    let y = 0;
    for (const sec of this._sections) {
      sec.top = y;
      if (sec.headerText) {
        sec.headerText.setPosition(nameX, y + (this.compact ? 2 : 4));
        y += this.headerH;
      }
      sec.cardsTop = y;
      for (let k = 0; k < sec.count; k++) {
        const r = Math.floor(k / cols), c = k % cols;
        const idx = sec.first + k;
        if (c === 0) this._rows.push([]);
        const row = this._rows[this._rows.length - 1];
        row.push(idx);
        const card = this.cards[idx];
        card.row = this._rows.length - 1;
        card.col = c;
        this._layoutCard(card, c * (cardW + colGap), y + r * (cardH + this.cardGap), {
          cardW, cardH, nameX, stageX, stageW, stageMargin, muzzleInset,
        });
      }
      y += Math.ceil(sec.count / cols) * (cardH + this.cardGap);
      if (sec.label) y += this.sectionGap;
    }
    this._maxScroll = Math.max(0, y - this.region.h);
    this._setScroll(this._scrollY);
  }

  // One card's geometry at content-space `x`,`y`. Split out of _layout (#607) purely because cards
  // no longer flow at a uniform stride — the section loop decides each position and hands it here
  // (#610: an `x` too, now that a row holds several cards).
  //
  // #611 follow-up: `cardW` now varies CONTINUOUSLY (it stretches to fill the region, see _layout)
  // instead of ever being one of two fixed numbers, so nothing below may assume a particular width.
  // Everything that grows with the card hangs off `stageW`; everything on the left is pinned to the
  // fixed `nameX`/`labelW`, and the two full-width overlays (lock scrim, lock label) take `cardW`
  // directly.
  _layoutCard(card, x, y, geom) {
    const { cardW, cardH, nameX, stageX, stageW, muzzleInset } = geom;
    const stageH = cardH - 16;
    card.top = y;
    card.container.setPosition(x, y);
    card.panel.setSize(cardW, cardH);
    card.stage.setPosition(stageX, 8).setSize(stageW, stageH);
    card.name.setX(nameX); card.cat.setX(nameX); card.stats.setX(nameX);
    card.muzzleX = stageX + muzzleInset;
    card.muzzleY = 8 + stageH / 2;
    // The live-fire travel distance — the stage minus the muzzle inset and a right-hand margin. A
    // wider card is a LONGER shot/beam here, which is exactly where the stretch should land.
    card.stageW = Math.max(20, stageW - muzzleInset - 8);
    // Emitter = the mount hardware, base-pivoted just left of the muzzle, barrel aiming right.
    card.emitter?.setDisplaySize(this.emitSize, this.emitSize).setPosition(card.muzzleX - this.emitBack, card.muzzleY);
    // #534: an ability has no muzzle to fire from, so its preview gets the WHOLE stage rect —
    // the effect is centred in it rather than launched from one edge.
    card.preview?.setStage(stageX, 8, stageW, stageH);
    // #611: a custom card's own stage content gets the same rect, in card-local coords — re-placed
    // on every layout so it follows a column-count change (and now a width change) exactly like the
    // emitter/ability preview. The CHASSIS card's `place` re-scales and re-poses its mech to the
    // rect's short side, and the COLOR card's swatch is sized straight off `w`/`h`, so both track a
    // stretched card without any width knowledge of their own (see GarageScene's _chassisCards /
    // _colorCards).
    card.art?.place?.({ x: stageX, y: 8, w: stageW, h: stageH });
    card.lockScrim.setSize(cardW, cardH);
    card.lockLabel.setPosition(cardW / 2, cardH / 2);
    // #610 (added scope): the mounted-slot glyph rides the TOP-RIGHT corner of the preview stage —
    // "the right side of the preview area", but clear of the stage's vertical middle, which is
    // exactly where every shot/beam travels. Origin (1, 0), so it stays pinned to that corner at
    // any stage width — from the narrowest 4-player column up to a stretched 1-across card.
    card.bindText.setPosition(stageX + stageW - (this.compact ? 4 : 6), 8 + (this.compact ? 3 : 5));
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
  }

  // #612 (in scope with the mech-on-an-ability-card change): VISIBILITY CULLING. This used to loop
  // every card unconditionally — a card scrolled well out of the masked region ran its
  // delivery/ability sim and cleared+redrew its Graphics exactly like a visible one, with only the
  // geometry mask throwing the result away. The garage catalog is now the whole item set in one
  // continuous list (#607) at three cards across (#610), so most of it is off-screen at any moment,
  // and each ability card additionally carries a real posed mech. A card outside the region is now
  // both skipped and hidden — the skip is the sim/redraw saving, the hide keeps its (now several)
  // sprites out of the renderer's batch entirely rather than relying on the mask to discard them.
  //
  // A culled card FREEZES rather than resetting — its loop clock, cooldown and in-flight rounds are
  // left exactly where they were, so scrolling back finds the preview mid-stride instead of
  // restarted. The one thing that can't simply pause is SOUND (a held weapon's loop, an in-flight
  // trajectory loop), which is stopped on the way out; the next tick after it comes back re-arms it.
  update(_time, delta) {
    // #197: the toggle only gates AUDIO (see _isAudible) — the visual demo (every card's
    // shot/beam animation) keeps running unconditionally regardless of autoFireEnabled.
    const dt = Math.min(0.05, delta / 1000);
    const top = this._scrollY, bottom = top + this.region.h;
    for (const card of this.cards) {
      const cardTop = card.top ?? 0;
      const onScreen = cardTop < bottom && cardTop + this.cardH > top;
      this._setCardOnScreen(card, onScreen);
      if (onScreen) this._updateCard(card, dt, delta);
    }
  }

  _setCardOnScreen(card, onScreen) {
    if (card.onScreen === onScreen) return;
    card.onScreen = onScreen;
    card.container.setVisible(onScreen);
    if (onScreen) return;
    for (const p of card.projectiles) p.stopTrajectorySfx?.();
    if (card._heldOn) { Audio.stopHeld(card.id); card._heldOn = false; }
  }

  // #612: the caller's build changed (a mount, a chassis swap, a colour) — re-pose every ability
  // card's caster mech. The TEXTURES are the caller's own, re-baked in place under the same keys,
  // so nothing is re-baked here; this is the pose/flatten half only. Cheap enough to call on any
  // build change, and there is no rebuild involved, so scroll position and every preview's loop
  // survive it untouched.
  refreshCaster() {
    for (const c of this.cards) c.preview?.refreshCaster();
  }

  // #197: flip the auto-fire demo's SOUND on/off, persisting the choice — the visual
  // animation (every card's live shot/beam loop) is untouched either way; only the automatic
  // Audio.fire/impact/trajectory/startHeld calls it triggers are gated (see _isAudible, the
  // single choke point every such call goes through). Turning it off immediately mutes
  // anything already mid-loop (a held weapon's loop, an in-flight projectile's trajectory
  // loop) rather than waiting for it to end on its own.
  setAutoFireEnabled(enabled) {
    if (this.autoFireEnabled === enabled) return;
    this.autoFireEnabled = enabled;
    saveAutoFireEnabled(enabled);
    if (!enabled) this._muteCards();
  }

  _muteCards() {
    for (const card of this.cards) {
      for (const p of card.projectiles) p.stopTrajectorySfx?.();
      if (card._heldOn) { Audio.stopHeld(card.id); card._heldOn = false; }
    }
  }

  // ── Per-card firing sim (identical to what the arena fires; see data/delivery.js) ──────

  _updateCard(card, dt, delta) {
    // #611: only ITEM cards animate. A chassis card's mech is a still pose and a colour card's
    // swatch is a flat rect — neither has a delivery sim, an ability effect or a Graphics to redraw.
    if (card.kind !== 'item') return;
    if (card.weapon) this._tickWeapon(card, delta);
    else card.preview?.update(dt);   // #534: ability cards run their own effect loop instead
    this._advance(card, dt, delta);
    this._draw(card);
  }

  // Cadence only — WHEN a trigger pulls. The shared delivery sim owns what each pull emits.
  _tickWeapon(card, delta) {
    const w = card.weapon, d = w.delivery;
    const held = hasHeldSfx(w.id);
    card.holdBeam = false;
    if (d.sustained) {
      card.streamPhase += delta;
      card.holdBeam = card.streamPhase % 2400 < 1600;
      if (held) this._setHeld(card, card.holdBeam);
    } else if (d.pattern === 'stream') {
      card.streamPhase += delta;
      const active = card.streamPhase % 2400 < 1600;
      if (held) this._setHeld(card, active);
      if (active) {
        card.cd -= delta;
        if (card.cd <= 0) { this._fire(card); card.cd = Math.max(1000 / (d.fireRate || 10), 16); }
      } else card.cd = 0;
    } else {
      card.cd -= delta;
      if (card.cd <= 0) {
        this._fire(card);
        const burstDur = d.burst ? (d.count ?? 1) * (d.burst.wubOn ?? d.burst.interval) + ((d.count ?? 1) - 1) * (d.burst.wubOff ?? 0) : 0;
        card.cd = Math.max((w.cycleTime || 800) - burstDur, 250);
      }
    }
  }

  // Sound only plays for the SELECTED card — with every weapon auto-firing on its own
  // cadence, playing all of them at once would be noise; the selected one is what you're
  // actually listening to (e.g. tuning in the Weapon Lab sound panel). #197: ALSO gated on
  // the auto-fire demo's sound toggle — every Audio.fire/impact/trajectory/startHeld call in
  // this file goes through this one check, so flipping autoFireEnabled mutes all of them at
  // once without touching the (always-running) visual sim that calls into this.
  // #607: with a SET of selected ids (the Garage highlights everything mounted, not one pick)
  // "the card you're listening to" is the FOCUSED row instead — the one under the cursor.
  _isAudible(card) {
    if (!this.autoFireEnabled) return false;
    return this._selectedIds ? this.cards[this._focus] === card : card.id === this.selectedId;
  }

  // Held/looping fire sound (#53), mirroring firing.js's edge-detected start/stop — a card
  // never gets a real button press, so "held" here just means "in its active duty-cycle
  // window AND selected"; deselecting a card while it's mid-loop stops it on the next tick.
  _setHeld(card, active) {
    const want = active && this._isAudible(card);
    if (want === !!card._heldOn) return;
    card._heldOn = want;
    if (want) Audio.startHeld(card.id, card.weapon.id);
    else Audio.stopHeld(card.id);
  }

  _fire(card) {
    const plan = planEmissions(card.weapon);
    // Fire + trajectory AUDIO cues (t=0 cue, per-burst-pulse retriggers, trajectory beat)
    // go through the same shared scheduler the arena uses (audio/fireCues.js), so a burst
    // weapon (Pulse Laser) plays one cue per pulse here just as it does in the arena. Sound
    // only plays for the selected card, so the "audible" gate is _isAudible(card); a held/
    // looping weapon's audio comes from its loop (_setHeld) instead — the scheduler no-ops.
    scheduleFireCues(this.scene, card.weapon, plan, this._isAudible(card));
    for (const s of plan.shots) {
      if (s.delay > 0) card.pending.push({ at: s.delay, mode: plan.mode, shot: s });
      else this._emit(card, plan.mode, s);
    }
  }

  // #120: this card's travel distance, scaled by its weapon's range relative to the whole
  // catalog (see CATALOG_MAX_RANGE above) and capped at the stage width.
  _rangeLen(card) {
    return Math.min(card.stageW, card.stageW * previewRangeFrac(card.weapon, CATALOG_MAX_RANGE));
  }

  _emit(card, mode, s) {
    const ax = card.muzzleX, ay = card.muzzleY, color = card.color;
    if (mode === 'contact') {
      card.slashes.push({ t: 0, ttl: 260, color });
      // #224 (temporary): impact sound disabled, see WEAPON_IMPACT_SOUNDS_ENABLED.
      if (WEAPON_IMPACT_SOUNDS_ENABLED && this._isAudible(card)) Audio.impact(card.weapon.id);
      return;
    }
    if (mode === 'hitscan') {
      const len = this._rangeLen(card);
      const burstTtl = card.weapon.delivery.burst?.wubOn ?? 130;
      card.beams.push({ x0: ax, y0: ay, x1: ax + len, y1: ay, color, ttl: burstTtl, age: 0, heavy: card.weapon.delivery.kind === 'rail' });
      // #224 (temporary): impact sound disabled, see WEAPON_IMPACT_SOUNDS_ENABLED.
      if (WEAPON_IMPACT_SOUNDS_ENABLED && this._isAudible(card)) Audio.impact(card.weapon.id);
      return;
    }
    const angle = s.angleOffset;
    const perp = angle + Math.PI / 2;
    const ox = ax + Math.cos(perp) * s.lateral, oy = ay + Math.sin(perp) * s.lateral;
    const p = makeProjectile(card.weapon, ox, oy, angle, { maxDist: this._rangeLen(card) });
    card.projectiles.push(p);
    // Continuous in-flight loop (#56) — mirrors firing.js's _spawnProjectile: only weapons
    // with a `trajectory` stage get one, started a beat after launch.
    // #224 (temporary): trajectory loop start disabled, see WEAPON_TRAJECTORY_SOUNDS_ENABLED.
    if (WEAPON_TRAJECTORY_SOUNDS_ENABLED && this._isAudible(card) && Audio.getSfxParams(card.weapon.id).trajectory) {
      this.scene.time.delayedCall(TRAJECTORY_DELAY, () => {
        if (p.dead) return;
        p.stopTrajectorySfx = Audio.startTrajectoryLoop(card.weapon.id);
      });
    }
  }

  _advance(card, dt, delta) {
    if (card.pending.length) {
      const still = [];
      for (const e of card.pending) { e.at -= delta; if (e.at <= 0) this._emit(card, e.mode, e.shot); else still.push(e); }
      card.pending = still;
    }
    for (const p of card.projectiles) {
      stepProjectile(p, dt, p.homing ? 0 : null);
      if (p.dist >= p.maxDist) {
        p.dead = true;
        p.stopTrajectorySfx?.();   // #56: stop this round's in-flight loop the instant it dies
        // #224 (temporary): impact sound disabled, see WEAPON_IMPACT_SOUNDS_ENABLED.
        if (WEAPON_IMPACT_SOUNDS_ENABLED && this._isAudible(card)) Audio.impact(p.weaponId);
        if (p.ground) card.patches.push({ x: p.x, y: card.muzzleY, r: Math.min(p.ground.radius, 26), born: 0, ttl: p.ground.duration * 1000 });
        else card.bursts.push({ x: p.x, y: p.y, color: p.color, t: 0, ttl: 220 });
      }
    }
    if (card.projectiles.some((p) => p.dead)) card.projectiles = card.projectiles.filter((p) => !p.dead);

    const ms = delta;
    for (const b of card.beams) { b.ttl -= ms; b.age = (b.age ?? 0) + ms; }
    for (const b of card.bursts) b.t += ms;
    for (const s of card.slashes) s.t += ms;
    for (const fp of card.patches) fp.born += ms;
    const SPARK_FADE = 300;
    for (const b of card.beams) { if (b.ttl <= 0) card.dyingBeams.push({ ...b, fadeAge: 0, fadeTtl: SPARK_FADE }); }
    card.beams = card.beams.filter((b) => b.ttl > 0);
    for (const b of card.dyingBeams) b.fadeAge += ms;
    card.dyingBeams = card.dyingBeams.filter((b) => b.fadeAge < b.fadeTtl);
    card.bursts = card.bursts.filter((b) => b.t < b.ttl);
    card.slashes = card.slashes.filter((s) => s.t < s.ttl);
    card.patches = card.patches.filter((fp) => fp.born < fp.ttl);
  }

  _draw(card) {
    const g = card.fxG;
    g.clear();

    // #534: abilities are back as their own card kind (#506) and draw their own live preview into
    // the same Graphics — the real blast/intercept/smoke/squad, not the flat swatch the #188-era
    // comment here described. Weapons fall through to the delivery-sim replay below.
    if (!card.weapon) { card.preview?.draw(g); return; }

    const w = card.weapon;
    // (the emitter/mount is a rotated Image behind fxG, not drawn here — see _buildCard.)
    for (const fp of card.patches) drawGroundFire(g, fp.x, fp.y, fp.r, fp.born, 1);
    if (card.holdBeam) {
      const len = this._rangeLen(card);
      drawBeam(g, card.muzzleX, card.muzzleY, card.muzzleX + len, card.muzzleY, card.color, 1, false, card.streamPhase);
    }
    for (const b of card.beams) drawBeam(g, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age);
    for (const b of card.dyingBeams) drawBeam(g, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age + b.fadeAge, 1 - b.fadeAge / b.fadeTtl);
    for (const p of card.projectiles) {
      let lift = 0;
      if (p.arc) {
        lift = Math.sin((p.dist / p.maxDist) * Math.PI) * Math.min(22, p.maxDist * 0.12);
        g.fillStyle(0x000000, 0.25).fillEllipse(p.x, p.y, 7, 3);
      }
      drawProjectileBody(g, p.x, p.y - lift, p.angle, p.kind, p.color, p.scale || 1, p.dist);
    }
    for (const s of card.slashes) drawSlash(g, card.muzzleX, card.muzzleY, 0, s.t / s.ttl, s.color, 1, 34);
    for (const b of card.bursts) {
      const f = 1 - b.t / b.ttl;
      g.lineStyle(2, b.color, f).strokeCircle(b.x, b.y, (1 - f) * 14 + 2);
    }
  }

  destroy() {
    const s = this.scene;
    s.input.off('wheel', this._onWheel);
    s.input.off('pointerdown', this._onDown);
    s.input.off('pointermove', this._onMove);
    s.input.off('pointerup', this._onUp);
    for (const c of this.cards) {
      if (c._heldOn) Audio.stopHeld(c.id);
      c.preview?.destroy();
    }
    this.maskG.destroy();
    this.root.destroy();
    this.cards = [];
  }
}
