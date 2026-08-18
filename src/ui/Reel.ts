/**
 * Reel — Figma component "Recorder", two faces:
 *   Default  (node 23:783)  — SHAPE labels, seated EAST, shadow falls RIGHT.
 *   Variant2 (node 23:1312) — PROFILE labels, seated WEST, shadow falls LEFT.
 *
 * A 334px film reel. Four spoke-shaped wells are cut out of the face; a black
 * spindle with a cross cutout sits at the hub; 24 tick marks run around the rim.
 *
 * GEOMETRY IS FIXED, CONTENT ROTATES.
 * The four wells are NOT positioned polar-style around a rotating face. They are
 * four fixed boxes at the exact node coordinates:
 *
 *        north  left:159 top:26   16x88   (tall)
 *   west left:26 top:159 88x16          east left:220 top:159 88x16
 *        south  left:159 top:220  16x88   (tall)
 *
 * Each well applies a DISCRETE rotation to its content so the text runs along
 * the spoke. Those rotations differ per face, and they are constants — labels do
 * NOT tumble continuously. Turning the reel re-seats which slot occupies which
 * well; the seat well itself always reads UPRIGHT (0deg on Default east, 0deg on
 * Variant2 west). That is why an earlier `rotate(i*step)` plus a constant -180
 * was wrong: it made every label spin and left the selected one upside down.
 */

import { REEL_ASSETS } from './reelAssets';

const SIZE = 334;
const TICKS = 24;
const TICK_R = 163;
const TICK_LEN = 4;

/** The four wells, in clockwise order starting at the east seat. */
type Well = 'east' | 'south' | 'west' | 'north';
const WELL_ORDER: Well[] = ['east', 'south', 'west', 'north'];

export type ReelVariant = 'default' | 'variant2';

/** A well's box, verbatim from the node. */
const WELL_BOX: Record<Well, { left: number; top: number; w: number; h: number }> = {
  east:  { left: 220, top: 159, w: 88, h: 16 },
  west:  { left: 26,  top: 159, w: 88, h: 16 },
  south: { left: 159, top: 220, w: 16, h: 88 },
  north: { left: 159, top: 26,  w: 16, h: 88 },
};

interface WellStyle {
  /** Discrete rotation of the content wrapper, in degrees. */
  rot: number;
  /** Padding inside the 88px inner row: [left, right]. */
  pad: [number, number];
  /** Gap between label and glyph. Default face only. */
  gap: number;
  /** Default face packs content to the end; Variant2 packs to the start. */
  justify: 'flex-end' | 'flex-start';
}

/**
 * Per-face, per-well rotation and padding — read directly off nodes 23:783 and
 * 23:1312. The seat well (east on Default, west on Variant2) is the 0deg one.
 */
const FACE: Record<ReelVariant, { seat: Well; wells: Record<Well, WellStyle> }> = {
  default: {
    seat: 'east',
    wells: {
      east:  { rot: 0,   pad: [28, 16], gap: 8, justify: 'flex-end' },
      west:  { rot: 180, pad: [28, 16], gap: 6, justify: 'flex-end' },
      south: { rot: 90,  pad: [24, 16], gap: 8, justify: 'flex-end' },
      north: { rot: -90, pad: [28, 16], gap: 8, justify: 'flex-end' },
    },
  },
  variant2: {
    seat: 'west',
    wells: {
      west:  { rot: 0,   pad: [16, 24], gap: 0, justify: 'flex-start' },
      north: { rot: 90,  pad: [16, 24], gap: 0, justify: 'flex-start' },
      east:  { rot: 180, pad: [24, 16], gap: 0, justify: 'flex-start' },
      south: { rot: -90, pad: [16, 24], gap: 0, justify: 'flex-start' },
    },
  },
};

/**
 * Which swatch glyph a Default-face code carries. Variant2 carries none.
 *
 * Verified against the raw nodes on face 23:783 — one mark per slot well:
 *   CL  → Ellipse 6   (23:1084) 16x16 ELLIPSE
 *   SQ  → Rectangle 5 (23:1285) 14x14 RECT, cornerRadius 2
 *   DM  → Rectangle 5 (23:1458) 14x14 RECT, cornerRadius 2
 *   STR → Union       (23:1455) 18x18 VECTOR
 *
 * DM was a duplicate of SQ (both 14x14 rounded rects) until the user rotated
 * it in Figma; it is now VECTOR `82:592`, a 16x16 rounded DIAMOND — a square
 * turned 45deg with its corners softened by the same radius. Downloaded
 * verbatim into `reelAssets.swatchDiamond`. Do NOT re-implement it as a CSS
 * `rotate(45deg)` on the square: that loses the corner treatment, which is
 * what makes it read as a diamond rather than a tilted box.
 *
 * Each mark's own `rotation` cancels its parent well frame's rotation, so
 * every mark's NET world rotation is 0 or a multiple of 90deg. Those
 * counter-rotations keep marks upright inside rotated frames; they do not
 * differentiate the shapes.
 */
type Glyph = 'circle' | 'cross' | 'square' | 'diamond';
const GLYPH_FOR_CODE: Record<string, Glyph> = {
  CL: 'circle', STR: 'cross', DM: 'diamond', SQ: 'square',
};

export type Seat = 'east' | 'west';

export interface ReelSlot {
  code: string;
  value: string;
}

export interface ReelOptions {
  slots: ReelSlot[];
  index?: number;
  /**
   * Which face renders. 'default' carries shape labels with swatch glyphs and a
   * rightward shadow; 'variant2' carries profile labels, no glyphs, leftward
   * shadow. Defaults to 'default'.
   */
  variant?: ReelVariant;
  /**
   * Legacy alias kept for callers that pass a compass seat. 'west' selects the
   * variant2 face, 'east' the default face. `variant` wins when both are given.
   */
  seat?: Seat;
  /** Label size in px. The design's base is 16; node 63:6476 overrides CL to 12. */
  labelSize?: number;
  onChange?: (index: number, slot: ReelSlot) => void;
}

export class Reel {
  readonly el: HTMLDivElement;
  readonly variant: ReelVariant;
  private slotEls: HTMLDivElement[] = [];
  /** The four well boxes, in WELL_ORDER. Content is re-seated into these. */
  private wellEls: Record<Well, HTMLDivElement>;
  private o: ReelOptions;
  private idx: number;
  /** Index into WELL_ORDER of the face's seat well. */
  private seatPos: number;
  private angle = 0;
  private face!: HTMLDivElement;
  private dragging = false;
  private lastAngle = 0;

  constructor(opts: ReelOptions) {
    this.o = opts;
    this.idx = opts.index ?? 0;
    this.variant = opts.variant ?? (opts.seat === 'west' ? 'variant2' : 'default');

    const face = FACE[this.variant];
    this.seatPos = WELL_ORDER.indexOf(face.seat);

    const el = document.createElement('div');
    el.className = `reel reel--${this.variant}`;
    el.setAttribute('role', 'listbox');
    el.tabIndex = 0;

    // The disc with its four wells cut out — one path from the design.
    const disc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    disc.setAttribute('class', 'reel__disc');
    disc.setAttribute('viewBox', REEL_ASSETS.reelDisc.vb);
    disc.innerHTML = REEL_ASSETS.reelDisc.body;

    // Ellipse 3 — the 138px hairline ring, centred.
    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    inner.setAttribute('class', 'reel__inner-ring');
    inner.setAttribute('viewBox', REEL_ASSETS.reelInner.vb);
    inner.innerHTML = REEL_ASSETS.reelInner.body;

    // Tick ring, outside the wells. 24 marks, 4px long, at r=163.
    const ticks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ticks.setAttribute('class', 'reel__ticks');
    ticks.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const c = SIZE / 2;
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', String(c + TICK_R * Math.cos(a)));
      ln.setAttribute('y1', String(c + TICK_R * Math.sin(a)));
      ln.setAttribute('x2', String(c + (TICK_R - TICK_LEN) * Math.cos(a)));
      ln.setAttribute('y2', String(c + (TICK_R - TICK_LEN) * Math.sin(a)));
      ticks.appendChild(ln);
    }

    // Spindle sits above everything and does NOT rotate.
    const hub = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    hub.setAttribute('class', 'reel__hub');
    hub.setAttribute('viewBox', REEL_ASSETS.reelHub.vb);
    hub.innerHTML = REEL_ASSETS.reelHub.body;

    /*
      The face TURNS. Everything that is physically part of the wheel — the
      cut disc, the inner ring, the tick ring, and the four wells — lives in
      this group and rotates together by `this.angle`. Only the spindle stays
      put, because a reel's spindle does not turn with its flange.

      This is the half an earlier version dropped. It correctly learned from
      the audit that labels use DISCRETE per-well rotations rather than a
      continuous cascade, and then over-applied it: it pinned the wells and
      merely re-parented labels between them, so the wheel never moved at all.
      Both things are true at once — the face spins freely under the pointer,
      and each well's content carries a fixed rotation so the seated slot
      reads upright when it arrives.
    */
    this.face = document.createElement('div');
    this.face.className = 'reel__face';
    this.face.style.cssText =
      `position:absolute;inset:0;transform-origin:50% 50%;`;
    // Z-ORDER IS THE NODE'S. Face 23:783 paints, bottom to top:
    //   z=0  Ellipse 3  — the 138px hairline ring
    //   z=1  Subtract   — the grey disc with its four wells cut out
    //   z=26 Frame 5    — the hub (appended outside the face, below)
    //   z=27+ Frames 6-9 — the four well frames
    // The ring goes UNDER the disc, so it shows only through the cut-outs and
    // is interrupted wherever a well sits on it. Painting it above the disc
    // drew a continuous line across the dark wells — a scratch on the surface
    // rather than a groove beneath the spokes.
    this.face.append(inner, disc, ticks);
    el.append(this.face);

    // Build the four fixed wells at their node coordinates.
    this.wellEls = {} as Record<Well, HTMLDivElement>;
    for (const well of WELL_ORDER) {
      const box = WELL_BOX[well];
      const style = face.wells[well];
      const w = document.createElement('div');
      w.className = `reel__well reel__well--${well}`;
      // Structural geometry is set inline, not in the stylesheet: these are the
      // node's own coordinates and they must not depend on a CSS rule landing.
      w.style.cssText =
        `position:absolute;left:${box.left}px;top:${box.top}px;` +
        `width:${box.w}px;height:${box.h}px;` +
        `display:flex;align-items:center;justify-content:center;`;
      // The rotating wrapper: a fixed 88x16 row turned by a DISCRETE angle and
      // centred in the well box. On the tall north/south wells this is what
      // makes an 88px row fit a 16px-wide slot — the row overflows the box and
      // the rotation lays it along the spoke.
      const rotor = document.createElement('div');
      rotor.className = 'reel__rotor';
      rotor.style.cssText =
        `flex:none;transform:rotate(${style.rot}deg);transform-origin:50% 50%;`;
      const row = document.createElement('div');
      row.className = 'reel__row';
      row.style.cssText =
        `display:flex;align-items:center;width:88px;height:16px;` +
        `padding-left:${style.pad[0]}px;padding-right:${style.pad[1]}px;` +
        `justify-content:${style.justify};gap:${style.gap}px;`;
      rotor.appendChild(row);
      w.appendChild(rotor);
      // Wells are part of the wheel, so they ride inside the rotating face.
      this.face.appendChild(w);
      this.wellEls[well] = w;
    }

    // The spindle is the one thing that does NOT turn — it sits above the face.
    el.appendChild(hub);

    // One slot element per option. These are MOVED between wells on select();
    // they never carry a rotation of their own.
    opts.slots.forEach((s, i) => {
      const slot = document.createElement('div');
      slot.className = 'reel__slot';
      slot.setAttribute('role', 'option');
      slot.dataset.index = String(i);
      // Slots now flow inside a well's row. The stylesheet still carries the
      // old absolute/centred `.reel__slot` rule from the rotating-face design;
      // these inline values neutralise it. See the report — that rule should be
      // deleted from components.css by its owner.
      // Per-well justify/gap are applied in render(), which knows the seating.
      slot.style.cssText =
        `position:static;margin:0;left:auto;top:auto;width:100%;height:16px;` +
        `transform:none;display:flex;align-items:center;`;

      const code = document.createElement('span');
      code.className = 'reel__code';
      code.textContent = s.code;
      if (opts.labelSize) code.style.fontSize = `${opts.labelSize}px`;
      slot.appendChild(code);

      // Swatch glyphs belong to the Default face only — Variant2 wells contain
      // a text node and nothing else.
      if (this.variant === 'default') {
        slot.appendChild(this.glyph(GLYPH_FOR_CODE[s.code] ?? 'square'));
      }

      this.slotEls.push(slot);
    });

    this.el = el;

    this.bind();
    this.select(this.idx, false);
  }

  /**
   * Build the swatch that pairs with a Default-face label.
   *
   * Every mark carries its node's own size INLINE and, for the vector marks,
   * paints via `fill:currentColor` on the path — never via a CSS background.
   * The stylesheet's `.reel__swatch` rule is a 14x14 `border-radius:2px`
   * `background:currentColor` box, which is only ever correct for the square:
   * applied to the SVG marks it painted a solid grey rectangle BEHIND the
   * circle and the star. `background:none` here neutralises it for those two
   * without touching the file that owns the rule.
   *
   * Selection must change COLOUR ONLY. The stylesheet additionally rewrites a
   * selected swatch to `border-radius:50%; width:16px; height:16px`, which
   * turns a selected SQ/DM square into a circle and crops the star — an
   * invention with no basis in the design. The inline width/height below win
   * over that rule's dimensions; its `border-radius` still needs deleting by
   * the stylesheet's owner (reported).
   */
  private glyph(kind: Glyph): HTMLElement {
    if (kind === 'square') {
      // Rectangle 5 — 14x14, cornerRadius 2. A CSS box is the honest
      // representation here, but pin the geometry inline so the selected-state
      // override cannot resize or round it away.
      const d = document.createElement('span');
      d.className = 'reel__swatch reel__swatch--square';
      d.style.cssText =
        'width:14px;height:14px;border-radius:2px;' +
        'background:currentColor;flex:none;';
      return d;
    }
    // Ellipse 6 (16x16), Rectangle 5 (16x16 diamond) and Union (18x18) — real
    // geometry from the nodes, used verbatim.
    const asset =
      kind === 'circle'  ? REEL_ASSETS.swatchCircle :
      kind === 'diamond' ? REEL_ASSETS.swatchDiamond :
                           REEL_ASSETS.swatchCross;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `reel__swatch reel__swatch--${kind}`);
    svg.setAttribute('viewBox', asset.vb);
    svg.setAttribute('width', String(asset.w));
    svg.setAttribute('height', String(asset.h));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText =
      `width:${asset.w}px;height:${asset.h}px;flex:none;` +
      `background:none;border-radius:0;color:currentColor;overflow:visible;`;
    svg.innerHTML = asset.body;
    return svg as unknown as HTMLElement;
  }

  get index() { return this.idx; }
  get slot() { return this.o.slots[this.idx]; }

  /**
   * Seat a slot.
   *
   * `spin` controls whether the FACE turns. A user's drag already turned it, and
   * a programmatic re-seat must NOT: the right reel follows the left (it shows
   * the newly-selected shape's saved profile), and rotating its face for that
   * made it visibly jump — turning the left wheel 90 degrees threw the right
   * one from +90 to -90. The wheels are independent objects; only the seated
   * LABEL changes when the other wheel moves.
   */
  select(i: number, notify = true, spin = true) {
    const n = this.o.slots.length;
    this.idx = ((i % n) + n) % n;
    if (spin) this.angle = -this.idx * (360 / n);
    this.render();
    if (notify) this.o.onChange?.(this.idx, this.o.slots[this.idx]);
  }

  /**
   * Re-seat the slots. The selected slot goes into the face's seat well (where
   * the rotation is 0, so it reads upright); the rest follow clockwise.
   */
  private render() {
    const n = this.o.slots.length;
    // Turn the wheel. Wells ride with it; each well's own discrete rotation
    // (set at build time) is what keeps the seated slot upright on arrival.
    this.face.style.transform = `rotate(${this.angle}deg)`;

    /*
      Which well currently FACES THE CHANNEL.

      The face rotates, so the seat well physically travels with it — after a
      90deg turn the well that started at the seat is a quarter turn away. The
      slot that reads as selected must therefore go into whichever well has
      rotated INTO the seat position, not into the fixed seat well.

      Without this the orange tracked the selection index while the visible
      slot tracked the rotation, and the two drifted apart: at 180deg the label
      on screen was SQ while DM was orange.
    */
    const step = 360 / WELL_ORDER.length;
    // How many wells the face has turned through, normalised to 0..3.
    const turned = ((Math.round(this.angle / step) % WELL_ORDER.length)
      + WELL_ORDER.length) % WELL_ORDER.length;

    this.slotEls.forEach((slotEl, i) => {
      // Offset from the selection, clockwise, wrapped into the four wells.
      const offset = ((i - this.idx) % n + n) % n;
      // Counter-rotate the seat by however far the face has turned, so the
      // selected slot lands in the well now pointing at the channel.
      const well = WELL_ORDER[
        ((this.seatPos + offset - turned) % WELL_ORDER.length + WELL_ORDER.length)
        % WELL_ORDER.length
      ];
      const row = this.wellEls[well].firstElementChild!.firstElementChild!;
      if (slotEl.parentElement !== row) row.appendChild(slotEl);
      // Alignment belongs to the WELL, so it follows the slot as it re-seats.
      const style = FACE[this.variant].wells[well];
      slotEl.style.justifyContent = style.justify;
      slotEl.style.gap = `${style.gap}px`;
      const on = i === this.idx;
      slotEl.classList.toggle('is-selected', on);
      slotEl.setAttribute('aria-selected', String(on));
    });
  }

  private angleFrom(e: PointerEvent): number {
    const r = this.el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2),
                      e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  }

  private bind() {
    const el = this.el;

    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastAngle = this.angleFrom(e);
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add('is-active');
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const a = this.angleFrom(e);
      let d = a - this.lastAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.lastAngle = a;
      this.angle += d;
      // The face follows the pointer FREELY — one full turn of the wheel per
      // full sweep of the finger. Which slot is seated snaps per step as the
      // wheel passes it, but the rotation itself is continuous.
      const step = 360 / this.o.slots.length;
      const want = Math.round(-this.angle / step);
      const n = this.o.slots.length;
      this.idx = ((want % n) + n) % n;
      this.render();
    });

    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
      el.classList.remove('is-active');
      const step = 360 / this.o.slots.length;
      this.select(Math.round(-this.angle / step));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('keydown', (e) => {
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': this.select(this.idx + 1); break;
        case 'ArrowUp':   case 'ArrowLeft':  this.select(this.idx - 1); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
  }
}
