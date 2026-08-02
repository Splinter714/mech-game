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
import { stepIndex, scrollToShow } from './padNav.js';
import { orderByLock } from './catalogOrder.js';
// #534: the ability half of the live preview. Weapon cards live-fire through the shared delivery
// sim; ability cards replay their own real effect (shared FX specs, the real intercept selector,
// the real smoke art, the real drone AI) through this — see its header for what's real per
// ability and what's a declared stand-in.
import { AbilityCardPreview } from './abilityPreview.js';

// Shared weapon/ability card list — the SINGLE implementation behind both the standalone
// Weapon Lab tab and the garage catalog, so the two can't drift. It renders a scrollable
// column of cards inside a bounded region; each weapon card auto-fires a live shot/beam
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
//   list.setRegion(x, y, w, h); // on resize
//   list.destroy();
//
// #505 (second correction): `compact: true` (see COMPACT_* below) shrinks every card's
// height/label width/emitter size for use inside a narrow Garage column — GarageScene's one
// catalog per player, up to 4 on screen at once. The full-size default is unchanged and stays
// what ArtPreviewScene's standalone Weapon Lab tab uses.

const UI = {
  panel: 0x161b22, panelEdge: 0x2a333f, panelSel: 0x1b2430, stage: 0x0b0e12,
  text: '#c8d2dd', dim: '#7c8794', sel: 0xefc14a, focus: 0x5ec8e0,
};

const CARD_H = 96;
const CARD_GAP = 12;
const LABEL_W = 200;     // left block: name + stats

// #505 (second correction): a `compact` list keeps the exact same live-fire-preview card shape
// (mount emitter + real shot/beam sim + name/category/stats) at a much smaller footprint, so it
// fits inside a Garage COLUMN that can be as narrow as 1/4 of the screen at 4 players — the
// full-size numbers above stay the Weapon Lab's (ArtPreviewScene) untouched default. Text still
// word-wraps within labelW regardless of mode, so neither size ever overflows into the stage.
const COMPACT_CARD_H = 60;
const COMPACT_CARD_GAP = 6;
const COMPACT_LABEL_W = 108;

// #607: a SECTIONED list — the Garage's catalog is now ONE continuous scrolling list with a
// labelled band per section (ABILITIES, then WEAPONS) instead of the per-column tab system
// (#529/#532) that used to swap whole catalogs in and out. A section header is a plain label row
// in the same scroll space as the cards; `SECTION_GAP` is the breathing room after a section's
// last card. An UNLABELLED single section (what `setIds` builds — the Weapon Lab's usage) draws
// no header and takes no gap, so that path lays out byte-identically to before.
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
  // binds off whatever row is FOCUSED, and hovering is how a mouse focuses). `onScroll(scrollY)`
  // fires on every scroll change, so a caller that parks its own content below the cards (see
  // `setExtraHeight`) can move it in the same scroll space.
  constructor(scene, {
    x, y, w, h, ids, sections = null, onSelect = null, onHover = null, onScroll = null,
    selectedId = null, isLocked = null, costOf = null, compact = false,
  } = {}) {
    this.scene = scene;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onScroll = onScroll;
    this.selectedId = selectedId;
    this._selectedIds = null;
    this.isLocked = isLocked;
    this.costOf = costOf;
    this.compact = compact;
    this.cardH = compact ? COMPACT_CARD_H : CARD_H;
    this.cardGap = compact ? COMPACT_CARD_GAP : CARD_GAP;
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
    // #607: content height the CALLER draws below the cards, inside the same scroll space (the
    // Garage's CHASSIS/COLOR rows). Counts toward maxScroll; the caller positions its own
    // container off `onScroll`/`cardsHeight()`.
    this._extraH = 0;
    this._cardsH = 0;
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

  // ── Pad focus cursor (#70) — optional; only the garage drives it. ──────────────────────
  // setFocus(i) highlights card i (null/-1 clears) and, by default, auto-scrolls it into view;
  // moveFocus steps it (clamped, no wrap — it's a scrolling list); focusedId() is what A / a
  // slot bind acts on. setIds() clears the focus, so a refilter needs a fresh setFocus.
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

  moveFocus(delta) {
    if (!this.cards.length) return;
    Audio.ui('menuNav');   // #178: short quiet blip — pad/keyboard catalog browsing
    this.setFocus(this._focus < 0 ? 0 : stepIndex(this._focus, delta, this.cards.length, { wrap: false }));
  }

  focusedId() { return this.cards[this._focus]?.id ?? null; }

  indexOfId(id) { return this.cards.findIndex((c) => c.id === id); }

  // ── #607: the seams a caller needs to run ONE continuous cursor across this list and its own
  // trailing content (the Garage's CHASSIS/COLOR rows). ────────────────────────────────────────
  cardCount() { return this.cards.length; }

  focusIndex() { return this._focus; }

  // Drop the focus highlight without moving scroll — the caller's cursor has left this list for
  // its own trailing rows.
  clearFocus() {
    this._focus = -1;
    for (const c of this.cards) this._paintSelection(c);
  }

  scrollY() { return this._scrollY; }

  // Content-space y just past the last card — where the caller's own trailing block starts.
  cardsHeight() { return this._cardsH; }

  // Declare how tall the caller's trailing block is, so it scrolls as part of this list.
  setExtraHeight(h) {
    this._extraH = Math.max(0, h || 0);
    this._layout();
  }

  // Scroll an arbitrary content-space rect into view (the caller's trailing rows).
  scrollToContent(top, h) {
    this._setScroll(scrollToShow(this._scrollY, top, h, this.region.h, this._maxScroll));
  }

  // Which section card `i` belongs to, and where a section's first card sits — the two queries a
  // section-jump control (#607's D-pad left/right) needs.
  sectionIdOf(i) {
    const sec = this._sections.find((s) => i >= s.first && i < s.first + s.count);
    return sec?.id ?? null;
  }

  sectionFirstIndex(id) {
    return this._sections.find((s) => s.id === id)?.first ?? 0;
  }

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
  // stash the canonical ids for refreshLocks() to re-sort against on unlock.
  setIds(ids) {
    this.setSections([{ id: 'all', label: null, ids }]);
  }

  // #607: the sectioned form of setIds. `sections` is [{ id, label, ids }] in display order; a
  // null/absent `label` draws no header row (and takes no trailing section gap), so the single
  // unlabelled section `setIds` builds lays out exactly as the pre-#607 flat list did. Lock
  // sorting (#78) applies WITHIN each section, so a locked weapon never sorts out of its band.
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
    this._ids = [];   // canonical order, pre lock-sort — remembered for refreshLocks()/sameIds()
    for (const sec of sections) {
      const ids = [...(sec.ids ?? [])];
      const meta = { id: sec.id, label: sec.label ?? null, first: this.cards.length, count: ids.length, headerText: null, top: 0 };
      if (meta.label) {
        meta.headerText = this.scene.add.text(0, 0, meta.label, {
          fontFamily: 'monospace', fontSize: this.compact ? '9px' : '12px', color: UI.dim,
        });
        this.scroller.add(meta.headerText);
      }
      for (const id of orderByLock(ids, this.isLocked)) this._buildCard(getItem(id), id);
      this._sections.push(meta);
      this._ids.push(...ids);
    }
    this._scrollY = 0;
    this._layout();
  }

  _buildCard(item, id) {
    const index = this.cards.length;   // #607: this card's flat index, for the onHover callback
    const weapon = isWeapon(id) ? item : null;
    // #506: abilities are their own visually distinct kind, with their own accent color.
    const color = weapon ? (CATEGORIES[weapon.category]?.color ?? 0xffffff) : 0x7bd17b;
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
    const name = this.scene.add.text(0, nameY, item.name, {
      fontFamily: 'monospace', fontSize: nameSize, color: UI.text, wordWrap: { width: wrapW },
    });
    const catLabel = weapon ? (CATEGORIES[weapon.category]?.label ?? weapon.category) : 'Ability';
    const cat = this.scene.add.text(0, catY, catLabel, {
      fontFamily: 'monospace', fontSize: catSize, color: Phaser.Display.Color.IntegerToColor(color).rgba, wordWrap: { width: wrapW },
    });
    const stats = this.scene.add.text(0, statsY, this._statLines(item, weapon), {
      fontFamily: 'monospace', fontSize: statsSize, color: UI.dim, lineSpacing: this.compact ? 1 : 2, wordWrap: { width: wrapW },
    });
    const fxG = this.scene.add.graphics();
    // #534: an ability card's live preview. It owns a `layer` container (for the Smoke Screen
    // puff sprites) that sits BELOW fxG, matching the arena's own depth order — smoke is ground
    // FX, the caster and its blasts draw over it. Vector work goes straight into fxG alongside
    // the weapon cards', so a card is still exactly one Graphics redraw per frame.
    const preview = weapon ? null : new AbilityCardPreview(this.scene, id, item, color, this.cards.length);

    // #65: a lock overlay — a dim scrim over the whole card plus a centred "🔒 N SCRAP" label
    // — sits on TOP of everything when the item is locked, hiding the live preview without
    // tearing it down (still simulated underneath so unlocking it needs no rebuild of state).
    const lockScrim = this.scene.add.rectangle(0, 0, 100, cardH, 0x05070a, 0.72).setOrigin(0, 0).setVisible(false);
    const lockLabel = this.scene.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: this.compact ? '10px' : '13px', color: '#f5c542', align: 'center',
    }).setOrigin(0.5).setVisible(false);

    // emitter sits under fxG so projectiles/beams render over the muzzle; the lock overlay
    // sits above everything.
    c.add([panel, stage, swatch, ...(emitter ? [emitter] : []), name, cat, stats,
      ...(preview ? [preview.layer] : []), fxG, lockScrim, lockLabel]);
    this.scroller.add(c);

    const card = {
      id, item, weapon, color, container: c, panel, stage, emitter, name, cat, stats, fxG,
      lockScrim, lockLabel, preview,
      cd: this.cards.length * 120, streamPhase: 0, holdBeam: false,
      pending: [], projectiles: [], beams: [], dyingBeams: [], bursts: [], slashes: [], patches: [],
    };

    if (this.onSelect) {
      panel.setInteractive({ useHandCursor: true });
      panel.on('pointerover', () => {
        // #607: hovering a card is how the MOUSE moves the shared row cursor — the Garage binds
        // whatever row is focused into whichever slot button gets pressed, so the pointer has to
        // drive that same focus rather than a separate hover-only highlight.
        this.onHover?.(id, index);
        if (!this._isSelected(card)) { panel.setFillStyle(UI.panelSel); Audio.ui('menuNav'); }
      });
      panel.on('pointerout', () => this._paintSelection(card));
      panel.on('pointerdown', () => this.onSelect(id));
    }
    this.cards.push(card);
    this._paintSelection(card);
    this._paintLock(card);
  }

  // #65: apply/refresh a single card's locked look without rebuilding it. Call after a
  // purchase (or any balance change) to redraw locks in place — cheaper than setIds().
  _paintLock(card) {
    const locked = this.isLocked?.(card.id) ?? false;
    card.lockScrim.setVisible(locked);
    card.lockLabel.setVisible(locked);
    if (locked) {
      const cost = this.costOf?.(card.id) ?? 0;
      card.lockLabel.setText(`🔒 LOCKED\n${cost} SCRAP`);
    }
  }

  // Re-evaluate every card's locked state in place (e.g. after a purchase changes the
  // unlocked set or the SCRAP balance) — no rebuild, no preview-sim reset, and (per the #78
  // follow-up) no re-sort: reordering the instant a purchase completes moved cards out from
  // under the player's cursor. The list keeps its current order until the next natural
  // rebuild (setIds(), e.g. a slot change or leaving/re-entering the garage), which already
  // applies orderByLock() against the live isLocked state — so a purchased item settles into
  // its canonical slot on the next real navigation, not mid-interaction.
  refreshLocks() {
    for (const c of this.cards) this._paintLock(c);
  }

  _paintSelection(card) {
    const on = this._isSelected(card);
    const focused = this._focus >= 0 && this.cards[this._focus] === card;
    card.panel.setFillStyle(on || focused ? UI.panelSel : UI.panel)
      .setStrokeStyle(on || focused ? 2 : 1, focused ? UI.focus : on ? UI.sel : UI.panelEdge);
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

  // Flow cards into a single column within the region; compute max scroll. Margins shrink in
  // `compact` mode alongside cardH/labelW/emitSize (see the constructor) — the shape (label
  // block, live-fire stage, emitter at the muzzle) is unchanged, only the numbers are smaller.
  _layout() {
    const cardW = this.region.w;
    const cardH = this.cardH;
    const nameX = this.compact ? 6 : 20;
    const stageGap = this.compact ? 4 : 8;
    const stageMargin = this.compact ? 6 : 12;
    const muzzleInset = this.compact ? 8 : 14;
    const stageX = this.labelW + stageGap;
    const stageW = cardW - stageX - stageMargin;
    // #607: cards flow section by section (header row, then that section's cards, then a gap)
    // rather than as one uniform stride, and each card remembers its own content-space `top` so
    // focus-scrolling and a caller's section jump can both address it directly.
    let y = 0;
    for (const sec of this._sections) {
      sec.top = y;
      if (sec.headerText) {
        sec.headerText.setPosition(nameX, y + (this.compact ? 2 : 4));
        y += this.headerH;
      }
      sec.cardsTop = y;
      for (let k = 0; k < sec.count; k++) this._layoutCard(this.cards[sec.first + k], y + k * (cardH + this.cardGap), {
        cardW, cardH, nameX, stageX, stageW, stageMargin, muzzleInset,
      });
      y += sec.count * (cardH + this.cardGap);
      if (sec.label) y += this.sectionGap;
    }
    this._cardsH = y;
    this._maxScroll = Math.max(0, y + this._extraH - this.region.h);
    this._setScroll(this._scrollY);
  }

  // One card's geometry at content-space `y`. Split out of _layout (#607) purely because cards no
  // longer flow at a uniform stride — the section loop decides each y and hands it here.
  _layoutCard(card, y, geom) {
    const { cardW, cardH, nameX, stageX, stageW, muzzleInset } = geom;
    card.top = y;
    card.container.setPosition(0, y);
    card.panel.setSize(cardW, cardH);
    card.stage.setPosition(stageX, 8).setSize(Math.max(20, stageW), cardH - 16);
    card.name.setX(nameX); card.cat.setX(nameX); card.stats.setX(nameX);
    card.muzzleX = stageX + muzzleInset;
    card.muzzleY = 8 + (cardH - 16) / 2;
    card.stageW = Math.max(20, stageW - muzzleInset - 8);
    // Emitter = the mount hardware, base-pivoted just left of the muzzle, barrel aiming right.
    card.emitter?.setDisplaySize(this.emitSize, this.emitSize).setPosition(card.muzzleX - this.emitBack, card.muzzleY);
    // #534: an ability has no muzzle to fire from, so its preview gets the WHOLE stage rect —
    // the effect is centred in it rather than launched from one edge.
    card.preview?.setStage(stageX, 8, Math.max(20, stageW), cardH - 16);
    card.lockScrim.setSize(cardW, cardH);
    card.lockLabel.setPosition(cardW / 2, cardH / 2);
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
    // #607: lets a caller keep its own trailing content (see setExtraHeight) in the same scroll
    // space — it isn't inside `scroller`, so it has to be moved explicitly.
    this.onScroll?.(this._scrollY);
  }

  update(_time, delta) {
    // #197: the toggle only gates AUDIO (see _isAudible) — the visual demo (every card's
    // shot/beam animation) keeps running unconditionally regardless of autoFireEnabled.
    const dt = Math.min(0.05, delta / 1000);
    for (const card of this.cards) this._updateCard(card, dt, delta);
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
