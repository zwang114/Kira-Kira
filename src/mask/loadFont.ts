/**
 * User font loading and validation.
 *
 * NOTE ON DEPENDENCIES — the plan called for fontkit here, on the reasoning
 * that opentype.js 2.x fails on TTC collections. Measured in Chrome, the
 * browser's own FontFace API handles every case this app needs:
 *
 *   TTC  → loads (Futura.ttc, 487KB, renders correctly)
 *   TTF  → loads
 *   OTF/CFF → loads
 *   corrupt bytes → throws a catchable SyntaxError, not a silent failure
 *
 * A font parser would only be needed to read metrics from font tables — but
 * the rasterizer already derives cap height and descent by measuring rendered
 * ink, which is more reliable anyway (declared metrics frequently disagree with
 * where the ink actually sits). So no parser: 300KB of dependency avoided.
 *
 * The failure this DOES have to catch is the quiet one. A font can load
 * successfully and still render nothing usable:
 *   - OTS (the browser's font sanitizer) may neuter a font that still "loads"
 *   - color fonts (sbix/COLR, e.g. Apple Color Emoji) paint BITMAPS via
 *     fillText, so thresholding their alpha yields a garbage mask
 *   - a font may simply lack the glyph you asked for, silently substituting
 * Hence the ink + fingerprint validation below: render with the font, render
 * with a known-different fallback, and require both ink and a difference.
 */

export interface LoadedFont {
  /** CSS family name — unique per load, so re-loading a file can't collide. */
  family: string;
  fileName: string;
  byteLength: number;
}

export class FontLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontLoadError';
  }
}

let loadCounter = 0;

/** Ink signature of a string rendered in a given CSS font shorthand. */
function inkSignature(fontShorthand: string, sample: string): { ink: number; hash: number } {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.clearRect(0, 0, 160, 160);
  x.fillStyle = '#fff';
  x.font = fontShorthand;
  x.textBaseline = 'alphabetic';
  x.fillText(sample, 8, 120);
  const d = x.getImageData(0, 0, 160, 160).data;
  let ink = 0;
  let hash = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) {
      ink++;
      // Position-sensitive hash — two different letterforms with the same ink
      // count still produce different hashes.
      hash = Math.imul(hash ^ i, 16777619) >>> 0;
    }
  }
  return { ink, hash };
}

/**
 * Detect a color font by checking whether the rendered glyph has COLOR.
 * Color fonts paint bitmaps, so their output has saturated pixels even when the
 * fill style is pure white — a grayscale outline font cannot do that.
 */
export function isColorGlyph(family: string, char: string): boolean {
  const c = document.createElement('canvas');
  c.width = 100;
  c.height = 100;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.clearRect(0, 0, 100, 100);
  x.fillStyle = '#ffffff';
  x.font = `64px "${family}"`;
  x.textBaseline = 'alphabetic';
  x.fillText(char, 8, 80);
  const d = x.getImageData(0, 0, 100, 100).data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 32) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Measured margin is enormous: a color bitmap glyph scores 255 here, an
    // outline glyph filled with #fff scores exactly 0. 24 is safely between.
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) return true;
  }
  return false;
}

/**
 * Load a font file and register it. Throws FontLoadError with a message fit for
 * display if the font is unusable.
 */
export async function loadFontFile(file: File): Promise<LoadedFont> {
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new FontLoadError('That file is empty.');

  const family = `UserFont${++loadCounter}`;

  let face: FontFace;
  try {
    face = new FontFace(family, buf);
    await face.load();
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'SyntaxError') {
      throw new FontLoadError(
        `“${file.name}” isn’t a font the browser can read. OTF, TTF, TTC, WOFF and WOFF2 work.`
      );
    }
    throw new FontLoadError(`Could not load “${file.name}”: ${(err as Error)?.message ?? name}`);
  }

  document.fonts.add(face);

  // Validate: it must produce ink, and that ink must differ from the fallback.
  // A font that OTS has neutered will "load" and then render as the fallback.
  const mine = inkSignature(`80px "${family}"`, 'AHgn');
  const fallback = inkSignature('80px monospace', 'AHgn');

  if (mine.ink === 0) {
    document.fonts.delete(face);
    throw new FontLoadError(`“${file.name}” loaded but renders nothing.`);
  }
  if (mine.hash === fallback.hash) {
    document.fonts.delete(face);
    throw new FontLoadError(
      `“${file.name}” loaded but the browser is substituting a fallback face.`
    );
  }
  // Probe several representative glyphs — a font can be monochrome for Latin
  // and color elsewhere, so a single probe character is not conclusive.
  if (['A', 'g', '0'].some((ch) => isColorGlyph(family, ch))) {
    document.fonts.delete(face);
    throw new FontLoadError(
      `“${file.name}” is a color font. Its glyphs are bitmaps, which can’t be used as a mask.`
    );
  }

  return { family, fileName: file.name, byteLength: buf.byteLength };
}

/**
 * Does this font actually contain the requested character?
 * Browsers silently substitute a fallback for missing glyphs, so a mask can
 * come out looking right while being the wrong typeface entirely.
 */
export function hasGlyph(family: string, char: string): boolean {
  if (!char) return false;
  const mine = inkSignature(`80px "${family}"`, char);
  if (mine.ink === 0) return false;
  // Compare against the same character in two unrelated fallbacks. Matching
  // either strongly suggests substitution rather than a real glyph.
  const f1 = inkSignature('80px monospace', char);
  const f2 = inkSignature('80px serif', char);
  return mine.hash !== f1.hash && mine.hash !== f2.hash;
}
