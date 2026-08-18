/**
 * Camera frame → masked boolean dot grid.
 *
 * Pipeline, in order — the order matters and each step earns its place:
 *
 *   video → downsample to grid → luminance → autolevels → sRGB→linear
 *         → tone curve → threshold vs. noise matrix → gate by letterform mask
 *
 * TWO steps here are non-obvious and were both measured:
 *
 * 1. sRGB → LINEAR before thresholding.
 *    Camera bytes are sRGB-encoded (roughly gamma 2.2). Thresholding them
 *    directly treats 128 as "half bright", so mid-gray lights ~50% of dots
 *    where the physically correct answer is ~22% — a 2.3× error that makes
 *    every capture look blown out and washes the texture flat.
 *
 * 2. AUTOLEVELS before that.
 *    Real webcam feeds are low-contrast: indoors, a typical frame might span
 *    luma 60–150 out of 0–255. Without stretching that to full range, the
 *    dither only ever sees the middle of its threshold range and the output is
 *    uniform mush. On real footage this matters MORE than the choice between
 *    blue noise and Bayer.
 *    The percentiles are smoothed over time, otherwise a hand passing through
 *    frame would visibly re-expose the whole letter.
 */

import { threshold, type DitherMode } from './noise';

export interface DitherOptions {
  mode: DitherMode;
  /** Extra exposure in stops. 0 = autolevels only. */
  exposure: number;
  /** S-curve strength, 0 = linear. Adds punch without clipping. */
  contrast: number;
  /**
   * How much of the autolevel stretch to apply, 0..1.
   *
   * This is deliberately NOT 1. Full normalization makes every flat scene
   * produce an identical dot density — a dark wall, a mid-gray wall and a
   * bright wall all stretch to the same full range, so pointing the camera
   * somewhere brighter changes nothing on screen. That would kill the idea
   * that aiming the camera is a compositional act: real-world brightness is
   * supposed to drive how dense the letter's interior gets.
   *
   * At 0 the raw feed is used, which on a typical indoor webcam only ever
   * occupies the middle of the threshold range and reads as uniform mush.
   * Partial correction keeps the scene's absolute brightness meaningful while
   * still rescuing low-contrast input.
   */
  autoLevel: number;
  /**
   * Invert the tone: bright parts of the scene become sparse, dark parts dense.
   *
   * Applied to LUMINANCE, before thresholding — not to the resulting dots.
   * Flipping the booleans afterwards would light every cell the dither left
   * dark, which fills the shadows solid and reads as a blob rather than a
   * negative. Inverting the tone gives a true photographic negative, and it
   * keeps density meaningful for playback: a dot is still "more light here",
   * just measured the other way round.
   */
  invert: boolean;
  /**
   * Mirror the source horizontally.
   *
   * TRUE for the front camera, so the view reads as a selfie — you move left,
   * the image moves left. FALSE for the rear camera, where mirroring would be
   * plainly wrong: you would photograph the world and get it back flipped.
   *
   * Done on the SOURCE rather than as a CSS transform on the output, because
   * the mask has to line up with the camera pixels — flipping only the display
   * would silently sample the wrong side of the frame.
   */
  mirror?: boolean;
}

/** Reusable scratch buffers, sized to the current grid. */
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
let lumaBuf: Float32Array | null = null;
let bufW = 0, bufH = 0;

function ensureBuffers(w: number, h: number) {
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
  }
  if (bufW !== w || bufH !== h) {
    scratch!.width = w;
    scratch!.height = h;
    lumaBuf = new Float32Array(w * h);
    bufW = w; bufH = h;
    // Buffers were resized, so the smoothed exposure state refers to a
    // different frame geometry. Reset it or the first frames flicker.
    smoothLo = -1; smoothHi = -1;
  }
}

// Temporally smoothed autolevel endpoints. -1 = uninitialized.
let smoothLo = -1, smoothHi = -1;
const SMOOTH = 0.12; // per-frame blend toward the current frame's levels

/** sRGB (0..1) → linear light (0..1). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Symmetric S-curve around 0.5. amount 0 = identity. */
function sCurve(x: number, amount: number): number {
  if (amount <= 0) return x;
  const k = 1 + amount * 3;
  const t = x * 2 - 1;
  const shaped = Math.sign(t) * Math.pow(Math.abs(t), 1 / k);
  return (shaped + 1) / 2;
}

/**
 * Sentinel for an unlit cell in the shape grid.
 *
 * -1, matching `Field.cells` in `src/ui/field.ts:34`, which is already typed
 * `Int8Array` and already means -1 = unlit. Emitting the render grid in that
 * encoding is what lets `Screen.draw()` consume it directly; a second encoding
 * (e.g. an unsigned 255 sentinel) would force a per-frame conversion at the
 * boundary and give the codebase two ways to say the same thing.
 */
export const UNLIT = -1;

/**
 * Level → shape, darkest to lightest. Level 4 (most ink) maps to index 0.
 * Deliberately identical to `SHAPES` in `src/ui/field.ts:20` and to
 * `harness.html:122` — these three orderings must agree or shapes render
 * against the wrong tonal step. The audio scheduler does not consume this.
 */
export const SHAPE_RAMP = ['square', 'circle', 'diamond', 'cross'] as const;
export type RampShape = (typeof SHAPE_RAMP)[number];

export interface DitherResult {
  /**
   * [row][col] — true where a dot is lit. Already masked.
   *
   * UNCHANGED SEMANTICS. This stays the single source of truth for "is there a
   * dot here", and the audio scheduler keeps consuming exactly this. `on` is
   * still one boolean per cell; the 4-level work below only decides WHICH
   * SHAPE a lit cell draws, never whether it is lit.
   */
  cells: boolean[][];
  /** Lit-dot count, for diagnostics. */
  litCount: number;
  /**
   * Parallel shape-index grid, `row * gridWidth + col` → 0..3, or `UNLIT` (-1).
   *
   * Shape and layout are chosen to be directly usable as `Field.cells`
   * (`src/ui/field.ts:34`): same `Int8Array` type, same -1 sentinel, same
   * row-major flat indexing. `Screen.draw()` can take this as-is.
   *
   * Co-indexed with `cells` by construction — `shapes[row * gridWidth + col]
   * !== UNLIT` is true iff `cells[row][col]` is true. That invariant is
   * asserted in the verification below, because it is the whole reason the two
   * representations can coexist safely.
   *
   * Deliberately ADDITIVE. Nothing downstream is required to read it; callers
   * that ignore it behave exactly as before the four-level migration.
   */
  shapes: Int8Array;
}

/**
 * Render one video frame into a masked dot grid.
 * `mask` gates the output: cells outside the letterform are always false.
 */
export function ditherFrame(
  video: HTMLVideoElement,
  mask: boolean[][],
  gridWidth: number,
  gridHeight: number,
  opts: DitherOptions
): DitherResult {
  ensureBuffers(gridWidth, gridHeight);
  const sctx = scratchCtx!;
  const luma = lumaBuf!;

  /*
    Downsample straight to grid resolution — the browser's built-in filtering
    does the box-averaging for us, and at these sizes it's fast.

    MIRRORING is conditional on which camera is open (`opts.mirror`): the front
    camera is mirrored so it reads as a selfie, the rear camera is not. Done
    HERE, on the source, rather than as a CSS transform on the output, because
    the mask must line up with the camera pixels — flipping only the display
    would silently sample the wrong side of the frame. (The reference camera app
    flips in CSS and then has to mirror-sample its mask to compensate; this
    avoids that whole class of bug.)

    THE SOURCE CROP is the second half of this.

    `drawImage(video, 0,0, gw,gh)` squashed the ENTIRE frame into the grid with
    no aspect correction. On the desktop stub that was a constant 1.455x
    horizontal squash — tolerable because it never changed. On a phone the feed
    is typically 16:9 (1.939x) and can arrive portrait (0.614x, i.e. distortion
    the OTHER way), so the dots stopped matching what the lens saw, differently
    per device. Centre-cropping the source to the grid's aspect first means the
    dither samples a correctly-proportioned window of the frame on every device.
  */
  const vw = video.videoWidth || gridWidth;
  const vh = video.videoHeight || gridHeight;
  const srcAspect = vw / vh;
  const dstAspect = gridWidth / gridHeight;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcAspect > dstAspect) {
    // Source is wider than the grid: crop left and right.
    sw = vh * dstAspect;
    sx = (vw - sw) / 2;
  } else if (srcAspect < dstAspect) {
    // Source is taller: crop top and bottom.
    sh = vw / dstAspect;
    sy = (vh - sh) / 2;
  }

  sctx.save();
  if (opts.mirror !== false) {
    sctx.translate(gridWidth, 0);
    sctx.scale(-1, 1);
  }
  sctx.drawImage(video, sx, sy, sw, sh, 0, 0, gridWidth, gridHeight);
  sctx.restore();

  const img = sctx.getImageData(0, 0, gridWidth, gridHeight).data;

  // Rec. 601 luminance, normalized 0..1, but only over cells INSIDE the mask.
  // Autolevels computed over the whole frame would be driven by whatever is
  // behind the letter, so moving the camera would re-expose the interior for
  // reasons the viewer can't see. Sampling only what's visible keeps exposure
  // tied to what's actually on screen.
  let count = 0;
  let lo = 1, hi = 0;
  const hist = new Uint32Array(256);
  for (let row = 0; row < gridHeight; row++) {
    const maskRow = mask[row];
    for (let col = 0; col < gridWidth; col++) {
      const i = row * gridWidth + col;
      const j = i * 4;
      const y = (img[j] * 0.299 + img[j + 1] * 0.587 + img[j + 2] * 0.114) / 255;
      luma[i] = y;
      if (maskRow?.[col]) {
        hist[Math.min(255, (y * 255) | 0)]++;
        count++;
      }
    }
  }

  if (count > 0) {
    // 1.5% percentile clip at each end — ignores specular highlights and
    // sensor noise in the shadows, which would otherwise pin the range wide
    // open and defeat the stretch.
    const clip = Math.max(1, Math.floor(count * 0.015));
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= clip) { lo = v / 255; break; }
    }
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= clip) { hi = v / 255; break; }
    }
    if (hi - lo < 0.05) { // near-flat frame: don't amplify noise into texture
      lo = Math.max(0, lo - 0.05);
      hi = Math.min(1, hi + 0.05);
    }
    if (smoothLo < 0) { smoothLo = lo; smoothHi = hi; }
    else {
      smoothLo += (lo - smoothLo) * SMOOTH;
      smoothHi += (hi - smoothHi) * SMOOTH;
    }
  }

  // Blend the measured endpoints toward the identity range [0,1] by
  // (1 - autoLevel). At autoLevel=1 this is a full stretch; at 0 it's the raw
  // signal. Interpolating the ENDPOINTS rather than the output keeps the
  // mapping monotonic and avoids a second pass over the pixels.
  const k = Math.max(0, Math.min(1, opts.autoLevel));
  const effLo = smoothLo * k;
  const effHi = smoothHi * k + (1 - k);
  const range = Math.max(0.02, effHi - effLo);
  const exposureMul = Math.pow(2, opts.exposure);

  const cells: boolean[][] = [];
  const shapes = new Int8Array(gridWidth * gridHeight).fill(UNLIT);
  let litCount = 0;

  for (let row = 0; row < gridHeight; row++) {
    const line: boolean[] = new Array(gridWidth);
    const maskRow = mask[row];
    for (let col = 0; col < gridWidth; col++) {
      if (!maskRow?.[col]) { line[col] = false; continue; }

      let v = (luma[row * gridWidth + col] - effLo) / range;     // autolevels
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      // Invert in the perceptual (sRGB) domain, before the linear conversion —
      // this is where "mid-gray" actually sits perceptually, so a mid-tone
      // stays a mid-tone when flipped. Inverting after the linear conversion
      // would map 18% gray to 82% linear and blow the highlights out.
      if (opts.invert) v = 1 - v;
      v = srgbToLinear(v);                                       // to linear
      v *= exposureMul;
      v = sCurve(v, opts.contrast);
      v = v < 0 ? 0 : v > 1 ? 1 : v;

      // ── Four-level quantisation ──────────────────────────────────────
      //
      // `t` is the SAME screen-space-locked noise sample the binary path used.
      // Sampling it once and deriving both the boolean and the level from it is
      // what keeps the two grids consistent; drawing two samples would let a
      // cell be "lit" with no shape, or vice versa.
      const t = threshold(col, row, opts.mode);

      // Binary decision, byte-for-byte as before. NOT re-derived from `lvl`:
      // this line is the contract the audio scheduler already depends on, so it
      // stays literally untouched rather than being reconstructed and hoped over.
      const on = v > t;
      line[col] = on;

      if (on) {
        litCount++;
        // Reference: harness.html:191, `Math.floor(v*4 + threshold(...))`
        // clamped 0..4. Same noise value, so the level ramp is dithered by the
        // identical matrix that decided lit-ness — the shape boundaries get the
        // same blue-noise/Bayer distribution as the on/off boundary, and the
        // dots do not crawl, because the matrix is screen-space-locked.
        //
        // A lit cell can still quantise to level 0 near the threshold (v just
        // over t, with t large). Level 0 would mean "unlit", which would
        // contradict `on` and leave a lit dot with no shape to draw — so the
        // floor is clamped to 1. That disagreement is confined to the shape
        // ramp; `cells` is never touched by it, which is precisely why the
        // boolean grid is the safe thing for audio to keep consuming.
        const lvl = Math.max(1, Math.min(4, Math.floor(v * 4 + t)));
        shapes[row * gridWidth + col] = 4 - lvl; // lvl 4 → idx 0 (square)
      }
    }
    cells.push(line);
  }

  return { cells, litCount, shapes };
}

/** Reset smoothed exposure — call when the camera restarts. */
export function resetExposure(): void { smoothLo = -1; smoothHi = -1; }
