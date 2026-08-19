/**
 * The pipeline, headless.
 *
 * Everything between the camera and the dot field: mask rasterization, the
 * dither, the shutter, and playback control. NO DOM — no canvas, no elements,
 * no event listeners. The only browser objects it touches are the ones the
 * pipeline is made of (a `<video>` owned by camera.ts, an offscreen scratch
 * canvas owned by dither.ts, and the AudioContext owned by engine.ts).
 *
 * That constraint is the point. `main.ts` previously interleaved pipeline state
 * with the widget that displayed it, so the v2 UI could not be attached without
 * reimplementing the pipeline behind it. A UI drives this module by calling
 * methods and reading `onFrame` / `onPlayhead`; it never reaches into the
 * pipeline's state, and this module never assumes which UI is attached.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT OWN:
 *   - letterboxing / pixel geometry. It emits grid-space data (a `Field` and a
 *     COLUMN INDEX) and lets the renderer place it. See `onPlayhead` below —
 *     this is the whole reason the playhead cannot land in the wrong place.
 *   - the voice model. It does not decide what a square sounds like. It holds
 *     the assignment map the Sound Config overlay produces and hands it to the
 *     engine; which synthesis a profile id resolves to is `engine.ts`'s call.
 */

import { getTextMask, clearMaskCache, MAX_CHARS } from './mask/rasterizeGlyph';
import { ditherFrame, resetExposure, UNLIT } from './camera/dither';
import { precomputeNoise, type DitherMode } from './camera/noise';
import {
  startCamera, describeCameraError,
  type CameraHandle, type Facing,
} from './camera/camera';
import type { Field, Shape } from './ui/field';
import type { DotShape } from './render/drawGrid';
import * as audio from './audio/engine';
import type { VoiceAssignments } from './audio/engine';

export type Phase = 'aiming' | 'frozen';

export interface SessionParams {
  char: string;
  fontFamily: string;
  fontWeight: number;
  /** Grid width; height derives from the 4:5 stage aspect. */
  gridWidth: number;
  mode: DitherMode;
  shape: DotShape;
  density: number;
  exposure: number;
  contrast: number;
  autoLevel: number;
  invert: boolean;
  /**
   * Whether the letterform gates the dither.
   *
   * OFF (the default) shows the raw dithered environment across the whole
   * grid — a plain camera view in dots. ON restricts lit cells to the inside
   * of the letter, which is the product's central idea.
   *
   * INVALIDATING: it changes which cells are lit, so a frozen capture cannot
   * survive it. Captures can be taken in either mode; the toggle is simply
   * disabled while one is frozen.
   */
  masked: boolean;
  sweepSeconds: number;
  loop: boolean;
}

/**
 * A captured letter: the dot field plus the settings that produced it.
 *
 * Holds BOTH representations, and that duplication is deliberate:
 *   - `cells`   the boolean grid, which is what the audio scheduler consumes.
 *   - `field`   the shape-index grid, which is what the renderer consumes.
 * They are co-indexed by construction (see dither.ts:141). Deriving one from
 * the other at use time would be the exact type-bridge guesswork the migration
 * plan warned against, so both are frozen together at shutter time.
 */
export interface Capture {
  cells: boolean[][];
  field: Field;
  char: string;
  shape: DotShape;
  density: number;
  litCount: number;
}

export interface SessionEvents {
  /**
   * A field is ready to paint. Fires for live frames AND for the mask preview,
   * so a UI has exactly one paint path rather than one per phase.
   *
   * `playhead` is a COLUMN INDEX in grid space (-1 for none), never a pixel.
   * This is the single most important line in the file: the renderer computes
   * its own letterbox from its own backing store, so handing it a column and
   * letting it place the rule is what makes the playhead correct BY
   * CONSTRUCTION. Emitting a pixel x here would require this module to know the
   * canvas's size and letterbox, and any disagreement would land the rule in
   * the wrong column silently.
   */
  onFrame?: (field: Field, playhead: number) => void;
  onPhase?: (phase: Phase) => void;
  /** Camera granted / stopped / failed. `false` means "not aiming yet". */
  onLive?: (live: boolean) => void;
  onStatus?: (msg: string, isError?: boolean) => void;
  /** Playback position, 0..1 across the sweep, for the dial. */
  onProgress?: (t: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
}

/** Grid is 4:5 — portrait, close to a letter's proportions. */
/**
 * Grid is 11:10 — very slightly taller than wide.
 *
 * It was 4:5 (1.25), chosen as "close to a letter's proportions". That ratio
 * was the reason W rendered shorter than every other capital: the alphabet
 * shares one scale, the scale is set by whichever glyph hits an edge first,
 * and in a tall narrow grid that is always the WIDEST letter. W filled the
 * width and had height left over, so it came out 41 rows against V's 47 —
 * visibly, obviously short, in a set that is supposed to look uniform.
 *
 * Widening the grid stops W binding on width. Measured across A-Z at gw=44:
 *
 *   ratio  gh   W    V    H    spread   clipping
 *   1.25   55   41   47   47     12       none     <- was
 *   1.20   53   41   45   45     10       none
 *   1.15   51   41   43   43      8       none
 *   1.10   48   41   41   41      5       none     <- now
 *   1.05   46   39   39   39      5       none
 *
 * At 1.10, W, V, H and M are all exactly 41 rows — W stops being the outlier
 * completely, and the residual spread of 5 is just round capitals (O, S, Q)
 * carrying their normal overshoot, which is correct typography rather than a
 * scaling artifact.
 *
 * This does NOT touch the per-glyph scale: every letter still shares one font
 * size and one baseline, so the alphabet still reads as one typeface. It only
 * stops the grid from starving the widest letter.
 */
export const gridHeightFor = (w: number) => Math.round(w * 1.10);

const DEFAULTS: SessionParams = {
  /*
    The mask text. Up to MAX_CHARS characters, wrapped across up to 3 lines.
    Newlines are explicit breaks; everything else wraps on its own.
  */
  char: 'KIRA\nKIRA',
  /*
    A BUNDLED condensed face — see the `@font-face` note in `tokens.css`.

    This was `HelveticaNeue-CondensedBold`, which exists on macOS and NOT on
    iOS. On a phone it fell silently through to Helvetica Neue Regular and W
    dropped from 41 rows to 33 with the spread widening from 5 to 12 — the
    exact letter-sizing regression the condensed face was chosen to fix, back
    again and invisible.

    Oswald ships in `public/fonts/` (SIL OFL). Measured on the real 44x48 grid
    it matches the old macOS face: W = M = H = 41, spread 5. The difference is
    that it is now the same on every device.

    Weight 500: Oswald's 400 is slightly light for a mask that gets thresholded
    at 50% coverage, and 600+ starts closing the counters in B, R and 8.
  */
  fontFamily: '"Impression Mask", "Helvetica Neue", Helvetica, Arial, sans-serif',
  fontWeight: 500,
  gridWidth: 44,
  mode: 'blue',
  shape: 'circle',
  density: 0.62,
  exposure: 0,
  contrast: 0.3,
  // Partial by default: enough to rescue a flat indoor feed, not so much that
  // aiming at a bright vs. dark subject stops changing the dot density.
  autoLevel: 0.55,
  invert: false,
  // OFF on load, by design: the app opens as a plain dithered camera view and
  // the letterform is an explicit choice.
  masked: false,
  sweepSeconds: 3,
  loop: false,
};

/**
 * 1x on the large dial. Verified at 3.00s across every resolution
 * (`HANDOFF.md` §8), so the multipliers are 3 / 1.5 / 1 second.
 */
const BASE_SWEEP_SECONDS = 3;

/** Where the per-shape voice assignments persist between sessions. */
const ASSIGNMENTS_KEY = 'impression.voiceAssignments.v1';

export class Session {
  readonly params: SessionParams;
  private ev: SessionEvents;

  private camera: CameraHandle | null = null;
  private rafId: number | null = null;
  private _phase: Phase = 'aiming';
  private _live = false;

  private capture: Capture | null = null;
  /** Most recent live frame, so the shutter has something to freeze. */
  private lastCells: boolean[][] | null = null;
  private lastShapes: Int8Array | null = null;
  private lastLit = 0;

  private playheadCol = -1;
  /** Sub-cell playhead position for the RENDERER only. See `onPlayhead`. */
  private playheadColF = -1;

  private _speed: 1 | 2 | 3 = 1;
  /** Guards `play()` against same-tick re-entry — see the comment there. */
  private starting = false;
  /**
   * Guards `flipCamera` against re-entry. A double tap would otherwise start
   * two `getUserMedia` acquisitions racing to assign `this.camera`, and the
   * loser would leak its stream.
   */
  private flipping = false;

  /**
   * Per-shape profile + level, owned here because it outlives the overlay.
   *
   * `SoundConfig` is constructed on open and destroyed on close, so it cannot
   * be the store — reopening it would otherwise show the design's defaults
   * rather than what the user last saved. The overlay is seeded FROM this on
   * open and writes back to it on save.
   */
  private assignments: VoiceAssignments = {
    ...audio.DEFAULT_ASSIGNMENTS,
  };

  // fps/cost diagnostics — cheap, and the only way to tell a throttled
  // environment from a slow pipeline.
  private frameCount = 0;
  private lastFpsAt = 0;

  constructor(events: SessionEvents = {}, params: Partial<SessionParams> = {}) {
    this.ev = events;
    this.params = { ...DEFAULTS, ...params };
    precomputeNoise();

    // Restore saved voice assignments over the defaults. Routed through
    // `setVoiceAssignments` rather than assigned directly, so stored data gets
    // the same id validation and level clamping as a live save — this is
    // user-editable storage and must not be trusted.
    const saved = Session.loadAssignments();
    if (saved) this.setVoiceAssignments(saved);
  }

  get phase(): Phase { return this._phase; }
  /** True once the camera stream is open. The old `idle` phase is `!live`. */
  get live(): boolean { return this._live; }

  get isPlaying(): boolean { return audio.isPlaying(); }
  get currentCapture(): Capture | null { return this.capture; }
  /**
   * Rows in the dot grid — 4:5 against the width.
   *
   * Deliberately NOT derived from the viewport. An earlier attempt matched the
   * grid to the frame's ~1:2 aspect so the dots would cover the same box as the
   * full-screen video: it aligned them, and it rasterized the letter into a
   * tall narrow grid that visibly squashed the letterform. The grid's shape
   * belongs to the letter, not to the window.
   */
  get gridHeight(): number { return gridHeightFor(this.params.gridWidth); }

  // ── Mask ─────────────────────────────────────────────────

  /**
   * An all-true mask — every cell passes, so the dither fills the whole grid.
   *
   * Used when `masked` is off: the stage shows the raw dithered environment
   * with no letterform. Cached and rebuilt only when the geometry changes,
   * because allocating a 44x48 boolean grid every frame would be pointless
   * garbage.
   */
  private openMaskCache: { cells: boolean[][]; w: number; h: number } | null = null;
  private openMask(w: number, h: number): boolean[][] {
    const c = this.openMaskCache;
    if (c && c.w === w && c.h === h) return c.cells;
    const cells: boolean[][] = [];
    for (let r = 0; r < h; r++) cells.push(new Array(w).fill(true));
    this.openMaskCache = { cells, w, h };
    return cells;
  }

  /**
   * An all-FALSE mask — no cell passes, so the stage renders empty.
   *
   * The counterpart to `openMask`, and cached for the same reason: it is
   * consulted every frame while the text is empty, and allocating a 44x48
   * boolean grid per frame would be pointless garbage.
   */
  private closedMaskCache: { cells: boolean[][]; w: number; h: number } | null = null;
  private closedMask(w: number, h: number): boolean[][] {
    const c = this.closedMaskCache;
    if (c && c.w === w && c.h === h) return c.cells;
    const cells: boolean[][] = [];
    for (let r = 0; r < h; r++) cells.push(new Array(w).fill(false));
    this.closedMaskCache = { cells, w, h };
    return cells;
  }

  private mask() {
    return getTextMask({
      text: this.params.char,
      fontFamily: this.params.fontFamily,
      fontWeight: this.params.fontWeight,
      gridWidth: this.params.gridWidth,
      gridHeight: this.gridHeight,
    });
  }

  /**
   * Emit the letterform alone, no camera — the pre-camera state.
   *
   * Every masked cell is given the LIGHTEST shape (index 3, cross) rather than a
   * mid shape: this is a placeholder showing where the letter will be, and the
   * v1 UI made the same point by drawing the preview at 20% opacity. The
   * renderer has no per-call colour parameter, so the tonal step carries it.
   */
  previewMask(): void {
    /*
      Nothing to preview when the stencil is off — there is no letterform, and
      the pre-camera state is simply an empty stage. Emitting an empty field
      rather than returning early so the renderer still clears whatever was
      there before (a letter left over from toggling the mask off, say).
    */
    const gw2 = this.params.gridWidth;
    const gh2 = this.gridHeight;
    if (!this.params.masked) {
      const gw = gw2;
      const gh = gh2;
      this.ev.onFrame?.(
        { cells: new Int8Array(gw * gh).fill(UNLIT), gridWidth: gw, gridHeight: gh }, -1);
      return;
    }
    const m = this.mask();
    /*
      Empty text pre-camera: emit an EMPTY field rather than returning.

      Returning left whatever was on the canvas — the previous letter — so
      deleting the text appeared to do nothing at all. Emitting clears it.
    */
    if (!m) {
      this.ev.onFrame?.(
        { cells: new Int8Array(gw2 * gh2).fill(UNLIT), gridWidth: gw2, gridHeight: gh2 }, -1);
      return;
    }
    const cells = new Int8Array(m.width * m.height).fill(UNLIT);
    for (let r = 0; r < m.height; r++) {
      for (let c = 0; c < m.width; c++) {
        if (m.cells[r]?.[c]) cells[r * m.width + c] = 3;
      }
    }
    this.ev.onFrame?.({ cells, gridWidth: m.width, gridHeight: m.height }, -1);
    const pct = ((m.inkCount / (m.width * m.height)) * 100).toFixed(0);
    this.ev.onStatus?.(`${m.width}×${m.height} · ${m.inkCount} cells (${pct}%)`);
  }

  // ── Camera ───────────────────────────────────────────────

  /**
   * Which camera is open. `environment` (rear) is the default — the product
   * photographs the world through a letterform, so the outward-facing lens is
   * the one that matches the premise.
   */
  private _facing: Facing = 'environment';
  get facing(): Facing { return this._facing; }

  /**
   * Switch between the front and rear cameras.
   *
   * Opens the NEW stream before stopping the old one, so a failure leaves the
   * user looking at a working viewfinder rather than a black stage. On iOS the
   * switch takes a moment and can fail outright if another app grabs the
   * device, which is exactly when a silent black screen would be worst.
   *
   * INVALIDATING in the same sense as the letter or the mask — it changes what
   * the camera sees, so it cannot apply to a frozen capture. The UI hides the
   * control in that phase (matching Figma 63:6429, where the captured state has
   * a single full-width button), so this is defence in depth rather than the
   * primary guard.
   */
  async flipCamera(): Promise<void> {
    if (!this.camera || this._phase !== 'aiming' || this.flipping) return;
    const want: Facing = this._facing === 'user' ? 'environment' : 'user';
    const old = this.camera;

    /*
      PAUSE THE FRAME LOOP FOR THE WHOLE FLIP.

      This is not an optimisation, it is the fix for a real bug: the loop kept
      running across the `await` below, and on iOS the old track is commonly
      released the moment a second `getUserMedia` is granted — a phone will not
      hold two cameras open at once. The loop then saw `isLive() === false` on
      the OLD handle, concluded the hardware had gone away, and ran
      `stopCameraStream()` — reporting "camera disconnected" and tearing down
      state that the resolving `startCamera` was about to write into. The new
      stream arrived to a dead session with no rAF running.

      `flipping` also guards re-entry: a double tap would otherwise start two
      acquisitions racing to assign `this.camera`, and whichever lost would
      leak its stream.
    */
    this.flipping = true;
    this.cancelLoop();

    try {
      const next = await startCamera(want);
      // Stop the old one only once the new one is in hand.
      old.stop();
      this.camera = next;
      this._facing = next.facing;
      // Cell indices now describe a different image; without this the whole
      // field reads as newly-lit and the chime fires a slab.
      audio.resetChime();
      this.lastShapes = null;
      resetExposure();
    } catch (err) {
      /*
        Keep the working stream — but VERIFY it is still working. iOS may have
        already released it in order to consider the request, in which case
        `old` is now dead and silently keeping it would leave a frozen image.
      */
      if (old.isLive()) {
        this.camera = old;
        this.ev.onStatus?.(describeCameraError(err), true);
      } else {
        old.stop();
        this.camera = null;
        // Reacquire the side we were already on rather than stranding the user.
        try {
          const back = await startCamera(this._facing);
          this.camera = back;
          this._facing = back.facing;
          resetExposure();
          this.lastShapes = null;
          audio.resetChime();
        } catch (err2) {
          this._live = false;
          this.ev.onLive?.(false);
          this.ev.onStatus?.(describeCameraError(err2), true);
        }
      }
    } finally {
      this.flipping = false;
      // Restart the loop if we ended up with a camera, whichever one it is.
      if (this.camera && this._phase === 'aiming') {
        this.lastFpsAt = performance.now();
        this.cancelLoop();
        this.loop();
      }
    }
  }

  async startCameraStream(): Promise<void> {
    if (this.camera) return;
    this.ev.onStatus?.('requesting camera…');
    try {
      this.camera = await startCamera(this._facing);
      this._facing = this.camera.facing;
      resetExposure();
      this._live = true;
      this._phase = 'aiming';
      this.ev.onLive?.(true);
      this.ev.onPhase?.('aiming');
      this.lastFpsAt = performance.now();
      this.loop();
    } catch (err) {
      this.ev.onStatus?.(describeCameraError(err), true);
      this.ev.onLive?.(false);
      throw err;
    }
  }

  /** Stop the camera and drop any capture — back to the pre-camera state. */
  stopCameraStream(): void {
    this.stopPlayback();
    this.cancelLoop();
    this.camera?.stop();
    this.camera = null;
    this._live = false;
    this._phase = 'aiming';
    this.capture = null;
    this.lastCells = null;
    this.lastShapes = null;
    this.ev.onLive?.(false);
    this.ev.onPhase?.('aiming');
    this.previewMask();
  }

  private cancelLoop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private loop = () => {
    if (!this.camera || this._phase !== 'aiming') return;

    // A dead track keeps delivering the last frame (usually black) with no
    // error. Left unchecked the app looks alive while showing nothing — and
    // with invert on, a black frame fills the letter solid, which reads as a
    // feature rather than a failure.
    if (!this.camera.isLive()) {
      this.stopCameraStream();
      this.ev.onStatus?.('camera disconnected', true);
      return;
    }

    const t0 = performance.now();
    const gw = this.params.gridWidth;
    const gh = this.gridHeight;

    /*
      The stencil, or no stencil.

      When `masked` is off the dither runs against an all-true grid, so the
      whole frame lights and the stage shows the raw dithered environment. The
      letterform is not rasterized at all in that mode — nothing downstream
      needs it, and skipping it also skips the "no glyph" bail-out below.
    */
    let maskCells: boolean[][];
    let inkCount: number;
    if (this.params.masked) {
      const m = this.mask();
      /*
        NO MASK = NOTHING LIT, not a skipped frame.

        This used to schedule the next frame and return, painting nothing. That
        was defensible when the mask was one character and a null meant a glyph
        that failed to rasterize — a transient, unreachable-by-the-user state.

        Typed text makes empty REACHABLE: delete the last character and the
        rasterizer returns null every frame from then on. The old early return
        then skipped the dither, skipped `onFrame`, and left the canvas holding
        its last image — the app looked completely frozen, and typing a letter
        was the only way out, which nobody would guess.

        An all-false mask is the honest answer: no cells pass the stencil, so
        the stage goes black and the frame loop keeps running. Deleting to
        empty now reads as "the letterform is gone", which is what happened,
        and typing brings it straight back.
      */
      if (!m) {
        maskCells = this.closedMask(gw, gh);
        inkCount = 0;
      } else {
        maskCells = m.cells;
        inkCount = m.inkCount;
      }
    } else {
      maskCells = this.openMask(gw, gh);
      inkCount = gw * gh;
    }

    const r = ditherFrame(this.camera.video, maskCells, this.params.gridWidth, gh, {
      mode: this.params.mode,
      exposure: this.params.exposure,
      contrast: this.params.contrast,
      autoLevel: this.params.autoLevel,
      invert: this.params.invert,
      // Selfie view for the front camera only — see `DitherOptions.mirror`.
      mirror: this.camera.facing === 'user',
    });

    /*
      The aim chime: cells that just lit up ring once.

      Fired BEFORE `lastShapes` is overwritten, because it needs the previous
      frame to know what is new. `r.shapes` is a fresh array each frame
      (dither.ts allocates one), so holding the old reference is safe.
    */
    audio.chimeNewCells(
      r.shapes, this.lastShapes, this.params.gridWidth, gh, this.assignments,
    );

    this.lastCells = r.cells;
    this.lastShapes = r.shapes;
    this.lastLit = r.litCount;

    this.ev.onFrame?.(
      { cells: r.shapes, gridWidth: this.params.gridWidth, gridHeight: gh },
      -1
    );

    const cost = performance.now() - t0;
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsAt >= 500) {
      const fps = (this.frameCount * 1000) / (now - this.lastFpsAt);
      this.frameCount = 0;
      this.lastFpsAt = now;
      const litPct = ((r.litCount / Math.max(1, inkCount)) * 100).toFixed(0);
      this.ev.onStatus?.(
        `${this.params.gridWidth}×${gh} · ${r.litCount} lit (${litPct}%) · ` +
        `${cost.toFixed(1)}ms · ${fps.toFixed(0)}fps`
      );
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── Shutter ──────────────────────────────────────────────

  /**
   * Freeze the current live frame.
   *
   * DEEP-COPIES both grids. The live path reuses its buffers between frames
   * (`ditherFrame` allocates fresh arrays today, but `shapes` is sized from a
   * pooled length and the boolean rows are the documented reuse hazard), so
   * holding a reference would leave the "capture" mutating along with the
   * camera. `Int8Array.slice()` copies; `.subarray()` would not.
   */
  shutter(): boolean {
    if (this._phase !== 'aiming' || !this.lastCells || !this.lastShapes) return false;
    const gw = this.params.gridWidth;
    const gh = this.gridHeight;
    this.capture = {
      cells: this.lastCells.map((row) => row.slice()),
      field: { cells: this.lastShapes.slice(), gridWidth: gw, gridHeight: gh },
      char: this.params.char,
      shape: this.params.shape,
      density: this.params.density,
      litCount: this.lastLit,
    };
    this._phase = 'frozen';
    this.cancelLoop();
    this.ev.onPhase?.('frozen');
    this.ev.onStatus?.(`captured · ${this.capture.litCount} dots`);
    this.emitCapture();
    return true;
  }

  /** Discard the capture and go back to the viewfinder. */
  resumeAiming(): void {
    if (!this.camera) return;
    this.stopPlayback();
    this.capture = null;
    this._phase = 'aiming';
    this.ev.onPhase?.('aiming');
    this.lastFpsAt = performance.now();
    this.cancelLoop();
    this.loop();
  }

  /** Repaint the frozen capture at its current playhead. */
  private emitCapture() {
    if (!this.capture) return;
    // The FLOAT goes to the renderer so the rule moves sub-cell; the integer
    // stays the logical position. `field.ts` already multiplies by `cell`, so
    // it accepts a fractional column with no change.
    this.ev.onFrame?.(this.capture.field, this.playheadColF);
  }

  // ── Params ───────────────────────────────────────────────

  /**
   * Change a pipeline parameter.
   *
   * The three-way split is the real logic here, carried over verbatim from the
   * v1 handlers:
   *   - INVALIDATING (res, char, font, invert) changes WHICH CELLS ARE LIT, so
   *     a frozen capture can no longer be re-derived and we drop back to live.
   *   - COSMETIC (density, shape) restyles a capture in place.
   *   - LIVE-ONLY (exposure, contrast, autoLevel) affects the next frame only.
   */
  setParam<K extends keyof SessionParams>(name: K, value: SessionParams[K]): void {
    if (this.params[name] === value) return;
    this.params[name] = value;

    switch (name) {
      case 'gridWidth':
      case 'char':
      case 'fontFamily':
      case 'fontWeight':
      case 'invert':
      case 'masked':
        /*
          The chime keys its memory by CELL INDEX, and every one of these
          changes what a given index means, so the memory has to go.

          `lastShapes` goes WITH it. The chime diffs against the previous
          frame, and after an invert (or a letter change, or a resolution
          change) that frame describes a completely different image — every
          currently-lit cell would read as "new" and the whole letter would
          fire at once as one slab of noise. Clearing it means the next frame
          has no predecessor, and `chimeNewCells` treats a null `prev` as
          "nothing to compare", so the field re-enters quietly through the
          normal stability guard instead.
        */
        audio.resetChime();
        this.lastShapes = null;
        if (this._phase === 'frozen') this.resumeAiming();
        else if (!this._live) this.previewMask();
        break;

      case 'density':
      case 'shape':
        if (this._phase === 'frozen' && this.capture) {
          this.capture.density = this.params.density;
          // `shape` is now COSMETIC ONLY and does not restart playback. The
          // audio reads its shape per cell from the capture's shape grid, and
          // that grid is fixed at shutter time — this param is the v1 global
          // dot-shape override, which no longer has any say in the voices.
          if (name === 'shape') this.capture.shape = this.params.shape;
          this.emitCapture();
        } else if (!this._live) this.previewMask();
        break;

      // Both are LIVE. The engine re-reads them each tick, so latching loop or
      // changing the rate takes effect on the sweep already running. This used
      // to stop and restart playback, which reset the playhead to column 0 and
      // made a mid-sweep loop toggle audibly wrong.
      case 'loop':
        audio.setLoop(this.params.loop);
        break;

      case 'sweepSeconds':
        audio.setSweepSeconds(this.params.sweepSeconds);
        break;
    }
  }

  /**
   * The current per-shape voice assignments. Returned as a COPY so the overlay
   * cannot mutate the live map by holding the object it was seeded with —
   * "exit without saving" has to actually not save.
   */
  get voiceAssignments(): VoiceAssignments {
    return {
      square:  { ...this.assignments.square },
      circle:  { ...this.assignments.circle },
      diamond: { ...this.assignments.diamond },
      cross:   { ...this.assignments.cross },
    };
  }

  /**
   * The same assignments expressed in the OVERLAY's vocabulary — profile IDS
   * (`sp1`…`sp4`) rather than resolved voices (`keys`, `piano`…).
   *
   * `voiceAssignments` above returns resolved profiles because that is what
   * the scheduler consumes. `setVoiceAssignments` accepts ids. Seeding the
   * overlay from the resolved getter therefore produced a store it could not
   * save back: every slot was rejected as an unknown profile and the user's
   * level edits vanished with only a console warning. Seed from this instead.
   */
  get voiceAssignmentIds(): Record<Shape, { profile: string; level: number }> {
    const out = {} as Record<Shape, { profile: string; level: number }>;
    for (const shape of Object.keys(this.assignments) as Shape[]) {
      const a = this.assignments[shape];
      out[shape] = { profile: audio.ID_BY_PROFILE[a.profile] ?? 'sp1', level: a.level };
    }
    return out;
  }

  /**
   * Apply the overlay's saved assignments.
   *
   * Profile ids from `SoundConfig` (`sp1`..`sp4`) are resolved to synthesis
   * voices HERE rather than in the engine's hot path, so the scheduler never
   * does a string lookup per note and an unknown id fails at the boundary
   * instead of silently going quiet mid-sweep.
   *
   * Like sweep length, the assignment map is read when the scheduler starts, so
   * a change during playback needs a restart to be heard.
   */
  setVoiceAssignments(next: Record<Shape, { profile: string; level: number }>): void {
    for (const shape of Object.keys(this.assignments) as Shape[]) {
      const incoming = next[shape];
      if (!incoming) continue;
      const profile = audio.PROFILE_BY_ID[incoming.profile];
      if (!profile) {
        console.warn(`[session] unknown sound profile "${incoming.profile}" for ${shape}; keeping previous`);
        continue;
      }
      this.assignments[shape] = {
        profile,
        level: Math.min(1, Math.max(0, incoming.level)),
      };
    }
    this.persistAssignments();
    if (audio.isPlaying()) { this.stopPlayback(); void this.play(); }
  }

  /**
   * Save the voice assignments so they survive a reload.
   *
   * Persisted in the OVERLAY's vocabulary (`sp1`…`sp4`), not as resolved voice
   * names: ids are the stable key that `setVoiceAssignments` validates against,
   * so a stored file stays readable even if a profile is later remapped to a
   * different synth voice. Writing resolved names would bake today's mapping
   * into saved data.
   *
   * Failure is non-fatal — private browsing and a full quota both throw, and
   * losing a preference is not worth breaking the app over.
   */
  private persistAssignments(): void {
    try {
      localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(this.voiceAssignmentIds));
    } catch { /* storage unavailable or full — preferences are best-effort */ }
  }

  /**
   * Restore saved assignments. Returns null when there is nothing usable, so
   * the caller keeps the defaults.
   *
   * Every field is re-validated rather than trusted: this is user-editable
   * storage, and an unknown profile id would otherwise reach the scheduler.
   * `setVoiceAssignments` performs the same check, so a bad slot is dropped
   * and its default survives.
   */
  private static loadAssignments(): Record<string, { profile: string; level: number }> | null {
    try {
      const raw = localStorage.getItem(ASSIGNMENTS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  /** Font swap — invalidates the rasterized mask cache as well as any capture. */
  setFont(family: string, weight: number): void {
    this.params.fontFamily = family;
    this.params.fontWeight = weight;
    clearMaskCache();
    if (this._phase === 'frozen') this.resumeAiming();
    else if (!this._live) this.previewMask();
  }

  // ── Playback ─────────────────────────────────────────────

  /**
   * Play the frozen capture.
   *
   * MUST be awaited from inside a user-gesture handler: `audio.getCtx()` is
   * what unlocks the AudioContext, and browsers only honour resume() from a
   * gesture.
   *
   * Hands the engine BOTH grids from the same capture. They are co-indexed by
   * construction and were frozen together at shutter time, so the engine can
   * read lit-ness and shape at one `(row, col)` without re-deriving either.
   */
  async play(): Promise<void> {
    const cap = this.capture;
    if (!cap) return;
    // Synchronous re-entrancy latch. `audio.isPlaying()` only becomes true
    // INSIDE `audio.play()`, after `await getCtx()` — so two calls in the same
    // tick both saw `false`, neither took the stop branch, and both started a
    // sweep. Each extra transport drives its own rAF against one canvas and
    // one bus. The window is widest on a cold AudioContext, where `resume()`
    // is a real macrotask and every queued tap gets through.
    if (this.starting) return;
    if (audio.isPlaying()) { this.stopPlayback(); return; }
    this.starting = true;

    this.ev.onPlayStateChange?.(true);
    await audio.play(
      {
        cells: cap.cells,
        shapes: cap.field.cells,
        gridWidth: cap.field.gridWidth,
        gridHeight: cap.field.gridHeight,
      },
      {
        assignments: this.assignments,
        sweepSeconds: this.params.sweepSeconds,
        density: cap.density,
        loop: this.params.loop,
        // Resume from wherever the scrubber left the playhead. Without this,
        // `startCol` was documented at length as the scrub mechanism and had
        // no caller: scrub to the middle, press play, and the rule jumped back
        // to column 0. `-1` (idle) starts at the beginning, as it should.
        startCol: this.playheadCol >= 0 ? this.playheadCol : 0,
        onPlayhead: (col) => {
          // Grid space, start to finish. The renderer turns the column into a
          // pixel using the same letterbox it drew the dots with.
          //
          // TWO representations, and both are needed:
          //   `playheadCol`  INTEGER — the logical column. Feeds `startCol` on
          //                  resume and the `changed` test in `scrubTo`, which
          //                  needs integer equality or a slow drag retriggers
          //                  the same column's notes on every pointer event.
          //   `playheadColF` FLOAT — what the RENDERER draws. Flooring for the
          //                  render quantises the rule to whole cells on top of
          //                  the engine's 33ms report throttle, and the two
          //                  quantisers compound: at 3x (a 1s sweep, 22.7ms per
          //                  column) only 31 of 44 columns ever got a rule
          //                  drawn, and it lurched two cells at a time. 13
          //                  columns sounded with no visible playhead — the
          //                  sweep stopped being the music at exactly the speed
          //                  where the gesture is most energetic.
          this.playheadCol = Math.min(cap.field.gridWidth - 1, Math.floor(col));
          this.playheadColF = Math.min(cap.field.gridWidth - 1, col);
          this.ev.onProgress?.(col / Math.max(1, cap.field.gridWidth));
          this.emitCapture();
        },
        onEnd: () => {
          this.playheadCol = -1;
          this.playheadColF = -1;
          this.ev.onPlayStateChange?.(false);
          this.emitCapture();
        },
      }
    ).finally(() => { this.starting = false; });
  }

  /**
   * Scrub the playhead to a position, 0..1 across the sweep, and SOUND the
   * column landed on.
   *
   * Touching the scrubber TAKES OVER from autoplay: an in-flight sweep is
   * stopped first. Anything else fights the user — the automatic playhead
   * would keep advancing under the finger, and both would be queueing notes
   * against the same bus.
   *
   * The column is played directly rather than by restarting the transport, so
   * dragging sounds each column as it is crossed, like drawing a bow across
   * the letter. Silent columns stay silent; a column is only re-triggered
   * when the scrub actually moves to a NEW one, or a slow drag would retrigger
   * the same notes every pointer event.
   */
  scrubTo(t: number): void {
    const cap = this.capture;
    if (!cap) return;

    // Scrubbing wins over autoplay.
    if (audio.isPlaying()) {
      audio.stop();
      this.ev.onPlayStateChange?.(false);
    }

    const gw = cap.field.gridWidth;
    const clamped = Math.min(1, Math.max(0, t));
    const col = Math.min(gw - 1, Math.floor(clamped * gw));

    const changed = col !== this.playheadCol;
    this.playheadCol = col;
    // Scrubbing is a DELIBERATE landing on a column, so the rule sits on that
    // column rather than between two — unlike a sweep, where sub-cell motion is
    // the point. Keeping them equal here also means a scrub-then-play resumes
    // from exactly where the rule is drawn.
    this.playheadColF = col;
    this.ev.onProgress?.(clamped);
    this.emitCapture();

    if (changed) {
      void audio.playColumn(
        {
          cells: cap.cells,
          shapes: cap.field.cells,
          gridWidth: gw,
          gridHeight: cap.field.gridHeight,
        },
        col,
        {
          assignments: this.assignments,
          sweepSeconds: this.params.sweepSeconds,
          density: cap.density,
        },
      );
    }
  }

  /**
   * Playback speed multiplier from the large dial: 1x / 2x / 3x.
   *
   * 1x IS the measured 3-second sweep (`HANDOFF.md` §6 note 1), so 2x = 1.5s
   * and 3x = 1s. Applied live — `audio.setSweepSeconds` re-anchors a sweep in
   * flight so the playhead keeps its position while the rate changes.
   */
  /**
   * Set the mask text.
   *
   * Replaces `stepLetter`, which walked a hardcoded A-Z ring — there is no
   * alphabet to step through now that the mask is typed.
   *
   * Clamped to MAX_CHARS here rather than trusting the input element's
   * `maxlength`: paste, autocorrect and speech-to-text can all exceed it, and
   * the rasterizer's line budget is what actually has to hold.
   *
   * INVALIDATING, exactly as `char` was: it changes which cells are lit, so a
   * frozen capture cannot survive it. `setParam` already owns that behaviour —
   * routing through it keeps one code path for the whole invalidating class
   * rather than a second copy that can drift.
   */
  setText(text: string): void {
    const clamped = text.slice(0, MAX_CHARS);
    /*
      THE LAST CHARACTER CANNOT BE DELETED.

      An empty canvas is not a state worth reaching: with the stencil on and no
      text there is nothing to look at, nothing to photograph and nothing to
      play — the stage is simply black, and the only way out is to guess that
      typing fixes it.

      Rejected HERE rather than in the input handler because this is the single
      point every path goes through — keystroke, paste, dictation, autocorrect,
      and any programmatic caller. Guarding the keystroke alone would let a
      select-all-and-delete through, which is exactly how a user empties a
      field in practice.

      `trim()` in the test, not `length`: a string of spaces rasterizes to
      nothing, so it is empty for every purpose that matters here even though
      it has characters in it.
    */
    if (clamped.trim().length === 0) return;
    this.setParam('char', clamped);
  }

  /** The current mask text, for a UI that wants to show it. */
  get text(): string { return this.params.char; }

  /** The current letter, for a UI that wants to show it. */
  get letter(): string { return this.params.char; }

  /**
   * Audition one shape with one profile — the Sound Config overlay's preview.
   *
   * The screen's whole job is choosing sounds, and until now it made none: you
   * picked a voice for a shape and heard nothing until you left, captured, and
   * played. `HANDOFF.md` §10 has flagged since the first build that nobody has
   * ever heard this app; a silent configuration screen is a large part of why.
   *
   * When a capture exists this plays a column of YOUR OWN LETTER with the
   * other three shapes silenced, so you hear the shape in the texture it will
   * actually have. The column chosen is the one where this shape dominates the
   * most runs — the most representative sample rather than an arbitrary slice.
   *
   * Falls back to a short ascending figure before the first shutter, so a
   * profile is still auditionable on a cold start.
   *
   * The `profileId` is the overlay's own vocabulary (`sp1`…`sp4`), because the
   * user is previewing a selection they have not saved yet.
   */
  previewShape(shape: Shape, profileId: string): void {
    const profile = audio.PROFILE_BY_ID[profileId];
    if (!profile) return;

    const level = this.assignments[shape]?.level ?? 0.5;
    // Solo: the previewed shape at its level, the rest muted, so a mixed run
    // cannot colour the audition with a voice you are not evaluating.
    const solo = {} as audio.VoiceAssignments;
    for (const s of Object.keys(this.assignments) as Shape[]) {
      solo[s] = s === shape ? { profile, level } : { profile, level: 0 };
    }

    const cap = this.capture;
    if (!cap) {
      audio.previewFigure(profile, level);
      return;
    }

    // Pick the column where this shape dominates the most runs.
    const score = {
      cells: cap.cells,
      shapes: cap.field.cells,
      gridWidth: cap.field.gridWidth,
      gridHeight: cap.field.gridHeight,
    };
    let bestCol = -1;
    let bestCount = 0;
    for (let col = 0; col < score.gridWidth; col++) {
      const n = audio.analyzeColumn(score, col, 1).filter(v => v.shape === shape).length;
      if (n > bestCount) { bestCount = n; bestCol = col; }
    }
    if (bestCol < 0) { audio.previewFigure(profile, level); return; }

    void audio.playColumn(score, bestCol, {
      assignments: solo,
      sweepSeconds: this.params.sweepSeconds,
      density: cap.density,
    });
  }

  setSpeed(x: 1 | 2 | 3): void {
    // Delegate rather than writing `params` directly: `setParam` is the single
    // guarded path (it early-returns on no-change and owns the live-apply), and
    // two writers for one field is the bug class that has already bitten this
    // codebase four times. Writing here also left `setParam`'s `sweepSeconds`
    // branch dead, since nothing else routed through it.
    this._speed = x;
    this.setParam('sweepSeconds', BASE_SWEEP_SECONDS / x);
  }

  /**
   * The current speed multiplier. Stored rather than derived from
   * `sweepSeconds`, so a UI re-syncing to it reads the value instead of
   * inverting a division and rounding.
   */
  get speed(): 1 | 2 | 3 { return this._speed; }

  stopPlayback(): void {
    audio.stop();
    this.playheadCol = -1;
    this.playheadColF = -1;
    this.ev.onPlayStateChange?.(false);
    this.ev.onProgress?.(0);
    if (this._phase === 'frozen') this.emitCapture();
  }

  /**
   * Stop doing work while the page is hidden.
   *
   * Cancels the frame loop and stops the camera tracks. A phone backgrounds
   * constantly — calls, app switches, screen lock — and a viewfinder nobody
   * can see is pure battery cost.
   *
   * A frozen capture is left ALONE: it is an artifact the user made, and
   * losing it because they took a call would be indefensible. Only the live
   * path stops.
   */
  suspendForBackground(): void {
    if (!this.camera) return;
    this.cancelLoop();
    this.camera.stop();
    this.camera = null;
    // Not `_live = false`: that drives the error gate, and backgrounding is
    // not an error. The UI should look unchanged when the user returns.
    this.lastShapes = null;
    audio.resetChime();
  }

  /**
   * Come back from the background.
   *
   * Reopens the camera on the SAME facing, and only while aiming — a frozen
   * capture needs no camera, and reacquiring one would be a surprise.
   *
   * `lastShapes` was cleared on suspend, so the first frame back takes the
   * seed path in `chimeNewCells`: recorded as a baseline, silent. Without that
   * the whole field reads as newly-lit and fires at once.
   */
  resumeFromBackground(): void {
    if (this.camera || this._phase !== 'aiming') return;
    void this.startCameraStream().catch(() => { /* surfaced via onStatus */ });
  }

  /** Release everything. Call on pagehide. */
  dispose(): void {
    this.stopPlayback();
    this.cancelLoop();
    this.camera?.stop();
    this.camera = null;
    this._live = false;
  }
}
