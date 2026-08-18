/**
 * Playback: a dot grid read as a score.
 *
 * A playhead sweeps left→right. Each column sounds the dots it crosses; row
 * maps to pitch, top of the letter high, bottom low.
 *
 * Ported from glyph-studio's `audio/audioEngine.ts`, with five changes that
 * the source engine did not need because it played sparse hand-drawn glyphs,
 * not dense camera dither. Each is load-bearing:
 *
 * 1. SWEEP DURATION, NOT BPM.
 *    The original ties one column to one beat: `colDuration = 60/bpm`. At its
 *    default 160bpm a 64-column letter takes 24 seconds, and even at the 300bpm
 *    ceiling it's 12.8s. A specimen needs to play in a few seconds. Worse,
 *    tying duration to column count means the resolution slider silently
 *    changes tempo. Here the caller names a total sweep time and column
 *    duration is derived, so playback length is independent of resolution.
 *
 * 2. VOICE CAP, SPREAD ACROSS ROWS.
 *    The original merges horizontal runs of lit cells into single sustained
 *    notes — the feature that makes it sound musical. Ordered dither produces
 *    ALTERNATING cells, which defeats run-merging almost entirely: measured
 *    33 run-starts per column on average at 96×120, peaking at 95. Each note
 *    is 5–11 Web Audio nodes, and notes overlap across columns, so uncapped
 *    this reaches 1000+ live nodes against a practical ceiling of a few
 *    hundred. The cap keeps the top N voices spread across the row range
 *    rather than the first N, so the letter's vertical extent still reads.
 *
 * 3. WIDER SCALE.
 *    The original quantizes to 11 pentatonic degrees, tuned for a 32-row
 *    canvas. At 120 rows that collapses 12 rows onto each pitch — wasted
 *    detail, and it manufactures unisons (see 4). Extended to 25 degrees.
 *
 * 4. The `1/√n` gain law assumes UNCORRELATED sources. Rows collapsing onto
 *    identical pitches at identical start times are perfectly correlated, and
 *    correlated sources sum linearly — so dense columns go OVER unity and clip
 *    rather than going quiet. Mitigated by 2 and 3, plus the bus compressor.
 *
 * 5. STRUM CLAMP. The original offsets strummed voices by 18ms each; at 40
 *    voices that's a 702ms spread which overruns the column entirely. Now
 *    scaled to a fraction of the column.
 */

import { playNote, type VoiceProfile } from './voices';
import { SHAPES, type Shape } from '../ui/field';

// ── Context and bus ────────────────────────────────────────

let ctx: AudioContext | null = null;
let sequenceBus: GainNode | null = null;
let sequenceCompressor: DynamicsCompressorNode | null = null;
let sequenceChain: AudioNode[] = [];

/**
 * Get the AudioContext, resuming if suspended.
 *
 * MUST be awaited from a user gesture on first use. The original calls
 * `resume()` fire-and-forget; outside a gesture `currentTime` then stays
 * frozen at 0 while the promise is pending, and the scheduler — which
 * computes everything from `currentTime` — schedules an entire sweep into the
 * same instant, producing one loud burst.
 */
export async function getCtx(): Promise<AudioContext> {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

/**
 * Signal chain:
 *   notes → bus → lowpass(8k) → compressor → destination        (dry)
 *   notes → bus → lowpass → preDelay(22ms) → gain → compressor  (one reflection)
 *
 * Ported verbatim, and it is NOT optional. The compressor is the only thing
 * preventing dense columns from clipping. And `stop()` silences in-flight
 * notes solely by ramping and disconnecting this bus — wire notes straight to
 * `destination` and Stop becomes a no-op while up to a second of tails keep
 * ringing.
 */
function getSequenceBus(context: AudioContext): GainNode {
  if (!sequenceBus) {
    const t = context.currentTime;

    sequenceBus = context.createGain();
    sequenceBus.gain.setValueAtTime(1, t);

    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(8000, t);
    lowpass.Q.setValueAtTime(0.5, t);

    sequenceCompressor = context.createDynamicsCompressor();
    sequenceCompressor.threshold.setValueAtTime(-18, t);
    sequenceCompressor.knee.setValueAtTime(6, t);
    sequenceCompressor.ratio.setValueAtTime(4, t);
    sequenceCompressor.attack.setValueAtTime(0.003, t);
    sequenceCompressor.release.setValueAtTime(0.12, t);

    // Non-feedback pre-delay: a single early reflection, so it adds room
    // presence and then decays with the dry signal — no resonator ringing.
    const preDelay = context.createDelay(0.1);
    preDelay.delayTime.setValueAtTime(0.022, t);
    const preDelayGain = context.createGain();
    preDelayGain.gain.setValueAtTime(0.18, t);

    sequenceBus.connect(lowpass);
    lowpass.connect(sequenceCompressor);
    lowpass.connect(preDelay);
    preDelay.connect(preDelayGain);
    preDelayGain.connect(sequenceCompressor);
    sequenceCompressor.connect(context.destination);

    // Retained so stop() can detach the whole graph. Holding only the bus and
    // compressor leaves the lowpass, delay and its gain connected to each
    // other and unreachable — three orphaned nodes per play/stop cycle.
    sequenceChain = [lowpass, preDelay, preDelayGain];
  }
  return sequenceBus;
}

// ── Pitch ──────────────────────────────────────────────────

/**
 * C major pentatonic, C2–C6 (25 degrees).
 *
 * Pentatonic has no semitone pairs, so a dense vertical stack stays consonant
 * no matter which rows happen to be lit — the difference between "musical" and
 * "fax machine" on arbitrary input. Widened from the source's 11 degrees
 * because tall grids otherwise collapse many rows onto one pitch.
 */
const PENTATONIC: number[] = (() => {
  const degrees = [0, 2, 4, 7, 9]; // C D E G A
  const out: number[] = [];
  for (let oct = 2; oct <= 6; oct++) {
    for (const d of degrees) out.push(12 * (oct + 1) + d);
  }
  return out;
})();

/** Row → Hz. Row 0 is the TOP of the grid and the TOP of the scale. */
export function rowToHz(row: number, gridHeight: number): number {
  const t = row / Math.max(1, gridHeight - 1);
  const idx = Math.round((1 - t) * (PENTATONIC.length - 1));
  const midi = PENTATONIC[idx];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ── Scheduling ─────────────────────────────────────────────

/**
 * A score is the boolean grid PLUS the co-indexed shape grid.
 *
 * `shapes` is flat and row-major (`row * gridWidth + col`), exactly as
 * `ditherFrame` emits it and as `Capture.field.cells` stores it: `-1` for an
 * unlit cell, `0..3` for an index into `SHAPES`. It is co-indexed with `cells`
 * by construction (dither.ts:141), so this module never re-derives one from the
 * other — it reads lit-ness from `cells` and shape from `shapes` at the same
 * `(row, col)` and trusts the invariant the producer guarantees.
 */
export interface Score {
  cells: boolean[][];
  /** Flat row-major shape index per cell; -1 unlit, 0..3 into `SHAPES`. */
  shapes: Int8Array;
  gridWidth: number;
  gridHeight: number;
}

/**
 * What a shape's assignment slot resolves to.
 *
 * This is the crux of the pass. Shape does NOT pick a voice — it picks a SLOT,
 * and the slot names a profile and a level. Both come from the Sound Config
 * overlay, which is the user's decision surface; nothing in this file decides
 * what a square sounds like.
 */
export interface VoiceAssignment {
  profile: VoiceProfile;
  /** 0..1, the overlay's per-shape level. 0.5 is the design's default. */
  level: number;
}

/** The four assignment slots, one per shape. */
export type VoiceAssignments = Record<Shape, VoiceAssignment>;

/**
 * `SoundConfig` profile id → synthesis voice.
 *
 * The overlay's four profiles are deliberately abstract in the UI (`S.P.1` …
 * `S.P.4`) — the design names them by slot, not by instrument, so the mapping
 * to actual synthesis lives here rather than leaking instrument names into the
 * reel. Adding a fifth profile means adding a line here and a `PROFILES` entry
 * in `SoundConfig.ts`; `marimba` and `pad` are already synthesized and waiting.
 */
export const PROFILE_BY_ID: Record<string, VoiceProfile> = {
  sp1: 'keys',
  sp2: 'piano',
  sp3: 'rhodes',
  sp4: 'guitar',
};

/**
 * The inverse: resolved voice → overlay id.
 *
 * Needed because the session's `voiceAssignments` getter hands out RESOLVED
 * profiles while `setVoiceAssignments` accepts IDS. Feeding the getter's own
 * output back therefore rejected every slot ("unknown sound profile 'keys'")
 * and silently discarded the user's level edits — the Sound Config save was a
 * complete no-op. Round-tripping through this map makes the two symmetric.
 */
export const ID_BY_PROFILE: Record<string, string> = Object.fromEntries(
  Object.entries(PROFILE_BY_ID).map(([id, profile]) => [profile, id]),
);

/**
 * The defaults, matching `SoundConfig`'s own `base` map (SoundConfig.ts:60-65)
 * so the engine sounds the same before the overlay has ever been opened as it
 * does immediately after opening and saving without changing anything.
 */
export const DEFAULT_ASSIGNMENTS: VoiceAssignments = {
  square:  { profile: PROFILE_BY_ID.sp1, level: 0.5 },
  circle:  { profile: PROFILE_BY_ID.sp2, level: 0.5 },
  diamond: { profile: PROFILE_BY_ID.sp3, level: 0.5 },
  cross:   { profile: PROFILE_BY_ID.sp4, level: 0.5 },
};

export interface PlayOptions {
  /** Per-shape profile + level, from the Sound Config overlay. */
  assignments?: VoiceAssignments;
  /** Total time for the playhead to cross the whole letter, in seconds. */
  sweepSeconds: number;
  /** Dot fill fraction; scales note gain, as in the source engine. */
  density: number;
  loop: boolean;
  /**
   * Column to start the sweep from, for scrubbing. Defaults to 0.
   *
   * The scheduler anchors every note to a single `origin` taken from
   * `AudioContext.currentTime`, so there is no way to seek a sweep already in
   * flight — the queued notes are already committed to the audio clock.
   * Starting from a column instead re-anchors the origin so that `startCol`
   * lands at "now", which makes a scrub a stop-and-replay from the new
   * position. That is why it sounds, rather than just moving the rule.
   */
  startCol?: number;
  onPlayhead?: (col: number) => void;
  onEnd?: () => void;
}

/** Max simultaneous note-starts per column. See note 2 at the top. */
const MAX_VOICES_PER_COLUMN = 12;

let rafId: number | null = null;
let playing = false;

/**
 * Live transport controls for a sweep already in flight.
 *
 * Loop and speed must take effect WHILE the playhead is running — latching
 * loop mid-sweep should make it repeat, and cycling 1x→2x should change the
 * rate immediately rather than on the next press. Both were previously read
 * once at `play()` time, so neither did anything until playback restarted.
 */
let liveLoop = false;
let liveSetRate: ((seconds: number) => void) | null = null;

export function isPlaying(): boolean { return playing; }

/** Latch or unlatch looping mid-sweep. Safe to call when stopped. */
export function setLoop(on: boolean): void { liveLoop = on; }

/** Change the sweep duration mid-flight without moving the playhead. */
export function setSweepSeconds(seconds: number): void { liveSetRate?.(seconds); }

/**
 * One scheduled note.
 *
 * `shape` is the run's DOMINANT shape — the one occupying the most cells across
 * the whole run, not the shape of the cell the run happens to start on. It is
 * the key into the assignment map, and therefore what decides the run's voice
 * and level.
 */
export interface Voice { row: number; duration: number; shape: Shape; }

/**
 * Collect the voices for one column. Ported from `harness.html:214-233`, which
 * was the only implementation of this.
 *
 * A cell only counts if it STARTS a run — if its left neighbour is lit, the
 * note is already sounding and must not be re-struck. Run length sets the note
 * duration, so a horizontal band becomes one held tone rather than a stutter.
 *
 * RUNS MERGE ACROSS SHAPES, and the dominant shape picks the voice.
 *
 * This is a measured decision, not a default (VERSIONS.md, "Audio consequence
 * of four shapes"). The shape grid is a four-level halftone assigned by
 * brightness, so a smooth tonal gradient ALTERNATES shapes cell by cell by
 * construction. Breaking a run at every shape change would therefore shatter
 * one held tone into three or more separate note streams, roughly tripling the
 * note count against a 12-voice cap that is already tight — a worst-case column
 * measured 77 run-starts before capping. Merging keeps the run structure that
 * makes this sound musical rather than like a fax machine, and the histogram
 * means a run that is mostly squares plays the square's voice even if it starts
 * on a stray circle.
 *
 * The harness had a `S.merge` toggle to compare both behaviours. It is gone:
 * the comparison was the point of the harness, the verdict is in, and keeping a
 * dead branch here would invite someone to flip it without knowing the cost.
 */
function columnVoices(
  score: Score,
  col: number,
  colDuration: number
): Voice[] {
  const { cells, shapes, gridWidth, gridHeight } = score;
  const all: Voice[] = [];

  for (let row = 0; row < gridHeight; row++) {
    const line = cells[row];
    if (!line?.[col]) continue;
    if (col > 0 && line[col - 1]) continue; // mid-run, already sounding

    // Walk the run once, counting shape occupancy as we go. Four shapes, so a
    // fixed-size tally beats a map — no allocation per run, and this is the
    // hottest loop in the scheduler.
    const counts = [0, 0, 0, 0];
    let runEnd = col;
    while (runEnd < gridWidth && line[runEnd]) {
      const idx = shapes[row * gridWidth + runEnd];
      // `idx` is guaranteed 0..3 wherever `cells` is true (dither.ts:141), but
      // a defensive bound keeps a malformed score from writing out of range
      // rather than silently corrupting the tally.
      if (idx >= 0 && idx < 4) counts[idx]++;
      runEnd++;
    }
    const runLength = runEnd - col;

    // Dominant shape. Ties break toward the lower index, i.e. the DARKER shape
    // (SHAPES is ordered square → cross by ink coverage), which matches the
    // harness's `sort` on a Object.entries built in ascending key order.
    let best = 0;
    for (let i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i;

    // 95% of the span leaves a sliver of silence, so a retrigger reads as a
    // fresh attack rather than a seamless continuation.
    all.push({
      row,
      duration: runLength * colDuration * 0.95,
      shape: SHAPES[best],
    });
  }

  if (all.length <= MAX_VOICES_PER_COLUMN) return all;

  // Over the cap: keep voices SPREAD across the row range rather than the
  // first N. Taking the first N would drop the bottom of the letter entirely,
  // so a dense column would lose its low notes and the letterform's vertical
  // extent would stop being audible.
  const kept: Voice[] = [];
  const step = (all.length - 1) / (MAX_VOICES_PER_COLUMN - 1);
  for (let i = 0; i < MAX_VOICES_PER_COLUMN; i++) {
    kept.push(all[Math.round(i * step)]);
  }
  return kept;
}

/**
 * The run analysis for one column, without scheduling anything.
 *
 * Exported for verification only — nobody can hear this app in the environment
 * it is being built in, so the note count, the per-run dominant shape and the
 * voice cap have to be checked structurally. `colDuration` is a pure scale
 * factor on `duration`; pass 1 to read run LENGTHS in columns directly.
 */
export function analyzeColumn(score: Score, col: number, colDuration = 1): Voice[] {
  return columnVoices(score, col, colDuration);
}

/** Play a score. Returns immediately; `onEnd` fires when the sweep finishes. */
export async function play(score: Score, opts: PlayOptions): Promise<void> {
  stop();

  const context = await getCtx();
  const bus = getSequenceBus(context);

  const { gridWidth } = score;
  /*
    Sweep rate and loop are LIVE, not captured at play() time.

    `colDuration` is `let`, and `setRate()` re-anchors `origin` so the playhead
    stays put when the rate changes — without that, doubling the speed
    mid-sweep would teleport the rule, since `elapsed / colDuration` would
    suddenly read a different column for the same instant.

    Notes already scheduled keep the duration they were queued with; only
    columns not yet reached adopt the new rate. That is correct for a tempo
    change and avoids retuning notes already committed to the audio clock.
  */
  let colDuration = Math.max(0.01, opts.sweepSeconds / Math.max(1, gridWidth));
  const gain = 0.2 + opts.density * 0.25;
  const assignments = opts.assignments ?? DEFAULT_ASSIGNMENTS;

  // Where the sweep begins. Clamped so a scrub to the far edge cannot start
  // past the last column.
  const startCol = Math.max(0, Math.min(gridWidth - 1, Math.floor(opts.startCol ?? 0)));

  // Small offset so the first column isn't scheduled in the past. Shifting the
  // origin BACK by `startCol` columns makes `elapsed / colDuration` read
  // `startCol` immediately, so the sweep resumes from there on both the audio
  // clock and the playhead — one anchor drives both, as it does at col 0.
  let origin = context.currentTime + 0.06 - startCol * colDuration;
  // Everything before the start column is already "played" and must not be
  // scheduled, or a scrub would fire the whole letter at once.
  let lastScheduled = startCol - 1;
  let lastPlayheadAt = 0;
  playing = true;

  // Live controls for the sweep in flight. Exposed via the module-level
  // `setRate` / `setLoop` below, which the transport calls while playing.
  liveLoop = opts.loop;
  liveSetRate = (seconds: number) => {
    const next = Math.max(0.01, seconds / Math.max(1, gridWidth));
    if (next === colDuration) return;
    // Hold the current column across the rate change: solve for the origin
    // that keeps `(now - origin) / next` equal to the column we are on now.
    const nowCol = (context.currentTime - origin) / colDuration;
    colDuration = next;
    origin = context.currentTime - nowCol * colDuration;
  };

  const scheduleColumn = (col: number) => {
    if (col < 0 || col >= gridWidth) return;
    const voices = columnVoices(score, col, colDuration);
    if (voices.length === 0) return;

    const startTime = origin + col * colDuration;
    // If we've already slipped past this column, play it now rather than in
    // the past — scheduling in the past makes the browser fire everything at
    // once and pile up.
    const safeStart = Math.max(startTime, context.currentTime + 0.005);

    const n = voices.length;
    const voiceGain = gain / Math.sqrt(n);

    // Strum: fan the column out slightly so it reads as played rather than
    // programmed. Clamped so the spread can never exceed a quarter of the
    // column — at high voice counts the source's fixed 18ms would smear a
    // column across its neighbours.
    const shouldStrum = n >= 2;
    const strumStep = shouldStrum
      ? Math.min(0.018, (colDuration * 0.25) / Math.max(1, n - 1))
      : 0;

    // Bottom-to-top, so the strum reads as an upward gesture.
    const ordered = shouldStrum ? [...voices].sort((a, b) => b.row - a.row) : voices;

    ordered.forEach((v, i) => {
      const jitter = shouldStrum ? (Math.random() - 0.5) * Math.min(0.008, strumStep * 0.5) : 0;
      const noteStart = safeStart + i * strumStep + jitter;

      // The assignment lookup. This is the ONLY place a shape becomes a sound:
      // the run's dominant shape indexes the map the Sound Config overlay owns,
      // and that yields both the voice and its level. `level` is doubled so the
      // overlay's 50% default is unity — a centred slider must not halve the
      // mix, and the harness scaled it the same way (harness.html:287).
      const slot = assignments[v.shape] ?? DEFAULT_ASSIGNMENTS[v.shape];

      playNote(
        rowToHz(v.row, score.gridHeight),
        slot.profile,
        voiceGain * slot.level * 2,
        noteStart,
        v.duration,
        context,
        bus
      );
    });
  };

  // Lookahead scheduler driven off the AUDIO clock, not frame timing. rAF only
  // decides when to look; every note time comes from `context.currentTime`, so
  // a stalled or throttled frame loop delays scheduling but never shifts the
  // music off the beat.
  const LOOKAHEAD = 0.06;

  const tick = () => {
    if (!playing) return;
    const elapsed = context.currentTime - origin;
    const colFloat = elapsed / colDuration;

    const lookaheadCol = (elapsed + LOOKAHEAD) / colDuration;
    while (lastScheduled + 1 < gridWidth && lastScheduled + 1 <= lookaheadCol) {
      lastScheduled++;
      scheduleColumn(lastScheduled);
    }

    // Throttle playhead reporting. ~30fps is right at 1x — a 3s sweep gives
    // 68.2ms per column, so every column still gets at least one frame and the
    // rule advances one cell at a time.
    //
    // It is WRONG at 3x. A 1s sweep is 22.7ms per column, shorter than the
    // interval itself, so columns were skipped entirely: measured 31 of 44
    // rendered, 13 columns sounding with no rule ever drawn on them, and jumps
    // of two cells. Rate-aware, the trail stays continuous at every speed —
    // never coarser than half a column, and never faster than 60fps, which is
    // all the canvas can show anyway.
    // 33ms normally; tighten only when a column is shorter than that, and never
    // below 16.7 (60fps) — past that we would be reporting faster than the
    // canvas can paint, spending main thread the scheduler needs.
    const minGap = Math.max(16.7, Math.min(33, colDuration * 1000 * 0.5));
    const nowMs = performance.now();
    if (nowMs - lastPlayheadAt >= minGap) {
      lastPlayheadAt = nowMs;
      opts.onPlayhead?.(Math.max(0, Math.min(gridWidth, colFloat)));
    }

    if (colFloat < gridWidth) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    // `liveLoop`, NOT `opts.loop` — latching loop mid-sweep must make THIS
    // sweep repeat rather than taking effect only on the next play.
    if (liveLoop) {
      // Advance the origin by exactly one sweep so loops stay phase-locked
      // instead of accumulating drift.
      origin += gridWidth * colDuration;
      lastScheduled = -1;
      rafId = requestAnimationFrame(tick);
      return;
    }

    playing = false;
    rafId = null;
    opts.onPlayhead?.(gridWidth);
    opts.onEnd?.();
  };

  rafId = requestAnimationFrame(tick);
}

/**
 * A short ascending figure on one voice — the Sound Config audition when no
 * capture exists yet.
 *
 * Five notes up the scale, strummed like a column so the attack behaves the
 * way it will in playback. Goes through the same bus and the same `playNote`,
 * so what you hear is the voice you are choosing, not an approximation.
 */
export async function previewFigure(profile: VoiceProfile, level: number): Promise<void> {
  const context = await getCtx();
  const bus = getSequenceBus(context);
  const rows = [18, 14, 10, 6, 2];          // low → high in a 25-degree scale
  const gain = 0.45 / Math.sqrt(rows.length);
  const start = context.currentTime + 0.005;
  rows.forEach((row, i) => {
    playNote(
      rowToHz(row, 25),
      profile,
      gain * level * 2,
      start + i * 0.09,
      0.28,
      context,
      bus,
    );
  });
}

/**
 * Sound ONE column, immediately — the scrubber's voice.
 *
 * Dragging the transport dial should play what it crosses, not just move a
 * rule. This is deliberately NOT a one-column `play()`: it starts no rAF loop,
 * sets no `playing` flag, and fires no `onEnd`, so it cannot fight the sweep's
 * transport state or leave a ticker behind when the drag stops.
 *
 * Everything that makes a column sound like a column is shared with the
 * scheduler — the same `columnVoices` run-merging, the same `1/√n` gain law,
 * the same bottom-to-top strum, the same per-shape assignment lookup, and the
 * same bus, so a scrubbed column and a swept one are indistinguishable.
 */
export async function playColumn(
  score: Score,
  col: number,
  opts: { assignments?: VoiceAssignments; sweepSeconds: number; density: number },
): Promise<void> {
  const { gridWidth } = score;
  if (col < 0 || col >= gridWidth) return;

  const context = await getCtx();
  const bus = getSequenceBus(context);

  const colDuration = Math.max(0.01, opts.sweepSeconds / Math.max(1, gridWidth));
  const voices = columnVoices(score, col, colDuration);
  if (voices.length === 0) return;

  const assignments = opts.assignments ?? DEFAULT_ASSIGNMENTS;
  const gain = 0.2 + opts.density * 0.25;
  const n = voices.length;
  const voiceGain = gain / Math.sqrt(n);

  const shouldStrum = n >= 2;
  const strumStep = shouldStrum
    ? Math.min(0.018, (colDuration * 0.25) / Math.max(1, n - 1))
    : 0;
  const ordered = shouldStrum ? [...voices].sort((a, b) => b.row - a.row) : voices;

  const start = context.currentTime + 0.005;
  ordered.forEach((v, i) => {
    const jitter = shouldStrum ? (Math.random() - 0.5) * Math.min(0.008, strumStep * 0.5) : 0;
    const slot = assignments[v.shape] ?? DEFAULT_ASSIGNMENTS[v.shape];
    playNote(
      rowToHz(v.row, score.gridHeight),
      slot.profile,
      voiceGain * slot.level * 2,
      start + i * strumStep + jitter,
      v.duration,
      context,
      bus,
    );
  });
}

/* ── The aim chime ────────────────────────────────────────────
 *
 * A cell that LIGHTS UP makes one sound. Persistent cells are silent — only
 * the transition from unlit to lit rings, like a wind chime struck once as it
 * moves rather than droning while it hangs.
 *
 * This is a live-view feature: it plays while aiming, not during playback of a
 * frozen capture (which has no new cells by definition). The playhead sweep is
 * untouched and still does its own thing on a capture.
 *
 * EVERY CONSTANT BELOW IS A GUESS. Nobody has heard this app (V3 §0), and
 * these were reasoned from the note-density arithmetic, not tuned by ear. They
 * are gathered here, at the top, precisely so they can be changed quickly once
 * someone listens. Expect to change them.
 */

/**
 * Ceiling on notes that may be RINGING AT ONCE.
 *
 * This replaced a per-FRAME cap, which was the wrong unit and did not work.
 * 160-per-frame sounds bounded until you multiply by 30fps: 4,800 notes/sec,
 * each holding 5-11 Web Audio nodes alive for `CHIME_DURATION`. Measured on a
 * live camera: ~2,600 notes/sec sustained, ~1,300 ringing simultaneously,
 * ~10,400 live nodes against a practical browser ceiling of a few hundred —
 * about 35x over.
 *
 * The failure mode is not distortion. The AudioContext simply cannot render
 * that graph in real time: its clock fell to 0.5-1.1% of wall speed, so notes
 * were still being scheduled while almost nothing was rendered, and the app
 * went quiet. That is the "sound stops after a while" report, and it got worse
 * inverted because inversion lights ~4x as many cells.
 *
 * Concurrency is the quantity that actually has to be bounded, because it is
 * what the audio thread pays for. At 500ms ring time, 96 voices is roughly 190
 * notes/sec sustained — dense enough to read as continuous texture, and inside
 * what the renderer can carry with headroom for the playhead sweep.
 */
const CHIME_MAX_VOICES = (() => {
  /*
    Phones get a THIRD of the desktop budget.

    Measured node counts per voice: guitar 12, pad 9, piano 8, keys 7,
    rhodes 7, marimba 6 — mean 8.2. At 96 voices that is ~790 live nodes, which
    a laptop renders fine (context clock held 0.996-1.003 over 25s) and an
    iPhone will not: the audio thread runs a fixed 128-frame quantum against a
    hard real-time deadline, on an efficiency core, sharing thermal budget with
    a live camera and a 60fps canvas dither.

    32 is ~260 live nodes, inside the few-hundred practical budget this file's
    own note already names, and still ~64 notes/sec sustained at
    CHIME_DURATION 0.5 — dense enough to read as texture rather than as
    separate strikes.

    A PREDICTION, not a measurement: nobody has run this on a phone. If the
    chime sounds thin on device, raise it; if the audio stutters or the phone
    warms, lower it. `coarsePointer` is a proxy for "touch device", which is
    the distinction that matters here — not screen size.
  */
  const coarsePointer =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarsePointer ? 32 : 96;
})();

/**
 * How long a struck cell rings.
 *
 * THIS IS THE LEVER THAT CONTROLS HOW OFTEN THE CHIME SPEAKS, and the
 * relationship is pure arithmetic:
 *
 *   voices ringing at once = notes per second x ring duration
 *
 * `CHIME_MAX_VOICES` bounds the left-hand side (it is the node budget that
 * keeps the iOS audio thread alive — see the note there). So for a FIXED
 * budget, a shorter ring is the only way to buy more notes per second. It is
 * not a volume or a taste knob; it is the throttle.
 *
 * Measured at the phone's 32-voice budget, holding peak nodes constant at ~262:
 *
 *   duration  notes/sec  silent frames (light scene)  character
 *   0.50      64         73%                          bell
 *   0.35      91         62%
 *   0.25      123        49%
 *   0.18      160        33%                          pluck   <- now
 *   0.12      240        0%                           tick
 *   0.08      320        0%                           click
 *
 * Lowered 0.5 -> 0.18 because at 0.5 the chime was silent on 73-93% of frames:
 * it fired a burst, then went dead for ten-plus frames, then burst again. The
 * budget was spent for half a second per note and the admission gate below was
 * all-or-nothing, so a full budget produced SILENCE rather than fewer notes.
 *
 * 0.18 is a REASONED value, not a heard one, and it is the first constant to
 * revisit once someone listens on a phone. Set it live with
 * `window.__audio.setChimeDuration(x)` to A/B on the device without a rebuild.
 */
let chimeDuration = 0.18;

/**
 * Read/set the ring duration at runtime, for tuning by ear on the device.
 *
 * Exists because nobody has heard this app: the value above was derived from
 * the note-density arithmetic, and the only way to choose between "bell" and
 * "pluck" is to listen to both on a phone. Clamped so a mistyped console entry
 * cannot wedge the audio thread.
 */
export function setChimeDuration(seconds: number): void {
  chimeDuration = Math.min(1.0, Math.max(0.05, seconds));
}
export function getChimeDuration(): number { return chimeDuration; }

/**
 * Notes a frame may chime even when the voice budget is exhausted.
 *
 * 0 = off (default): a full budget means silence for that frame, which is the
 * behaviour that keeps node count inside the iOS budget. A positive value
 * trades node headroom for a chime that keeps responding to the image — see
 * the measured cost table at the admission gate in `chimeNewCells`.
 *
 * Runtime-settable so it can be tried by ear on the device. Clamped to 8: past
 * that the arithmetic guarantees the budget blowout that kills the audio
 * thread.
 */
let chimeFloor = 0;
export function setChimeFloor(n: number): void {
  chimeFloor = Math.min(8, Math.max(0, Math.floor(n)));
}
export function getChimeFloor(): number { return chimeFloor; }

/**
 * Chime level relative to a swept note. These are ambient — they should sit
 * UNDER the sweep, not compete with it.
 */
const CHIME_GAIN = 0.4;

/**
 * Frames a cell must stay lit before it counts as "appeared".
 *
 * NOT optional. Ordered dither leaves cells sitting exactly at the threshold
 * that toggle every single frame on a completely still scene — `noise.ts`
 * documents 0-1 flips/frame for blue noise but that is the average, not the
 * boundary cells. Without this guard those cells chime continuously and the
 * feature sounds broken rather than ambient.
 */
const CHIME_STABLE_FRAMES = 2;

/**
 * Seconds before the same cell may chime again. Stops one unstable cell at the
 * threshold from machine-gunning even if it clears the stability check.
 */
const CHIME_COOLDOWN = 0.35;

let chimeMuted = false;
/** Cell index -> wall-clock time it last chimed. */
const chimeLastAt = new Map<number, number>();
/** Cell index -> consecutive frames seen lit but not yet chimed. */
const chimePending = new Map<number, number>();
/**
 * Wall-clock times at which currently-ringing chimes will finish.
 *
 * Kept sorted-ish by insertion and swept each frame. This is the live-voice
 * accounting that bounds concurrency — see `CHIME_MAX_VOICES`.
 */
let chimeRingUntil: number[] = [];

/**
 * Is the audio context live? Lets the UI skip redundant unlock attempts
 * without reaching into module state.
 */
export function isRunning(): boolean { return !!ctx && ctx.state === 'running'; }

/**
 * Suspend the audio context — call when the page is hidden.
 *
 * The chime alone can hold ~800 nodes alive; leaving that graph rendering for
 * a page nobody is looking at is the largest avoidable battery cost in the
 * app. `unlockAudio` in `main.ts` resumes it on the way back.
 *
 * Safe to call when there is no context or it is already suspended.
 */
export async function suspend(): Promise<void> {
  if (!ctx || ctx.state !== 'running') return;
  try { await ctx.suspend(); } catch { /* already gone */ }
}

/** Mute or unmute the aim chime. Playback is unaffected. */
export function setChimeMuted(on: boolean): void { chimeMuted = on; }
export function isChimeMuted(): boolean { return chimeMuted; }

/**
 * Reset the chime's per-cell memory.
 *
 * Call when the grid geometry changes or the camera restarts — cell INDICES
 * mean a different position after a resolution change, so stale entries would
 * suppress the wrong cells.
 */
export function resetChime(): void {
  chimeLastAt.clear();
  chimePending.clear();
  // The voice ledger too: notes already scheduled will still ring out, but the
  // budget should not stay spent against a field that no longer exists.
  chimeRingUntil = [];
}

/**
 * Sound the cells that just lit up.
 *
 * Called once per live frame with the current and previous shape grids. Fires
 * one note per newly-lit cell, subject to the stability, cooldown and rate
 * limits above.
 *
 * Deliberately fire-and-forget: it never awaits the AudioContext, because a
 * frame loop cannot block on audio. Before the context is unlocked by a user
 * gesture this does nothing, which is correct — a page that made noise before
 * any interaction would be blocked by autoplay policy anyway.
 */
export function chimeNewCells(
  shapes: Int8Array,
  prev: Int8Array | null,
  gridWidth: number,
  gridHeight: number,
  assignments: VoiceAssignments,
): void {
  if (chimeMuted || !ctx || ctx.state !== 'running') return;
  const context = ctx;
  /*
    Note SCHEDULING uses the audio clock; the cooldown BOOKKEEPING uses the
    wall clock, and mixing them up is what made the chime die.

    `AudioContext.currentTime` only advances as the context renders audio. In a
    throttled or backgrounded tab it crawls — measured here at 0.08s of audio
    clock across 400ms of real time. Every `now - last < COOLDOWN` comparison
    was therefore true essentially forever: cells were suppressed permanently
    and the field fell silent within a few seconds.

    `performance.now()` is monotonic wall time and is the correct basis for
    "has 350ms passed since this cell last rang". Scheduling still uses
    `context.currentTime` below, because that is what note timing must be
    anchored to.
  */
  const now = performance.now() / 1000;
  const audioNow = context.currentTime;

  /*
    NO PREVIOUS FRAME = SEED, DO NOT RING.

    A null `prev` means the comparison baseline is gone: first frame after the
    camera opens, after a letter/resolution/invert change, or after coming back
    from a frozen capture. Every lit cell would read as newly-appeared and the
    entire letter would fire as one slab — which is what invert sounded like.

    Instead, record the frame as the baseline and stay silent. The next frame
    diffs against it normally, so only genuinely new cells ring.
  */
  if (!prev) {
    chimePending.clear();
    for (let i = 0; i < shapes.length; i++) {
      if (shapes[i] >= 0) chimeLastAt.set(i, now);
    }
    return;
  }

  // Collect candidates first, so the frame ceiling can pick a SPREAD across the
  // set rather than the first N — taking the first N would only ever chime the
  // top of the letter, the same failure the voice cap avoids in `columnVoices`.
  const fresh: number[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const litNow = shapes[i] >= 0;
    if (!litNow) {
      chimePending.delete(i);
      // A cell that has gone dark is free to chime again the moment it returns
      // (subject to the cooldown, checked below on a fresh timestamp). Holding
      // its old entry here is what made cells fall permanently silent.
      const t = chimeLastAt.get(i);
      if (t !== undefined && now - t >= CHIME_COOLDOWN) chimeLastAt.delete(i);
      continue;
    }
    // Already lit last frame and already chimed => persistent, stays silent.
    if (prev && prev[i] >= 0 && !chimePending.has(i)) continue;

    const seen = (chimePending.get(i) ?? 0) + 1;
    if (seen < CHIME_STABLE_FRAMES) { chimePending.set(i, seen); continue; }
    chimePending.delete(i);

    const last = chimeLastAt.get(i);
    if (last !== undefined) {
      // EXPIRE, don't just skip. The cooldown exists to stop one unstable cell
      // machine-gunning; once it has elapsed the entry is dead weight, and
      // leaving it in the map is what made the chime fall silent after a few
      // seconds — see the note on `chimeLastAt`.
      if (now - last < CHIME_COOLDOWN) continue;
      chimeLastAt.delete(i);
    }
    fresh.push(i);
  }
  if (fresh.length === 0) return;

  /*
    Retire finished voices, then spend only what is left.

    This is the whole fix: the budget is how many notes may be RINGING, not how
    many may start. A frame that wants 700 chimes while 90 are still sounding
    gets 6, and the rest are simply not played — the ear cannot separate 700
    simultaneous strikes anyway, and the renderer certainly cannot.
  */
  chimeRingUntil = chimeRingUntil.filter((t) => t > now);
  const headroom = CHIME_MAX_VOICES - chimeRingUntil.length;

  /*
    GRACEFUL DEGRADATION, opt-in.

    The gate here used to be `if (headroom <= 0) return` — all-or-nothing. Once
    the budget was full the frame produced SILENCE, not fewer notes, so the
    chime fired a burst and then went dead for ten-plus frames. Worse, past a
    low density it stopped tracking the image at all: the throughput ceiling is
    `CHIME_MAX_VOICES / chimeDuration` regardless of how many cells light, so
    pointing at something simple and something busy sounded identical.

    `chimeFloor` lets a frame chime a THINNING SAMPLE of its new cells instead
    of nothing, so density stays audible. The notes are picked spread across
    `fresh` (the `step` walk below), never the first N, so a thinned frame is a
    sketch of the whole field rather than just its top edge.

    DEFAULT 0 — OFF, and deliberately so. A floor spends past the voice budget,
    and that budget is not a style choice: it is what keeps the iOS audio
    thread rendering in real time. Measured node counts at the phone's 32-voice
    cap, ~8.2 nodes per voice against the ~262-node design target:

      floor 0 (off)   peak 262 nodes   <- in budget
      floor 2         peak 508 nodes   1.9x over
      floor 4         peak 754 nodes   2.9x over
      floor 6         peak 1000 nodes  3.8x over

    Overspending here is exactly the failure mode in the CHIME_MAX_VOICES note:
    the context clock collapses and the app goes quiet ANYWAY, permanently
    rather than for a few frames. So this is a knob to try ON THE DEVICE with
    ears and a thermal check, not a default to ship blind.

    Enable live: `window.__audio.setChimeFloor(2)`. Prefer a shorter
    `chimeDuration` first — that buys notes/sec at NO node cost.
  */
  if (headroom <= 0 && chimeFloor <= 0) return;
  const allowance = headroom > 0 ? headroom : Math.min(chimeFloor, fresh.length);
  if (allowance <= 0) return;

  const take = Math.min(fresh.length, allowance);
  const step = fresh.length / take;
  const bus = getSequenceBus(context);
  /*
    `1/sqrt(n)` as everywhere else, so a dense burst does not clip.

    With no rate cap this matters far more than it did: a frame can now start
    a hundred-plus notes at once, and HANDOFF §6 records the subtlety — rows
    that collapse onto the same pitch at the same instant are perfectly
    CORRELATED and sum linearly, so they go over unity rather than staying
    quiet. The bus compressor is the backstop, but the gain law is what keeps
    it from being asked for 20dB of reduction on every dense frame.
  */
  const gain = (CHIME_GAIN / Math.sqrt(take));

  for (let k = 0; k < take; k++) {
    const i = fresh[Math.floor(k * step)];
    const row = Math.floor(i / gridWidth);
    const shapeIdx = shapes[i];
    if (shapeIdx < 0 || shapeIdx > 3) continue;
    const slot = assignments[SHAPES[shapeIdx]] ?? DEFAULT_ASSIGNMENTS[SHAPES[shapeIdx]];
    /*
      Stagger, scaled to the burst size.

      A fixed 4ms step was fine at 12 notes (48ms total). At 160 it would smear
      the frame across 640ms — longer than the chime itself, so cells would
      still be sounding when the NEXT frame's cells arrive, and the connection
      between seeing a dot appear and hearing it would be lost. Spreading the
      whole burst across ~50ms keeps it a single perceived event.
    */
    const at = audioNow + 0.005 + (k / take) * 0.05;
    playNote(
      rowToHz(row, gridHeight), slot.profile, gain * slot.level * 2,
      at, chimeDuration, context, bus,
    );
    chimeLastAt.set(i, now);
    // Book the voice so the next frame knows it is still sounding.
    chimeRingUntil.push(now + chimeDuration);
  }

  /*
    Sweep expired entries.

    This used to be guarded by `size > 8000`, which at 44x48 (2112 cells) could
    NEVER be true — so the sweep never ran, entries never expired, and the map
    became a permanent do-not-ring list. That was the bug behind all three
    reported symptoms: the chime dying after a few seconds, and invert going
    silent (it lights a different set of cells, every one of them already
    stamped).

    The threshold is now the CELL COUNT, so it scales with the grid instead of
    being a constant that outgrows it.
  */
  if (chimeLastAt.size > shapes.length) {
    for (const [k, t] of chimeLastAt) {
      if (now - t >= CHIME_COOLDOWN) chimeLastAt.delete(k);
    }
  }
}

/**
 * Stop immediately, including notes already scheduled but still ringing.
 *
 * Ramps the bus to zero over 10ms (a hard disconnect would click), then
 * detaches the whole chain once the fade lands.
 */
export function stop(): void {
  playing = false;
  // Drop the closure so a stale sweep's re-anchor cannot fire after teardown.
  liveSetRate = null;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;

  if (sequenceBus && ctx) {
    const t = ctx.currentTime;
    try {
      sequenceBus.gain.cancelScheduledValues(t);
      sequenceBus.gain.setValueAtTime(sequenceBus.gain.value, t);
      sequenceBus.gain.linearRampToValueAtTime(0, t + 0.01);
    } catch { /* ignore */ }

    const busToKill = sequenceBus;
    const compToKill = sequenceCompressor;
    const chainToKill = sequenceChain;
    setTimeout(() => {
      try { busToKill.disconnect(); } catch { /* ignore */ }
      for (const node of chainToKill) {
        try { node.disconnect(); } catch { /* ignore */ }
      }
      try { compToKill?.disconnect(); } catch { /* ignore */ }
    }, 20);

    // Null them so the next play() builds a fresh bus at full gain.
    sequenceBus = null;
    sequenceCompressor = null;
    sequenceChain = [];
  }
}
