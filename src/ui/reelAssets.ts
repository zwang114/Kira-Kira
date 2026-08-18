/**
 * Reel geometry, downloaded from Figma nodes 23:783 (Default) and 23:1312
 * (Variant2) — not redrawn.
 *
 * `reelDisc` is the 334px face with the four spoke wells cut out as a single
 * path (Figma calls it 'Subtract'). The wells taper from 88px at the rim to
 * 62px at the hub with rounded corners — a film-reel spoke, which is not
 * something a clip-path polygon can approximate. Both variants ship the SAME
 * path data, so one asset serves both faces.
 *
 * `fill-rule="evenodd"` is REQUIRED. The path is one outer circle followed by
 * four well subpaths; under evenodd the wells punch through, but under SVG's
 * default `nonzero` they only cut if they wind opposite to the circle. Figma's
 * own export carries the attribute — dropping it is how the wells stop being
 * holes.
 *
 * `reelHub` is the 62px spindle: a black disc with a cross-shaped cutout.
 * `reelInner` is the 138px hairline ring (Ellipse 3) centred on the face.
 * `fill="none"` is REQUIRED, not decorative: SVG's default fill is BLACK, and
 * Figma's Ellipse 3 has `fills: []` — stroke only. Without it the ring paints
 * a solid 138px black disc that swallows the inner ends of all four spoke
 * wells and reads as one giant hub. The bug was invisible while the element
 * had no CSS (it inherited a 334px box and was clipped); giving it correct
 * geometry is what exposed it.
 *
 * The two swatch glyphs belong to the Default face only — Variant2 slots carry
 * text and nothing else:
 *   `swatchCircle` — Ellipse 6, 16px, the SELECTED marker beside CL.
 *   `swatchCross`  — Union, 18px, the four-pointed star beside STR.
 * The DM and SQ swatches are a plain 14px rounded-[2px] square, drawn in CSS
 * rather than SVG because that is exactly what the design does.
 */

export const REEL_ASSETS = {
  "reelDisc": {
    "w": 334.0,
    "h": 334.0,
    "vb": "0 0 334 334",
    "body": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M167 0C259.232 0 334 74.7684 334 167C334 259.232 259.232 334 167 334C74.7684 334 0 259.232 0 167C0 74.7684 74.7684 0 167 0ZM159.285 220C152.489 220 149.091 220 146.814 222.032C144.538 224.065 144.154 227.441 143.387 234.193L137.023 290.193C136.079 298.502 135.608 302.656 137.993 305.328C140.379 308 144.56 308 152.921 308H181.079C189.44 308 193.621 308 196.007 305.328C198.392 302.656 197.921 298.502 196.977 290.193L190.613 234.193C189.846 227.441 189.462 224.065 187.186 222.032C184.909 220 181.511 220 174.715 220H159.285ZM43.8066 137.023C35.4984 136.079 31.3439 135.608 28.6719 137.993C26.0001 140.379 26 144.56 26 152.921V181.079C26 189.44 26.0001 193.621 28.6719 196.007C31.3439 198.392 35.4984 197.921 43.8066 196.977L99.8066 190.613C106.559 189.846 109.935 189.462 111.968 187.186C114 184.909 114 181.511 114 174.715V159.285C114 152.489 114 149.091 111.968 146.814C109.935 144.538 106.559 144.154 99.8066 143.387L43.8066 137.023ZM305.328 137.993C302.656 135.608 298.502 136.079 290.193 137.023L234.193 143.387C227.441 144.154 224.065 144.538 222.032 146.814C220 149.091 220 152.489 220 159.285V174.715C220 181.511 220 184.909 222.032 187.186C224.065 189.462 227.441 189.846 234.193 190.613L290.193 196.977C298.502 197.921 302.656 198.392 305.328 196.007C308 193.621 308 189.44 308 181.079V152.921C308 144.56 308 140.379 305.328 137.993ZM152.921 26C144.56 26 140.379 26.0001 137.993 28.6719C135.608 31.3439 136.079 35.4984 137.023 43.8066L143.387 99.8066C144.154 106.559 144.538 109.935 146.814 111.968C149.091 114 152.489 114 159.285 114H174.715C181.511 114 184.909 114 187.186 111.968C189.462 109.935 189.846 106.559 190.613 99.8066L196.977 43.8066C197.921 35.4984 198.392 31.3439 196.007 28.6719C193.621 26.0001 189.44 26 181.079 26H152.921Z\" fill=\"#8A8377\"/>"
  },
  "reelHub": {
    "w": 62.0,
    "h": 62.0,
    "vb": "0 0 62 62",
    "body": "<g>\n<rect width=\"62\" height=\"62\" rx=\"31\" fill=\"black\"/>\n<path d=\"M34 19C34.5523 19 35 19.4477 35 20C35 23.866 38.134 27 42 27C42.5523 27 43 27.4477 43 28V34C43 34.5523 42.5523 35 42 35C38.134 35 35 38.134 35 42C35 42.5523 34.5523 43 34 43H28C27.4477 43 27 42.5523 27 42C27 38.134 23.866 35 20 35C19.4477 35 19 34.5523 19 34V28C19 27.4477 19.4477 27 20 27C23.866 27 27 23.866 27 20C27 19.4477 27.4477 19 28 19H34Z\" fill=\"#8A8377\"/>\n<path d=\"M51.5075 10.4905L49.3862 12.6118\" stroke=\"#8A8377\" stroke-linecap=\"round\"/>\n<path d=\"M12.6167 49.3813L10.4953 51.5026\" stroke=\"#8A8377\" stroke-linecap=\"round\"/>\n<path d=\"M51.5145 51.5026L49.3932 49.3812\" stroke=\"#8A8377\" stroke-linecap=\"round\"/>\n<path d=\"M12.6236 12.6117L10.5023 10.4904\" stroke=\"#8A8377\" stroke-linecap=\"round\"/>\n</g>"
  },
  /** Ellipse 3 — the 138px hairline ring inside the hub. */
  "reelInner": {
    "w": 138.0,
    "h": 138.0,
    "vb": "0 0 138 138",
    "body": "<circle cx=\"69\" cy=\"69\" r=\"68.5\" fill=\"none\" stroke=\"#5B544B\"/>"
  },
  /** Ellipse 6 — 16px filled dot, the Default face's selected marker. */
  "swatchCircle": {
    "w": 16.0,
    "h": 16.0,
    "vb": "0 0 16 16",
    "body": "<circle cx=\"8\" cy=\"8\" r=\"8\" fill=\"currentColor\"/>"
  },
  /**
   * Rectangle 5 (node 82:592) — 16px rounded diamond, the DM glyph.
   *
   * The user rotated this in Figma after an audit found DM and SQ drawn as the
   * SAME 14px rounded square. It is now a VECTOR, not a RECTANGLE: a square
   * turned 45° with its corners softened by the same radius, so it reads as a
   * diamond rather than a tilted box. Downloaded verbatim; do not redraw it as
   * a CSS `rotate(45deg)` square — that loses the corner treatment.
   */
  "swatchDiamond": {
    "w": 16.0,
    "h": 16.0,
    "vb": "0 0 16 16",
    "body": "<path d=\"M6.75277 0.516619C7.4416 -0.172207 8.5584 -0.172206 9.24723 0.51662L15.4834 6.75277C16.1722 7.4416 16.1722 8.5584 15.4834 9.24723L9.24723 15.4834C8.5584 16.1722 7.4416 16.1722 6.75277 15.4834L0.516619 9.24723C-0.172207 8.5584 -0.172206 7.4416 0.51662 6.75277L6.75277 0.516619Z\" fill=\"currentColor\"/>"
  },
  /** Union — 18px four-pointed star, the STR glyph. */
  "swatchCross": {
    "w": 18.0,
    "h": 18.0,
    "vb": "0 0 18 18",
    "body": "<path d=\"M10.125 0C10.7463 4.07382e-08 11.25 0.50368 11.25 1.125V2.25C11.25 4.73528 13.2647 6.75 15.75 6.75H16.875C17.4963 6.75 18 7.25368 18 7.875V10.125C18 10.7463 17.4963 11.25 16.875 11.25H15.75C13.2647 11.25 11.25 13.2647 11.25 15.75V16.875C11.25 17.4963 10.7463 18 10.125 18H7.875C7.25368 18 6.75 17.4963 6.75 16.875V15.75C6.75 13.2647 4.73528 11.25 2.25 11.25H1.125C0.50368 11.25 0 10.7463 0 10.125V7.875C0 7.25368 0.50368 6.75 1.125 6.75H2.25C4.73528 6.75 6.75 4.73528 6.75 2.25V1.125C6.75 0.50368 7.25368 2.49179e-07 7.875 0H10.125Z\" fill=\"currentColor\"/>"
  }
} as const;
