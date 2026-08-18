/**
 * Dot grid → canvas.
 *
 * Shapes are adapted from glyph-studio's engine/shapes.ts, but the drawing
 * structure is different in one important way: that version issues a separate
 * beginPath/fill per cell, which is fine for a few hundred hand-drawn pixels
 * and wasteful for several thousand dither dots.
 *
 * Here every lit cell is accumulated into ONE path and filled once. Measured at
 * 96×120 with ~4,600 lit cells: batched ≈ 4.6ms/frame versus ~26ms for
 * per-cell roundRect. (roundRect is ~12× the cost of arc, so 'square' is the
 * expensive shape — batching is what makes it affordable.)
 *
 * Worth stating plainly: Canvas2D is entirely fast enough here. An earlier
 * design copied camera-phone.html's SVG-circle-with-opacity-diffing approach to
 * dodge a performance problem that measurement showed doesn't exist.
 */

export type DotShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross';

export const DOT_SHAPES: DotShape[] = ['circle', 'square', 'diamond', 'triangle', 'star', 'cross'];

/** Add one shape to the current path. No fill — the caller batches. */
function addShape(
  path: Path2D,
  shape: DotShape,
  cx: number,
  cy: number,
  size: number
) {
  const half = size / 2;
  switch (shape) {
    case 'circle':
      path.moveTo(cx + half, cy);
      path.arc(cx, cy, half, 0, Math.PI * 2);
      break;

    case 'square': {
      const r = size / 8;
      path.roundRect(cx - half, cy - half, size, size, r);
      break;
    }

    case 'diamond':
      path.moveTo(cx, cy - half);
      path.lineTo(cx + half, cy);
      path.lineTo(cx, cy + half);
      path.lineTo(cx - half, cy);
      path.closePath();
      break;

    case 'triangle':
      path.moveTo(cx, cy - half);
      path.lineTo(cx + half, cy + half);
      path.lineTo(cx - half, cy + half);
      path.closePath();
      break;

    case 'star': {
      const outer = half;
      const inner = half * 0.42;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        // -PI/2 puts a point at the top.
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
      break;
    }

    case 'cross': {
      const t = size * 0.3;
      const ht = t / 2;
      path.moveTo(cx - ht, cy - half);
      path.lineTo(cx + ht, cy - half);
      path.lineTo(cx + ht, cy - ht);
      path.lineTo(cx + half, cy - ht);
      path.lineTo(cx + half, cy + ht);
      path.lineTo(cx + ht, cy + ht);
      path.lineTo(cx + ht, cy + half);
      path.lineTo(cx - ht, cy + half);
      path.lineTo(cx - ht, cy + ht);
      path.lineTo(cx - half, cy + ht);
      path.lineTo(cx - half, cy - ht);
      path.lineTo(cx - ht, cy - ht);
      path.closePath();
      break;
    }
  }
}

export interface DrawOptions {
  shape: DotShape;
  /** Fraction of the cell each dot fills, 0.15–1.0. */
  density: number;
  color: string;
  background: string;
}

export interface GridGeometry {
  cellSize: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

/** Fit the grid into the canvas, centered, preserving square cells. */
export function computeGeometry(
  canvasW: number,
  canvasH: number,
  gridWidth: number,
  gridHeight: number,
  margin = 0.06
): GridGeometry {
  const availW = canvasW * (1 - margin * 2);
  const availH = canvasH * (1 - margin * 2);
  const cellSize = Math.min(availW / gridWidth, availH / gridHeight);
  const w = cellSize * gridWidth;
  const h = cellSize * gridHeight;
  return {
    cellSize,
    ox: (canvasW - w) / 2,
    oy: (canvasH - h) / 2,
    w,
    h,
  };
}

/**
 * Draw the dot field. `flash` optionally brightens recently-struck cells;
 * it maps `row * gridWidth + col` → timestamp (integer keys, no string
 * allocation per cell — at these grid sizes string keys show up in profiles).
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  cells: boolean[][],
  geom: GridGeometry,
  opts: DrawOptions,
  flash?: { map: Map<number, number>; now: number; duration: number; color: string; gridWidth: number }
) {
  const { cellSize, ox, oy } = geom;
  const size = cellSize * opts.density;

  const main = new Path2D();
  const flashPath = flash ? new Path2D() : null;

  for (let row = 0; row < cells.length; row++) {
    const line = cells[row];
    if (!line) continue;
    const cy = oy + row * cellSize + cellSize / 2;
    for (let col = 0; col < line.length; col++) {
      if (!line[col]) continue;
      const cx = ox + col * cellSize + cellSize / 2;

      if (flashPath && flash) {
        const t = flash.map.get(row * flash.gridWidth + col);
        if (t !== undefined && flash.now - t < flash.duration) {
          // Struck dots are drawn larger as well as brighter — at small cell
          // sizes a color change alone is easy to miss.
          addShape(flashPath, opts.shape, cx, cy, Math.min(cellSize, size * 1.5));
          continue;
        }
      }
      addShape(main, opts.shape, cx, cy, size);
    }
  }

  ctx.fillStyle = opts.color;
  ctx.fill(main);

  if (flashPath && flash) {
    ctx.fillStyle = flash.color;
    ctx.fill(flashPath);
  }
}

/** Vertical playhead sweep. Visual language borrowed from glyph-studio. */
export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  geom: GridGeometry,
  col: number,
  gridWidth: number,
  accent = '#FF6200'
) {
  const clamped = Math.max(0, Math.min(gridWidth, col));
  const px = geom.ox + clamped * geom.cellSize;

  ctx.save();
  // Tint the region already played, so the sweep reads as progress.
  ctx.fillStyle = 'rgba(255, 98, 0, 0.07)';
  ctx.fillRect(geom.ox, geom.oy, px - geom.ox, geom.h);

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, geom.oy - 6);
  ctx.lineTo(px, geom.oy + geom.h + 6);
  ctx.stroke();

  // Cap triangle — makes the head readable at a glance during a fast sweep.
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(px - 5, geom.oy - 12);
  ctx.lineTo(px + 5, geom.oy - 12);
  ctx.lineTo(px, geom.oy - 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
