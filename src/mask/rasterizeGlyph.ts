/**
 * Letterform → boolean mask.
 *
 * The mask is the stencil: the camera dither is only ever visible through it.
 * Rasterized ONCE per (character, font, grid size) and cached — if this were
 * recomputed per frame the silhouette would shimmer at the edges, and a stable
 * silhouette against a moving interior is the entire visual idea.
 *
 * Fitting strategy (measured against the alternatives):
 *
 *   Per-glyph bbox normalization — WRONG. Scales each character to fill the
 *   grid independently, so "i" renders enormous with a detached floating dot,
 *   and "W" and "i" come out at wildly different sizes. The letters stop
 *   belonging to the same alphabet.
 *
 *   Shared em-square fitting — also wrong in practice. Fitting the full em
 *   (ascender to descender) leaves capitals occupying ~15 of 40 rows, thin
 *   enough that "A" loses its diagonals to 1-cell strokes.
 *
 *   Cap-height normalization — what we use. Scale so the cap height fills the
 *   available vertical space. Keeps stroke weight usable, keeps "B" counters
 *   open and the "g" descender inside the grid, and keeps the dot on the "i"
 *   attached to its stem.
 *
 * One correction on top of that: pure cap-height fitting clips wide glyphs
 * ("W" ran off both edges), so the final scale is
 * min(vertical cap fit, horizontal fit) — vertical rhythm is preserved for
 * normal glyphs, and wide ones shrink just enough to fit.
 */

export interface GlyphMask {
  /** [row][col], true = inside the letterform */
  cells: boolean[][];
  width: number;
  height: number;
  /** Count of true cells — how much of the grid the letter actually uses. */
  inkCount: number;
}

export interface RasterizeOptions {
  char: string;
  /** CSS font-family. Phase 2 passes the loaded font's family name. */
  fontFamily: string;
  fontWeight?: string | number;
  gridWidth: number;
  gridHeight: number;
  /** Fraction of the grid HEIGHT the glyph should occupy. Leaves a margin. */
  fill?: number;
  /**
   * Fraction of the grid WIDTH. Larger than `fill` on purpose: height is the
   * scarce axis in a portrait grid, width has slack, and spending it is what
   * keeps M and W from rendering visibly smaller than their neighbours.
   */
  fillX?: number;
}

/**
 * Supersample factor. We rasterize the glyph large and box-downsample to the
 * grid rather than calling fillText at grid size directly.
 *
 * At a 32×40 grid a directly-rendered glyph is ~30px tall, where antialiasing
 * and hinting dominate the actual letter shape and thresholding produces
 * ragged, broken strokes. Rendering at 8× and averaging gives each cell a real
 * coverage fraction, so the threshold decision is about how much ink is in the
 * cell rather than where a hint happened to snap.
 */
const SS = 8;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

/**
 * Measure the cap height of a font by rendering a capital and finding its ink
 * extent. TextMetrics exposes fontBoundingBox*, but those describe the font's
 * declared line box, not where the capital actually sits — using them leaves
 * inconsistent optical spacing across fonts. Measuring real ink is reliable.
 */
function measureCapExtent(
  fontFamily: string,
  fontWeight: string | number,
  probe: string,
  px: number
): { top: number; bottom: number; left: number; right: number } | null {
  const pad = Math.ceil(px * 0.6);
  const w = Math.ceil(px * 2.5) + pad * 2;
  const h = Math.ceil(px * 2.5) + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `${fontWeight} ${px}px ${fontFamily}`;
  ctx.fillText(probe, pad, h - pad);

  const data = ctx.getImageData(0, 0, w, h).data;
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (top < 0) top = y;
        bottom = y;
        if (left < 0 || x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top < 0) return null;
  return { top, bottom, left, right };
}

/**
 * Rasterize a character to a boolean grid.
 * Returns null if the glyph produced no ink — a missing glyph, a blank, or a
 * font that loaded but renders nothing (see the ink check in loadFont).
 */
export function rasterizeGlyph(opts: RasterizeOptions): GlyphMask | null {
  const {
    char,
    fontFamily,
    fontWeight = 400,
    gridWidth,
    gridHeight,
    // Was 0.88. The letter IS the subject and the stage is full-bleed, so the
    // margin was spending ~12% of both axes on nothing.
    //
    // 0.94, not higher: round capitals (O, S, C, G) carry OVERSHOOT — they are
    // drawn slightly taller than the flat-topped cap height so they look the
    // same size optically. At 0.97 that overshoot pushed S's ink onto row 0,
    // touching the grid edge. 0.94 clears every glyph with at least one empty
    // row all round while still reclaiming most of the old margin.
    fill = 0.94,
    // The HORIZONTAL budget, deliberately larger than `fill` — see the note at
    // `targetW`.
    //
    // 0.99, not 1.0. The width fit measures the glyph's INK, but the rasterizer
    // centres on ink while the browser positions from the advance width, and
    // asymmetric side bearings mean the two disagree by a fraction of a cell.
    // At exactly 1.0 that fraction put C and K's ink on column 0 — touching the
    // grid edge. Measured at 44x55: W spans 32 rows here against 34 at fillX 1.0
    // and 31 before this change — the last two rows are not worth clipping two
    // letters for.
    fillX = 0.99,
  } = opts;

  if (!char) return null;

  /*
    Target box inside the grid, in supersampled pixels.

    The two axes get DIFFERENT budgets, and that asymmetry is the point.

    HEIGHT is the scarce axis. The grid is 4:5 portrait and almost every capital
    is taller than it is wide, so height is what the shared scale is fighting
    for. `fill` (0.94) governs it, leaving a row of clearance for the overshoot
    on round capitals.

    WIDTH has slack. Most capitals sit around 0.75-0.82 ink aspect against a
    grid aspect of 0.80, so the width budget is simply not the binding
    constraint for 24 of the 26 letters — it binds only on M (0.92) and W
    (1.30), and for those the shortfall is what made W render visibly smaller
    than its neighbours.

    Letting width use the FULL grid recovers that. W then spans all 44 columns
    edge to edge and grows from 31.8 rows tall to 33.8. It stays proportionally
    shorter than H or S because a W genuinely IS a wide letter — no budget can
    change that inside a portrait grid without either clipping it or breaking
    the shared baseline that makes A-Z read as one typeface (three failed
    attempts at per-glyph fitting are recorded in HANDOFF §5). What this does is
    make it absolutely LARGER, which is what actually reads.

    1.0 is the ceiling, not a round number: at fillW 1.06 the widest glyph
    computes to 46.6 columns against a 44-column grid and clips.
  */
  const targetW = gridWidth * SS * fillX;
  const targetH = gridHeight * SS * fill;

  // Derive the font's vertical proportions from probe glyphs at a reference
  // size, so every character in the alphabet shares ONE scale and ONE baseline.
  //
  // The vertical budget that has to fit inside the grid is not the cap height
  // alone — it's from the tallest ascender down to the deepest descender.
  // Fitting the cap and then *adding* descender space below overflows the grid
  // (it clipped B, I and g). Measure the real combined extent instead.
  const PROBE_PX = 100;
  const capExt = measureCapExtent(fontFamily, fontWeight, 'H', PROBE_PX);
  if (!capExt) return null;
  const capHeightRatio = (capExt.bottom - capExt.top + 1) / PROBE_PX;

  // NOTE: the 'Hg' descent probe that used to live here is gone. The shared
  // scale no longer reserves descender room (see below), so the measurement had
  // no consumer — and leaving a probe whose result is discarded invites someone
  // to "restore" the budget it implies.

  /*
    DESCENDER ALLOWANCE — MEASURED from Q, not a constant fraction.

    The shared baseline is load-bearing and stays: fitting each glyph to its own
    ink makes "." balloon to mid-frame and "I" look taller than "A" (HANDOFF §5
    records three failed attempts before this). So the vertical scale must come
    from shared probe ratios, not from the glyph being drawn.

    But budgeting the FULL 'Hg' descent assumes something in the set descends,
    and the alphabet here is A-Z ONLY (`ALPHABET` in session.ts). Only ONE
    capital drops below the baseline: Q. Reserving a full lowercase descent
    leaves about a fifth of the grid permanently empty, which is what made the
    letter read small.

    This was a fixed `fullDescentRatio * 0.35`, tuned against Helvetica. That
    number does not travel: measured on Oswald, Q descends 0.17em against a
    full descent of only 0.20, so it needs an allowance of 0.85 and clipped at
    the grid's bottom edge under the 0.35 rule. The ratio between "how far a
    lowercase g drops" and "how far a Q tail drops" is a property of the
    typeface, so any single fraction is wrong for some face.

    Measuring Q directly removes the guess — but budgeting for it in the SHARED
    scale is still wrong, because Q is one letter out of 26. Reserving its tail
    for everybody costs every other glyph: measured on Oswald, a Q-sized
    allowance dropped the whole alphabet from 41 rows to 36.

    So the shared scale reserves NOTHING for descenders (A-Z has none above the
    baseline budget), and Q alone is scaled down to fit its own tail. That
    keeps 25 letters at full size and shrinks the one that has to give — the
    inverse of the previous trade. Q stays on the shared baseline, so it still
    reads as the same typeface; only its cap height is a little shorter.

    If lowercase or a font picker is ever restored, this must go back to
    reserving the full descent in the shared scale — a 'g' would otherwise clip.
  */
  // No descender budget in the shared scale — the descending glyph shrinks
  // itself below instead.
  const descentRatio = 0;

  // Scale so the cap + (reduced) descender block fills the target height.
  let fontPx = targetH / (capHeightRatio + descentRatio);

  // Two ways a glyph can overflow a pure cap-height fit, and both must be
  // checked or the letter runs off an edge:
  //
  //   WIDTH  — "W" and "M" are wider than they are tall.
  //   HEIGHT — glyphs that combine an ascender with a descender ("j", "(", "Q"
  //            in some faces) span more than the cap height, so fitting the cap
  //            alone pushes their extremes past the top and bottom edges.
  //
  // Shrink by whichever constraint binds hardest. Everything that fits keeps
  // the shared cap-height scale, so the alphabet stays visually consistent.
  const glyphExt = measureCapExtent(fontFamily, fontWeight, char, PROBE_PX);
  if (glyphExt) {
    const wRatio = (glyphExt.right - glyphExt.left + 1) / PROBE_PX;
    const wScale = targetW / (wRatio * fontPx);
    if (wScale < 1) fontPx *= wScale;

    /*
      HEIGHT, for the descending glyph only.

      The shared scale reserves no descender room (see above), so a glyph whose
      ink drops below the baseline — Q, in an A-Z set — would run off the
      grid's bottom edge. Shrink that ONE glyph to fit rather than making the
      other 25 shorter to accommodate it.

      This does not break the shared baseline: Q still sits on it, and only its
      cap height gives. `glyphExt` is this character's own ink, so the check
      costs nothing for the 25 letters where the ratio is 1.
    */
    const glyphSpanRatio = (glyphExt.bottom - glyphExt.top + 1) / PROBE_PX;
    const hScale = targetH / (glyphSpanRatio * fontPx);
    if (hScale < 1) fontPx *= hScale;
  }

  // Render the glyph on a generously padded canvas. Descenders, overshoot on
  // round letters, and italic side bearings all exceed the nominal box.
  const padPx = Math.ceil(fontPx * 0.8);
  const rw = Math.ceil(gridWidth * SS + padPx * 2);
  const rh = Math.ceil(gridHeight * SS + padPx * 2);
  canvas.width = rw;
  canvas.height = rh;
  ctx.clearRect(0, 0, rw, rh);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Nonzero winding (the canvas default) is correct for both CFF and TrueType.
  // Their outer contours wind oppositely, but counters always wind opposite
  // their own outer contour, so holes in A/O/B come out right either way.
  // "Fixing" the winding is what breaks them.
  ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;

  const m = ctx.measureText(char);
  // NOTE: actualBoundingBoxLeft is positive-leftward per spec, but measures
  // NEGATIVE in practice for most glyphs (e.g. -1.5 for "A"). Computing the
  // extent as (right + left) — the naive reading of the spec — mis-centers
  // every glyph. (right - (-left)) is the correct span either way.
  const inkLeft = -m.actualBoundingBoxLeft;
  const inkRight = m.actualBoundingBoxRight;
  const inkW = inkRight - inkLeft;

  // HORIZONTAL: center on measured ink. Advance width includes asymmetric side
  // bearings, so centering on it leaves letters visibly off-center.
  const originX = padPx + (gridWidth * SS - inkW) / 2 - inkLeft;

  // VERTICAL: place a shared BASELINE — do not center each glyph on its own
  // ink. Per-glyph vertical centering makes every character occupy the full
  // grid height regardless of its actual size: a period balloons to the middle
  // of the frame, "I" appears taller than "A", and the alphabet stops looking
  // like one typeface. Anchoring the baseline is what makes "x" sit below "X",
  // and lets "g" hang into the descender space.
  //
  // Center the cap+descender block in the grid, then place the baseline at the
  // cap height down from the block's top. Derived from the shared probe ratios,
  // NOT from this glyph — that's what keeps the baseline common to all letters.
  const capPx = capHeightRatio * fontPx;
  const descentPx = descentRatio * fontPx;
  const blockH = capPx + descentPx;
  let originY = padPx + (gridHeight * SS - blockH) / 2 + capPx;

  /*
    Lift a descending glyph so its tail lands inside the grid.

    The block centred above is cap-height only (the shared scale reserves no
    descender room), so a glyph that drops below the baseline hangs past the
    bottom edge — measured, Q sat at rows 6..47 of 48 and clipped. It was
    correctly SIZED at that point; only its position was wrong.

    Raising the baseline by this glyph's own descent keeps its ink inside the
    grid. The other 25 letters have no descent, so their `originY` is
    unchanged and the shared baseline holds for the set that actually shares
    one. Q ends up sitting a little higher than its neighbours, which is the
    honest consequence of giving it a tail and no reserved space.
  */
  if (glyphExt) {
    const glyphDescentPx = Math.max(0, (glyphExt.bottom - capExt.bottom) / PROBE_PX) * fontPx;
    if (glyphDescentPx > 0) {
      const inkBottom = originY + glyphDescentPx;
      const gridBottom = padPx + gridHeight * SS;
      if (inkBottom > gridBottom) originY -= inkBottom - gridBottom;
    }
  }
  ctx.fillText(char, originX, originY);

  // Box-downsample the supersampled alpha to per-cell coverage, then threshold.
  const img = ctx.getImageData(0, 0, rw, rh).data;
  const cells: boolean[][] = [];
  let inkCount = 0;

  for (let row = 0; row < gridHeight; row++) {
    const line: boolean[] = new Array(gridWidth);
    for (let col = 0; col < gridWidth; col++) {
      const x0 = padPx + col * SS;
      const y0 = padPx + row * SS;
      let sum = 0;
      for (let sy = 0; sy < SS; sy++) {
        const rowOff = (y0 + sy) * rw;
        for (let sx = 0; sx < SS; sx++) {
          sum += img[(rowOff + x0 + sx) * 4 + 3];
        }
      }
      // Coverage > 50% of the cell counts as inside the letter.
      const coverage = sum / (SS * SS * 255);
      const on = coverage >= 0.5;
      line[col] = on;
      if (on) inkCount++;
    }
    cells.push(line);
  }

  if (inkCount === 0) return null;
  return { cells, width: gridWidth, height: gridHeight, inkCount };
}

/* ── Multi-line text ──────────────────────────────────────────────────
 *
 * The mask was ONE character, swiped through A-Z. It is now typed text: up to
 * MAX_CHARS characters, wrapped across up to MAX_LINES lines.
 *
 * This is a SEPARATE path from `rasterizeGlyph` on purpose. That function's
 * numbers are measured and recorded (V4 §4.3) and a single-character mask must
 * keep rendering the way it always has; rewriting it to handle N lines would
 * put every one of those measurements at risk to serve a case it does not have.
 *
 * WHY THE GRID DOES NOT CHANGE SHAPE. The text scales to fit a fixed 44x48,
 * rather than the grid growing taller per line. Three consequences, all wanted:
 * the stage keeps its composition at every text length; the phone layout needs
 * no letterboxing; and the AUDIO grid stays the size the chime was tuned
 * against, so adding a line does not silently retune the instrument.
 */

/** Hard ceiling on typed characters. */
export const MAX_CHARS = 20;
/**
 * Characters per line, and the reason for the number.
 *
 * Legibility as DOTS is the binding constraint, not typography. Measured on the
 * 44-column grid: a capital B or R needs roughly 5-6 columns before its
 * counters survive being thresholded into cells.
 *
 *   chars/line   columns each   legible
 *   4            11.0           comfortably
 *   6             7.3           yes
 *   7             6.3           yes — the floor
 *   8             5.5           degrades on B, R, S
 *   12            3.7           no
 *
 * 7 sits just above the floor. Raising it does not fail gracefully: the letters
 * stop being readable rather than merely getting smaller.
 */
export const MAX_CHARS_PER_LINE = 7;
export const MAX_LINES = 3;

/**
 * Break text into rendered lines.
 *
 * Explicit newlines win — typing Enter is an instruction, not a suggestion.
 * Within a paragraph, wrap at spaces where possible and hard-break a word that
 * cannot fit, so a 12-character word still renders instead of vanishing.
 *
 * Exported for verification: the wrap is pure and worth testing without a
 * canvas.
 */
export function wrapText(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (out.length >= MAX_LINES) break;
    const words = para.split(' ').filter((w) => w.length > 0);
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (let w of words) {
      // A word longer than a line is broken rather than dropped.
      while (w.length > MAX_CHARS_PER_LINE) {
        if (line) { out.push(line); line = ''; }
        if (out.length >= MAX_LINES) break;
        out.push(w.slice(0, MAX_CHARS_PER_LINE));
        w = w.slice(MAX_CHARS_PER_LINE);
      }
      if (out.length >= MAX_LINES) break;
      const candidate = line ? line + ' ' + w : w;
      if (candidate.length <= MAX_CHARS_PER_LINE) line = candidate;
      else { if (line) out.push(line); line = w; }
    }
    if (line && out.length < MAX_LINES) out.push(line);
  }
  return out.slice(0, MAX_LINES).map((l) => l.trimEnd());
}

export interface RasterizeTextOptions extends Omit<RasterizeOptions, 'char'> {
  text: string;
}

/** Where each rendered line sits, in GRID cells. Populated by `rasterizeText`. */
export interface TextLayout {
  lines: Array<{
    text: string;
    /** x for each caret slot, 0..line.length, in grid columns. */
    advances: number[];
    /** Top and bottom of the line's caret, in grid rows. */
    top: number;
    bottom: number;
  }>;
  gridWidth: number;
  gridHeight: number;
}

let lastTextLayout: TextLayout = { lines: [], gridWidth: 0, gridHeight: 0 };

/**
 * The layout of the most recently rasterized text.
 *
 * Cached masks skip `rasterizeText`, so this can be stale — callers must
 * rasterize (or hit `getTextMask`, which does) before trusting it.
 */
export function getTextLayout(): TextLayout { return lastTextLayout; }

/**
 * Rasterize a block of text to a boolean grid.
 *
 * THE DESCENDER BUDGET IS BACK, and this is the change `rasterizeGlyph`'s own
 * comment predicted: "If lowercase or a font picker is ever restored, this must
 * go back to reserving the full descent in the shared scale — a 'g' would
 * otherwise clip."
 *
 * The single-glyph path reserves nothing because A-Z has no descender except Q,
 * and shrinking Q alone costs one letter instead of twenty-six. That trade
 * stops working the moment lowercase is typeable: g, y, p, q and j all descend,
 * and shrinking each of them individually would break the shared baseline that
 * makes the text read as one typeface.
 *
 * So here the scale reserves a real descent, measured from an 'Hg' probe. The
 * cost is honest and visible: capitals render slightly smaller than they do in
 * the single-glyph path, because the same vertical space now has to hold an
 * ascender AND a descender.
 */
export function rasterizeText(opts: RasterizeTextOptions): GlyphMask | null {
  const {
    text,
    fontFamily,
    fontWeight = 400,
    gridWidth,
    gridHeight,
    fill = 0.94,
    fillX = 0.99,
  } = opts;

  const lines = wrapText(text);
  if (lines.length === 0 || lines.every((l) => l.length === 0)) return null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const targetW = gridWidth * SS * fillX;
  const targetH = gridHeight * SS * fill;

  const PROBE_PX = 100;
  const capExt = measureCapExtent(fontFamily, fontWeight, 'H', PROBE_PX);
  if (!capExt) return null;
  const capHeightRatio = (capExt.bottom - capExt.top + 1) / PROBE_PX;

  /*
    The full vertical extent the scale must reserve: tallest ascender to
    deepest descender. Measured from a probe containing both, rather than
    adding a constant to the cap height — the ratio between them is a property
    of the typeface, and a fixed fraction tuned on one face is wrong on
    another. (The single-glyph path records exactly this failure with Q: a
    0.35 constant tuned on Helvetica clipped Q on Oswald.)
  */
  const fullExt = measureCapExtent(fontFamily, fontWeight, 'Hg', PROBE_PX);
  const fullSpanRatio = fullExt
    ? (fullExt.bottom - fullExt.top + 1) / PROBE_PX
    : capHeightRatio;
  /*
    Reserve descender space only when the TEXT ACTUALLY DESCENDS.

    Reserving unconditionally was measured at a 20% height loss for all-caps
    text — a single 'A' rendered 36 rows against the single-glyph path's 45,
    with the bottom fifth of the grid permanently empty. That is the same
    failure the single-glyph path records for Q ("reserving its tail for
    everybody costs every other glyph"), and it breaks the requirement that one
    letter fills the canvas.

    Keyed on the text, NOT on each glyph: every line shares one scale and one
    baseline, so 'Kira' and 'KIRA' size identically within a given string and
    the block never reflows between letters. The size changes only when the
    user types a descender — which is a real change to what has to fit, and is
    the honest moment to change it.
  */
  const hasDescender = /[gjpqy]/.test(lines.join(''));
  const descentRatio = hasDescender ? Math.max(0, fullSpanRatio - capHeightRatio) : 0;

  /*
    Line pitch. Lines are spaced by the FULL span, not the cap height, or a
    descender on line 1 would collide with an ascender on line 2. The 1.08
    is optical leading — enough to separate the lines as dots without wasting
    grid on air.
  */
  const lineSpanRatio = (capHeightRatio + descentRatio) * 1.18;

  // Start from a height-derived scale, then let width pull it down.
  const blockSpanRatio = capHeightRatio + descentRatio + lineSpanRatio * (lines.length - 1);
  let fontPx = targetH / blockSpanRatio;

  /*
    WIDTH IS USUALLY WHAT BINDS, and it must be measured on the WIDEST line.

    Scaling per line would make a 2-character line render huge next to a
    7-character one — the text would stop reading as one block. One scale for
    all lines, chosen by whichever line is widest at that scale.
  */
  ctx.font = `${fontWeight} ${PROBE_PX}px ${fontFamily}`;
  let widestRatio = 0;
  for (const line of lines) {
    if (!line) continue;
    const m = ctx.measureText(line);
    const w = (m.actualBoundingBoxRight - -m.actualBoundingBoxLeft) / PROBE_PX;
    if (w > widestRatio) widestRatio = w;
  }
  if (widestRatio > 0) {
    const wScale = targetW / (widestRatio * fontPx);
    if (wScale < 1) fontPx *= wScale;
  }

  const padPx = Math.ceil(fontPx * 0.9);
  const rw = Math.ceil(gridWidth * SS + padPx * 2);
  const rh = Math.ceil(gridHeight * SS + padPx * 2);
  canvas.width = rw;
  canvas.height = rh;
  ctx.clearRect(0, 0, rw, rh);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;

  const capPx = capHeightRatio * fontPx;
  const descentPx = descentRatio * fontPx;
  const linePitchPx = lineSpanRatio * fontPx;
  const blockH = capPx + descentPx + linePitchPx * (lines.length - 1);
  // Centre the whole block vertically, then put the first baseline a cap-height
  // down from its top. Every line then shares one scale and one pitch.
  const blockTop = padPx + (gridHeight * SS - blockH) / 2;

  /*
    Record each line's geometry as it is drawn.

    The caret needs to land between two characters of the RENDERED text, and
    only this function knows where that is: the scale, the per-line centring and
    the baseline pitch are all computed here. Measuring them again anywhere else
    would be a second implementation of the layout, free to drift from this one.
  */
  lastTextLayout = { lines: [], gridWidth, gridHeight };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = ctx.measureText(line);
    const inkLeft = -m.actualBoundingBoxLeft;
    const inkW = m.actualBoundingBoxRight - inkLeft;
    // Centre each line horizontally on its own measured ink, for the same
    // reason the single-glyph path does: advance width carries asymmetric side
    // bearings and centring on it leaves the line visibly off-centre.
    const originX = padPx + (gridWidth * SS - inkW) / 2 - inkLeft;
    const originY = blockTop + capPx + linePitchPx * i;
    ctx.fillText(line, originX, originY);

    // Per-character advances, converted to GRID space (cells, not pixels), so
    // the renderer can place a caret without knowing anything about fonts.
    const advances: number[] = [];
    for (let k = 0; k <= line.length; k++) {
      const w = ctx.measureText(line.slice(0, k)).width;
      advances.push((originX + w - padPx) / SS);
    }
    lastTextLayout.lines.push({
      text: line,
      advances,
      top: (originY - capPx - padPx) / SS,
      bottom: (originY + descentPx - padPx) / SS,
    });
  }

  const img = ctx.getImageData(0, 0, rw, rh).data;
  const cells: boolean[][] = [];
  let inkCount = 0;
  for (let row = 0; row < gridHeight; row++) {
    const rowCells: boolean[] = new Array(gridWidth);
    for (let col = 0; col < gridWidth; col++) {
      const x0 = padPx + col * SS;
      const y0 = padPx + row * SS;
      let sum = 0;
      for (let sy = 0; sy < SS; sy++) {
        const rowOff = (y0 + sy) * rw;
        for (let sx = 0; sx < SS; sx++) sum += img[(rowOff + x0 + sx) * 4 + 3];
      }
      const on = sum / (SS * SS * 255) >= 0.5;
      rowCells[col] = on;
      if (on) inkCount++;
    }
    cells.push(rowCells);
  }
  if (inkCount === 0) return null;
  return { cells, width: gridWidth, height: gridHeight, inkCount };
}

/** Cache — rasterizing is ~10ms and the inputs change rarely. */
const cache = new Map<string, GlyphMask | null>();

export function getGlyphMask(opts: RasterizeOptions): GlyphMask | null {
  // `fillX` is part of the key: it changes the rasterized output, so omitting it
  // would serve a stale mask after a change to the horizontal budget.
  //
  // The fallbacks here MUST match `rasterizeGlyph`'s own defaults, or the key
  // lies about what it is keying. This read `?? 1.0` while the rasterizer
  // defaults to 0.99, so an omitted `fillX` rasterized at 0.99 and was filed
  // under the key for 1.0 — an explicit `fillX: 1.0` request then hit that
  // entry and got the 0.99 raster, which is exactly the staleness the comment
  // above claims to prevent. Inert at the shipping 44x48 geometry (measured:
  // all 26 letters produce identical ink at both values), so this moves no
  // pixels today; it stops the collision at any other grid size or fill budget.
  const key = `${opts.char}|${opts.fontFamily}|${opts.fontWeight ?? 400}|${opts.gridWidth}x${opts.gridHeight}|${opts.fill ?? 0.94}|${opts.fillX ?? 0.99}`;
  if (cache.has(key)) return cache.get(key)!;
  const mask = rasterizeGlyph(opts);
  cache.set(key, mask);
  return mask;
}

/**
 * Cached text rasterization — the frame loop calls this every frame.
 *
 * Same cache and the same `clearMaskCache`, so a font swap still invalidates
 * both paths together. The key carries a `text:` prefix so a one-character
 * string cannot collide with the single-glyph entry for that same character:
 * they are rendered by different code with different descender budgets, and
 * serving one for the other would be a silent size change.
 */
const layoutCache = new Map<string, TextLayout>();

export function getTextMask(opts: RasterizeTextOptions): GlyphMask | null {
  const key = `text:${opts.text}|${opts.fontFamily}|${opts.fontWeight ?? 400}|` +
    `${opts.gridWidth}x${opts.gridHeight}|${opts.fill ?? 0.94}|${opts.fillX ?? 0.99}`;
  if (cache.has(key)) {
    /*
      Restore the LAYOUT along with the mask.

      A cache hit skips `rasterizeText`, so `lastTextLayout` would still
      describe whatever was rasterized last — and the caret would be drawn
      against the wrong text. The mask and its layout are produced together and
      have to be cached together.
    */
    const cachedLayout = layoutCache.get(key);
    if (cachedLayout) lastTextLayout = cachedLayout;
    return cache.get(key)!;
  }
  const mask = rasterizeText(opts);
  cache.set(key, mask);
  layoutCache.set(key, lastTextLayout);
  return mask;
}

export function clearMaskCache(): void { cache.clear(); layoutCache.clear(); }
