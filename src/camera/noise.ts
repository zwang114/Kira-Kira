/**
 * Threshold matrices for ordered dithering.
 *
 * Two modes, both screen-space locked (indexed by absolute cell position, not
 * by anything that moves) so the pattern stays temporally stable — the dots
 * don't crawl when the camera moves. That stability is what lets the letterform
 * read as a fixed object with a living interior rather than boiling video.
 *
 * BAYER — the classic 8×8 ordered dither, ported from camera-phone.html.
 *   Lowest reconstruction error (measured RMSE 0.081) but strongly periodic
 *   (autocorrelation 0.87 at lag 2,2). At flat mid-gray it collapses to a rigid
 *   checkerboard, which competes with the letterform for attention.
 *
 * BLUE — void-and-cluster blue noise, 64×64.
 *   Higher reconstruction error (RMSE 0.128) but essentially aperiodic
 *   (autocorrelation -0.01). Reads as organic texture instead of a lattice.
 *   Default, because here the dot field IS the subject: we care more about it
 *   looking like captured world than about tonal accuracy.
 *
 * Floyd–Steinberg error diffusion is deliberately absent. It gives the best
 * detail on a still image but is temporally unstable — measured 45–97 cells
 * flipping per frame on a STATIC scene with normal sensor noise, versus 0–1 for
 * these two. It would boil constantly.
 */

export type DitherMode = 'blue' | 'bayer';

/** 8×8 Bayer matrix, values 0..63. */
const BAYER8 = new Uint8Array([
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]);

const BLUE_SIZE = 64;

/**
 * Void-and-cluster blue noise (Ulichney).
 *
 * Builds a threshold matrix by repeatedly finding the tightest cluster of ones
 * and the largest void of zeros, using a gaussian-weighted wraparound energy
 * field. Ranking every cell by the order it gets placed yields a matrix whose
 * thresholds are spatially well-distributed at every level — which is exactly
 * the property that makes the resulting dot pattern look even but unstructured.
 *
 * Generated once at module load (~30ms for 64×64) rather than shipped as a data
 * blob, so the size stays tunable.
 */
function generateBlueNoise(size: number): Float32Array {
  const N = size * size;
  const binary = new Uint8Array(N);
  const energy = new Float32Array(N);

  // Gaussian energy kernel. sigma=1.5 is Ulichney's recommendation; the radius
  // of 4 sigma captures effectively all of the weight.
  const SIGMA = 1.5;
  const RADIUS = 6;
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (dx === 0 && dy === 0) continue;
      kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA)) });
    }
  }

  // Splat a point's energy contribution across the field, wrapping at edges so
  // the matrix tiles seamlessly.
  const splat = (idx: number, sign: number) => {
    const cy = (idx / size) | 0;
    const cx = idx % size;
    for (const k of kernel) {
      const y = (cy + k.dy + size) % size;
      const x = (cx + k.dx + size) % size;
      energy[y * size + x] += sign * k.w;
    }
  };

  const tightestCluster = (): number => {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < N; i++) {
      if (binary[i] === 1 && energy[i] > bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  };
  const largestVoid = (): number => {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < N; i++) {
      if (binary[i] === 0 && energy[i] < bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  };

  // Deterministic PRNG so the pattern is identical every run — a changing
  // texture between reloads would be a confusing thing to debug against.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 0xffffffff;
  };

  // Phase 0: scatter an initial ~10% of points at random.
  const initialCount = Math.max(1, Math.floor(N * 0.1));
  let placed = 0;
  while (placed < initialCount) {
    const i = Math.floor(rand() * N);
    if (binary[i] === 0) { binary[i] = 1; splat(i, 1); placed++; }
  }

  // Phase 1: relax — repeatedly move the tightest cluster into the largest void
  // until doing so is a no-op. This spreads the initial random points evenly.
  for (;;) {
    const c = tightestCluster();
    binary[c] = 0; splat(c, -1);
    const v = largestVoid();
    if (v === c) { binary[c] = 1; splat(c, 1); break; }
    binary[v] = 1; splat(v, 1);
  }

  const rank = new Int32Array(N).fill(-1);
  // Snapshot the relaxed prototype — phases 2 and 3 both start from it.
  const proto = binary.slice();
  const protoEnergy = energy.slice();

  // Phase 2: remove points one at a time, tightest cluster first. These get the
  // LOWEST ranks, counting down from initialCount-1.
  let r = placed - 1;
  while (r >= 0) {
    const c = tightestCluster();
    binary[c] = 0; splat(c, -1);
    rank[c] = r--;
  }

  // Phase 3: restore the prototype, then ADD points into the largest void
  // repeatedly. These get the ranks above initialCount.
  binary.set(proto);
  energy.set(protoEnergy);
  for (r = placed; r < N; r++) {
    const v = largestVoid();
    binary[v] = 1; splat(v, 1);
    rank[v] = r;
  }

  // Normalize ranks to thresholds in [0,1).
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = rank[i] / N;
  return out;
}

let blueNoise: Float32Array | null = null;
function getBlueNoise(): Float32Array {
  if (!blueNoise) blueNoise = generateBlueNoise(BLUE_SIZE);
  return blueNoise;
}

/**
 * Threshold for cell (x, y) in the chosen mode, normalized to [0,1).
 * Screen-space indexed — deliberately NOT offset by time or camera motion.
 */
export function threshold(x: number, y: number, mode: DitherMode): number {
  if (mode === 'bayer') {
    // +0.5 centers each level within its bucket so pure black/white still
    // resolve correctly at the extremes.
    return (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
  }
  const bn = getBlueNoise();
  return bn[(y % BLUE_SIZE) * BLUE_SIZE + (x % BLUE_SIZE)];
}

/** Warm the blue-noise cache off the critical path. */
export function precomputeNoise(): void { getBlueNoise(); }
