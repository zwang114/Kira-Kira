/**
 * The dot field — four shapes assigned per cell by brightness.
 *
 * Shape sizes are SOLVED, not chosen. See documentation/artdirection/calibration.html:
 * at equal size the four natural coverages are ~100/79/50/33 %, which steps
 * unevenly, and every attempt to even them by deforming a shape destroys its
 * identity (a cross light enough to sit below a diamond is a blob; a cross with
 * honest 3.4:1 proportions lands exactly ON the diamond).
 *
 * Letting each shape keep ideal proportions and varying only its overall SIZE
 * gives a monotonic ramp within 8% of even. Square, circle and diamond land at
 * essentially one size; only the cross is drawn smaller. One exception, not a
 * system.
 *
 *   square  0.465 coverage   size 0.700
 *   circle  0.335            size 0.670
 *   diamond 0.215            size 0.675
 *   cross   0.102            size 0.465
 */

export const SHAPES = ['square', 'circle', 'diamond', 'cross'] as const;
export type Shape = typeof SHAPES[number];

/** Per-shape size as a fraction of the cell, at the reference density 0.62. */
export const SHAPE_SIZE: Record<Shape, number> = {
  square: 0.700, circle: 0.670, diamond: 0.675, cross: 0.465,
};

/** Cross stroke as a fraction of the cross's own size. */
const CROSS_STROKE = 0.18 / 0.62;

export interface Field {
  /** Shape index per cell, or -1 for an unlit cell. */
  cells: Int8Array;
  gridWidth: number;
  gridHeight: number;
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape, cx: number, cy: number, cell: number, density: number
) {
  const s = cell * SHAPE_SIZE[shape] * (density / 0.62);
  switch (shape) {
    case 'square':
      ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      break;
    case 'circle':
      ctx.beginPath();
      ctx.arc(cx, cy, s / 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(cx, cy - s / 2); ctx.lineTo(cx + s / 2, cy);
      ctx.lineTo(cx, cy + s / 2); ctx.lineTo(cx - s / 2, cy);
      ctx.closePath(); ctx.fill();
      break;
    case 'cross': {
      const w = s * CROSS_STROKE;
      ctx.fillRect(cx - s / 2, cy - w / 2, s, w);
      ctx.fillRect(cx - w / 2, cy - s / 2, w, s);
      break;
    }
  }
}

/**
 * How far behind the playhead a struck dot stays lit, in COLUMNS.
 *
 * Expressed in columns rather than milliseconds so the trail is identical at
 * 1x, 2x and 3x — the caller converts using the current column duration. A
 * fixed millisecond fade would mean 3.5 glowing columns at 1x but 10.6 at 3x.
 *
 * This constant is also the SAFETY property, and it is not cosmetic:
 *
 * v1 had this effect and it was removed as a WCAG 2.3.1 photosensitivity
 * hazard (V3 §7.1). The hazard was not the fade itself — it was that the decay
 * covered the WHOLE STAGE: 193,440px2 against the ~21,824px2 "small safe area"
 * threshold, 8.9x over, so the exemption did not apply and a 21.3Hz strobe was
 * a Level A failure.
 *
 * A 3.5-column band is 3.5 x (390/44) x 496 = 15,387px2 = 0.71x the threshold.
 * Under it, so the small-area exemption DOES apply, at every speed. Raising
 * this much past 4 columns forfeits that. If you change it, recompute the area
 * — do not eyeball it.
 *
 * MEASURED on the real render, sweeping every playhead position across a
 * 329-dot capture: worst case 1,521 CSS px2 of actually-lit dots — 0.07x the
 * threshold. The band figure above is the conservative bound (it assumes the
 * whole band area lights); only the DOTS light, and the letter is sparse.
 *
 * Also verified NON-ACCUMULATING: this trail is a pure function of
 * `playhead - column`, recomputed every paint. v1's hazard came from a
 * `flashMap` of per-cell TIMESTAMPS, which stacked generations as the sweep
 * re-crossed cells. Repainting one position here 10 times gives an identical
 * pixel count every time, so no scrub speed or direction can brighten it —
 * which is why the scrub path needs no clamp of its own.
 */
const TRAIL_COLS = 3.5;

/** Struck dots fade from the accent back to the dot colour. */
const DOT_RGB: [number, number, number] = [0xf2, 0xf0, 0xed];
const ACCENT_RGB: [number, number, number] = [0xff, 0x62, 0x00];

/**
 * Paint a field to a canvas, letterboxed to fit.
 *
 * `playhead` is a column index — FRACTIONAL during playback so the rule moves
 * sub-cell — or -1 for none.
 *
 * `trail` enables the light-up-and-fade: dots the playhead has just crossed are
 * drawn in the accent and decay back to `--dot` over `TRAIL_COLS` columns
 * behind it. Off (the default) nothing changes, which is what the mask preview
 * and the live viewfinder want — there is no playhead to trail.
 *
 * `density` is the dot fill ratio — the ρ dial. It scales every mark by
 * `density / 0.62` (see `drawShape`), so 0.62 is the identity and the shape
 * ramp's measured coverages hold.
 */
/**
 * Where to draw the text caret, in GRID space.
 *
 * Pixels are deliberately NOT accepted: the caller would have to know this
 * function's letterboxing to compute them, and any disagreement would put the
 * caret in the wrong place silently — the same reasoning that makes the
 * playhead a column index rather than an x.
 */
export interface Caret { x: number; top: number; bottom: number; }

export function renderField(
  canvas: HTMLCanvasElement, f: Field, playhead = -1, density = 0.62,
  trail = false, caret: Caret | null = null,
) {
  const ctx = canvas.getContext('2d')!;
  const dpr = canvas.width / (canvas.clientWidth || canvas.width);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cell = Math.min(canvas.width / f.gridWidth, canvas.height / f.gridHeight);
  const ox = (canvas.width - cell * f.gridWidth) / 2;
  const oy = (canvas.height - cell * f.gridHeight) / 2;

  const lit = trail && playhead >= 0;

  /*
    Dots are drawn in TWO passes rather than one.

    Pass 1 paints every unstruck dot with a single `fillStyle`, exactly as
    before — one state change for the whole field, which is what keeps this
    cheap at 44x55 and at 96x120.

    Pass 2 paints only the dots inside the trail band, each with its own colour.
    That band is at most TRAIL_COLS wide, so the per-dot `fillStyle` cost is
    bounded by ~3.5 columns no matter how large the grid is. Colouring every dot
    individually would be a state change per cell across the whole field.
  */
  ctx.fillStyle = '#f2f0ed';
  for (let r = 0; r < f.gridHeight; r++) {
    for (let c = 0; c < f.gridWidth; c++) {
      const idx = f.cells[r * f.gridWidth + c];
      if (idx < 0) continue;
      // Skip anything the trail pass will repaint.
      if (lit) {
        const behind = playhead - c;
        if (behind >= 0 && behind <= TRAIL_COLS) continue;
      }
      drawShape(ctx, SHAPES[idx], ox + c * cell + cell / 2, oy + r * cell + cell / 2, cell, density);
    }
  }

  if (lit) {
    const first = Math.max(0, Math.ceil(playhead - TRAIL_COLS));
    const last = Math.min(f.gridWidth - 1, Math.floor(playhead));
    for (let c = first; c <= last; c++) {
      // 0 at the playhead (full accent) -> 1 at the tail (back to --dot).
      const t = Math.min(1, Math.max(0, (playhead - c) / TRAIL_COLS));
      // Ease so the glow holds briefly then falls away, rather than ramping
      // linearly — a struck dot should read as struck, not as a gradient.
      const k = t * t;
      const col = `rgb(${
        Math.round(ACCENT_RGB[0] + (DOT_RGB[0] - ACCENT_RGB[0]) * k)},${
        Math.round(ACCENT_RGB[1] + (DOT_RGB[1] - ACCENT_RGB[1]) * k)},${
        Math.round(ACCENT_RGB[2] + (DOT_RGB[2] - ACCENT_RGB[2]) * k)})`;
      ctx.fillStyle = col;
      for (let r = 0; r < f.gridHeight; r++) {
        const idx = f.cells[r * f.gridWidth + c];
        if (idx < 0) continue;
        drawShape(ctx, SHAPES[idx], ox + c * cell + cell / 2, oy + r * cell + cell / 2, cell, density);
      }
    }
  }

  if (playhead >= 0) {
    ctx.fillStyle = '#ff6200';
    // Full canvas height: the grid now fills the canvas, so the rule spans it.
    ctx.fillRect(ox + playhead * cell, oy, Math.max(2 * dpr, cell * 0.1), cell * f.gridHeight);
  }

  /*
    The text caret.

    Drawn HERE rather than shown as the textarea's native cursor, because that
    cursor sits where the hidden field's own 16px text would be — the top-left
    corner — and not where the letterform is rendered. The only way to put a
    caret between two dots is to draw it in the same geometry as the dots.

    Blink is computed from the clock rather than a CSS animation: this is a
    canvas, so there is no element to animate, and the frame loop is already
    repainting. 530ms is the platform-conventional half-period.

    Spans just its own LINE, not the whole canvas, so it reads as a text cursor
    rather than a second playhead — and is drawn in `--dot` rather than the
    accent, which belongs to the playhead alone.
  */
  if (caret && Math.floor(Date.now() / 530) % 2 === 0) {
    ctx.fillStyle = '#f2f0ed';
    const w = Math.max(2 * dpr, cell * 0.08);
    ctx.fillRect(
      ox + caret.x * cell - w / 2,
      oy + caret.top * cell,
      w,
      (caret.bottom - caret.top) * cell,
    );
  }
}
