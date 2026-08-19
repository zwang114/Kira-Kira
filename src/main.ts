/**
 * Living Specimen — v2 entry point.
 *
 * This file is now THIN BY DESIGN. It owns exactly two things:
 *   1. mounting the v2 `Screen` and the `SoundConfig` overlay,
 *   2. translating between the UI's vocabulary and the pipeline's.
 *
 * The pipeline itself lives in `session.ts` and has no DOM. Before this pass,
 * `main.ts` built its entire UI from one `innerHTML` template and interleaved
 * pipeline state with the widgets that displayed it, so the designed v2 UI —
 * which existed and was verified — was reachable only from `screens.html` with
 * mock data. Nothing was wrong with either stack; they had simply never met.
 *
 * PHASE MODEL. `Session` has two phases, `aiming` and `frozen`, matching
 * `Screen`'s `rest` and `captured`. The old third phase, `idle`, is gone: it
 * meant "camera not yet granted", which is a PRE-CONDITION, not a capture
 * state — the old code itself set `aiming` the moment the stream opened and
 * `idle` only on failure. It is represented here as `session.live`, driving a
 * separate start overlay, so the state machine has one axis instead of a mixed
 * one.
 *
 * GEOMETRY. This file computes NO pixel geometry. `Screen.draw(field, col)`
 * letterboxes the field against its own backing store and places the playhead
 * rule with the same `cell`/`ox` it drew the dots with (field.ts:81-96). The
 * old `computeGeometry` path is deliberately not used for playhead math — two
 * independent letterbox calculations would agree only by luck, and disagree
 * silently.
 */

import { clearMaskCache } from './mask/rasterizeGlyph';
import './ui/tokens.css';
import './ui/components.css';
/*
  `./style.css` is NOT imported, and must not be re-added.

  It is the v1 shell stylesheet. Every one of its class rules (`.shell`, `.top`,
  `.stage`, `.controls`, `.group`, `.row`, `.val`, `.hint`, `.seg`, `canvas#view`)
  matches ZERO elements in the v2 DOM — verified against the live app, not by
  reading. What survived were its bare-ELEMENT rules, which applied to every
  button v2 renders:

    button:disabled { opacity: 0.32 }

  `.large-dial__icon` and `.large-dial__speed` set `border` and `padding` but
  never `opacity`, so this was unopposed. The large dial is disabled until a
  capture exists — its DEFAULT state — so on every load the design's deliberate
  disabled treatment (fill darkens to `colour/dim`, marks lighten to `dim`, a
  measured 1.62:1) was composited down to **1.18:1**. The one screen every user
  sees first was the one it broke.

  It was also imported LAST, so its `:root` block overrode `tokens.css` and
  introduced a THIRD `--dim` (#6b6b6b) into a codebase where V3 §4.2 already
  flags `colour/dim` vs `dim` as a trap that cost real time.

  Nothing is lost: `components.css:232` already owns `text-transform: uppercase`
  on `.btn`, and `body { overflow: hidden }` moved to `index.html`'s shell, where
  the rest of the frame-level layout lives.
*/
import {
  loadFontFile, hasGlyph, isColorGlyph, FontLoadError, type LoadedFont,
} from './mask/loadFont';
import { Screen } from './ui/Screen';
import { SoundConfig } from './ui/SoundConfig';
import { Session, gridHeightFor } from './session';
import { hasMultipleCameras } from './camera/camera';
import * as audio from './audio/engine';

// ── Mount ──────────────────────────────────────────────────

const app = document.getElementById('app')!;
app.className = 'app-root';

/**
 * The camera-error overlay — the `idle` phase, demoted to a boolean.
 *
 * There is NO start-camera step: the app goes live on load, because the app is
 * a viewfinder and a gate in front of it asks the user to request the thing
 * they opened it for. This element therefore starts HIDDEN and appears only
 * when a stream cannot be obtained.
 *
 * It keeps a button because that is the one case where a button is genuinely
 * required: after a denied or dismissed permission prompt, a retry must
 * originate from a user gesture or `getUserMedia` rejects immediately.
 *
 * It sits over the stage rather than replacing it, so the mask preview stays
 * visible behind — the letterform is what the world is about to fill.
 */
const gate = document.createElement('div');
gate.className = 'gate is-hidden';
const gateBtn = document.createElement('button');
gateBtn.className = 'btn btn--filled gate__btn';
gateBtn.type = 'button';
gateBtn.textContent = 'Retry camera';
const gateMsg = document.createElement('p');
gateMsg.className = 'gate__msg';
gate.append(gateBtn, gateMsg);

const screen = new Screen({
  onCapture: () => { session.shutter(); },
  onBackToLive: () => { session.resumeAiming(); },
  onSoundOpen: () => openSound(),
  onParam: (name, value) => onParam(name, value),
  // The session owns play state; `onPlayStateChange` sets the dial's icon.
  onPlayToggle: () => { void session.play(); },
  // Loop and speed BOTH take effect mid-sweep — the engine re-reads them each
  // tick rather than capturing them at play() time, so latching loop or
  // cycling speed while the playhead is running changes the sweep in flight.
  onLoopToggle: (on) => session.setParam('loop', on),
  onSpeedChange: (x) => session.setSpeed(x),
  // Turning the dial face scrubs the playhead. This had NO handler at all —
  // the dial computed a position and emitted it into nothing.
  onScrub: (t) => session.scrubTo(t),
  /*
    The mask text changed — the user typed.

    Replaces the A-Z swipe. Text is an INVALIDATING param, so editing while a
    capture is frozen discards it and returns to live; `setParam` owns that and
    `Screen` blocks the input in the captured phase so it cannot happen by
    accident.
  */
  onTextChange: (text) => {
    session.setText(text);
    // The bar's readout is `aria-live`, so this both shows and announces it.
    screen.bar.setLetter(session.text);
  },
  /*
    Invert — utility bar, node 102:622.

    The SESSION owns the state; the button only reports taps and is driven back
    by `setInverted`. A button that flips its own icon would be a second source
    of truth for `params.invert`, which is the bug class this codebase has hit
    six times (V3 §7.7 pattern 1).

    Invert is INVALIDATING, so `setParam` discards a frozen capture — which is
    why `Screen.setPhase` disables the button while one exists. The `I` key path
    in the keydown handler below carries the same guard.
  */
  onInvertToggle: () => {
    session.setParam('invert', !session.params.invert);
    screen.bar.setInverted(session.params.invert);
  },
  /*
    Flip between the front and rear cameras.

    The session opens the new stream before dropping the old one, so a failure
    leaves a working viewfinder rather than a black stage. Mirroring follows
    automatically: `dither.ts` mirrors only when the open camera faces `user`,
    so the selfie view is preserved on the front camera and correctly absent on
    the rear.
  */
  onFlipCamera: () => { void session.flipCamera(); },
  /*
    Mute the aim chime — the sound newly-lit cells make while aiming. Scoped to
    that only: a capture's playhead sweep still sounds when played.

    The ENGINE holds the flag (it is the thing that has to check it per frame),
    and the button is driven from it, so there is one source of truth.
  */
  onChimeToggle: () => {
    audio.setChimeMuted(!audio.isChimeMuted());
    screen.bar.setChimeMuted(audio.isChimeMuted());
  },
  /*
    The letterform stencil. Off on load — the app opens as a plain dithered
    camera view and the letter is an explicit choice.

    INVALIDATING (`setParam` handles the discard), and `Screen.setPhase`
    disables the button while frozen so it cannot be hit by accident.
  */
  onMaskToggle: () => {
    session.setParam('masked', !session.params.masked);
    screen.bar.setMasked(session.params.masked);
  },
});

app.append(screen.el);
screen.el.querySelector('.screen__stage')!.appendChild(gate);

// ── Session ────────────────────────────────────────────────

/**
 * The reduced-motion check is read LIVE, not cached at module eval, so
 * toggling the OS setting takes effect without a reload.
 */
const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const session = new Session({
  // The single paint path. Live frames, the frozen capture and the mask
  // preview all arrive here, and all three are drawn by the same call — which
  // is what guarantees they share a letterbox.
  onFrame: (field, playhead) => {
    /*
      The struck-dot trail is gated on TWO conditions, both required.

      `playhead >= 0` — there is a sweep. The live viewfinder and the mask
      preview have no playhead and must not glow.

      `!prefersReducedMotion()` — WCAG 2.3.1. The trail is a moving luminance
      transient, and although it is engineered to sit under the small-safe-area
      threshold (see TRAIL_COLS in field.ts), the media query is a user saying
      "no moving luminance", which outranks a threshold calculation. With it on,
      the playhead rule alone marks position — the information survives, only
      the animation goes, which is this codebase's stated reduced-motion
      doctrine (components.css:1059).

      Read LIVE, not cached, so toggling the OS setting takes effect without a
      reload.
    */
    const trail = playhead >= 0 && !prefersReducedMotion();
    // Density is read from the session at paint time rather than captured in a
    // closure, so the ρ dial restyles the CURRENT frame — including a frozen
    // capture, where density is cosmetic and must not invalidate it.
    screen.draw(field, playhead, session.params.density, trail);
    // Painted AFTER the field so the wash sits over the dots, not under them.
    drawShutterFlash();
  },

  onPhase: (phase) => {
    screen.setPhase(phase === 'frozen' ? 'captured' : 'rest');
    syncDialToSession();
    // The flash drives its own rAF and repaints the capture; any exit from the
    // frozen phase must tear it down or a live loop races a stale ticker for
    // the same canvas.
    if (phase !== 'frozen') cancelShutterFlash();
  },

  onLive: (live) => {
    gate.classList.toggle('is-hidden', live);
    gateBtn.disabled = false;
    /*
      Re-check for a second camera once the stream is live.

      `enumerateDevices` is deliberately vague before permission is granted —
      some browsers report a single generic entry until then. Checking again
      here is when the answer is trustworthy, and it is why the flip button
      starts hidden and only ever appears: a control that shows up and then
      vanishes would be worse than one that arrives a moment late.
    */
    if (live) void hasMultipleCameras().then((many) => screen.setFlipAvailable(many));
  },

  onStatus: (msg, isError) => {
    // No status line in the v2 design — the readouts live on the dials. Errors
    // still need somewhere to go, so they surface on the gate.
    if (isError) {
      gateMsg.textContent = msg;
      gate.classList.remove('is-hidden');
    }
  },

  onProgress: (t) => screen.large.setPosition(t),
  onPlayStateChange: (playing) => screen.large.setPlaying(playing),
});
/*
  NO param overrides here on purpose.

  This used to pass `gridWidth: 44` "so the control and the pipeline agree at
  boot". That made THREE independent copies of the same number — this one,
  `DEFAULTS.gridWidth` in session.ts, and the RES dial's `value` in Screen.ts —
  agreeing only by coincidence, with nothing in the code tying them together.
  Two sources of truth for one piece of state is the failure mode behind more
  bugs in this codebase than any other (V4 §0 fact 6), and this was a live
  instance of it waiting for someone to change one of the three.

  The session's own DEFAULTS are now the single source. `syncDialsToSession()`
  below pushes them onto the dial faces at boot, so agreement is ENFORCED by
  code rather than maintained by three matching literals.
*/

/**
 * Push session transport state onto the dial.
 *
 * The dial holds its own `_speed` and `_looping`, so they can drift from the
 * session — the bug class that has bitten this codebase five times now. Rather
 * than sync on phase changes only (which leaves drift uncorrected between
 * transitions), every path that can change either value calls this.
 */
function syncDialToSession() {
  screen.large.setSpeed(session.speed);
  screen.large.setLooping(session.params.loop);
}

/**
 * Push session PARAMS onto the four mini dials.
 *
 * The same drift problem as `syncDialToSession`, one level down: each MiniDial
 * holds its own `v`, seeded from a literal in `Screen.ts`'s `defs` table, and
 * nothing ever reconciled it with the session. The faces happened to show the
 * right numbers only because the literals matched `session.ts`'s DEFAULTS by
 * hand — change a default in one place and the dial would confidently display
 * a value the pipeline was not using.
 *
 * `notify: false` on every call: this is a DISPLAY sync, and letting it fire
 * `onChange` would loop straight back into `setParam` and, for the
 * invalidating `gridWidth`, discard a frozen capture as a side effect of
 * merely refreshing the UI.
 *
 * Note `auto` is absent: the Auto Level rail is bipolar (−2…+2) and maps
 * non-linearly onto `autoLevel` (0…1) in `onParam`, so it has no inverse to
 * sync back through. Its detent IS the session default by construction — see
 * the mapping comment there.
 */
function syncDialsToSession() {
  screen.dials.exp?.set(session.params.exposure, false);
  screen.dials.cont?.set(session.params.contrast, false);
  screen.dials.res?.set(session.params.gridWidth, false);
  screen.dials.rho?.set(session.params.density, false);
}

// ── Params ─────────────────────────────────────────────────

/**
 * Dial key → pipeline parameter.
 *
 * `auto` arrives from the utility bar's Auto Level rail, which is bipolar
 * (−2…+2, UtilityBar.ts:60) while `dither.ts` clamps `autoLevel` to 0…1. Map
 * rather than pass through: the rail's centre detent is the design's "neutral",
 * and neutral for a partial autolevel is the documented 0.55 default, not 0.
 */
function onParam(name: string, value: number) {
  switch (name) {
    case 'exp':  session.setParam('exposure', value); break;
    case 'cont': session.setParam('contrast', value); break;
    case 'res':  session.setParam('gridWidth', Math.round(value)); break;
    case 'rho':  session.setParam('density', value); break;
    case 'auto': {
      // −2…+2 → 0…1, centred on 0.55 so the detent is the measured default.
      const t = value <= 0 ? (value + 2) / 2 * 0.55 : 0.55 + (value / 2) * 0.45;
      session.setParam('autoLevel', Math.min(1, Math.max(0, t)));
      break;
    }
  }
}

/*
  Transport. The SESSION is the single source of truth for play state, not the
  dial — `onPlayStateChange` above is what sets the dial's icon.

  This previously had two independent click handlers on one button: the dial
  flipped its own icon via `onPlayToggle`, and a second listener here called
  `session.play()`. `session.play()` is a TOGGLE (`if (audio.isPlaying())
  stopPlayback()`), so any double-delivery of one tap started playback and
  immediately stopped it — leaving a pause icon on a dial that was not
  playing, and no playhead. Routing the tap through `Screen`'s callback only,
  and letting the session drive the icon, removes the second truth.
*/
// (Loop and speed are wired through Screen's callbacks above. A second click
// listener here used to read `screen.large.looping`, which raced the dial's
// own toggle and sent the pre-toggle value.)

// ── Shutter flash ──────────────────────────────────────────

/**
 * The visual event that says "this frame is now an artifact".
 *
 * Preserved verbatim from v1, retargeted to the Screen's canvas. Held as a
 * TIMESTAMP, not a boolean, so it is impossible to stack: re-firing reseeds
 * `shutterFlashAt` and the single decay curve restarts. There is no additive
 * opacity and no second timer, so even if a key guard were defeated the worst
 * case is a flash held at constant brightness, never a brightening strobe.
 */
let shutterFlashAt = 0;
const SHUTTER_FLASH_MS = 180;
let shutterFlashRaf: number | null = null;

function drawShutterFlash() {
  if (!shutterFlashAt) return;
  const cv = screen.canvas;
  const ctx = cv.getContext('2d')!;
  const elapsed = performance.now() - shutterFlashAt;

  if (prefersReducedMotion()) {
    // No fade, no wash: a steady accent rule framing the stage for the same
    // duration. Confirms the capture without a luminance transient.
    if (elapsed > SHUTTER_FLASH_MS * 3) { shutterFlashAt = 0; return; }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(255,98,0,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cv.width - 6, cv.height - 6);
    ctx.restore();
    return;
  }

  if (elapsed >= SHUTTER_FLASH_MS) { shutterFlashAt = 0; return; }
  const t = elapsed / SHUTTER_FLASH_MS;
  // Fast attack, slower decay — a real shutter is not a symmetric triangle.
  const a = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  // Peak alpha 0.42, well under the WCAG 2.3.1 general-flash threshold for a
  // single non-repeating transient, and capped by the no-stacking rule above.
  ctx.fillStyle = `rgba(255,98,0,${(a * 0.42).toFixed(3)})`;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();
}

function cancelShutterFlash() {
  if (shutterFlashRaf !== null) cancelAnimationFrame(shutterFlashRaf);
  shutterFlashRaf = null;
  shutterFlashAt = 0;
}

/** Drive repaints for the flash's lifetime; a frozen capture has no rAF loop. */
function runShutterFlash() {
  shutterFlashAt = performance.now();
  if (shutterFlashRaf !== null) cancelAnimationFrame(shutterFlashRaf);
  const tick = () => {
    repaintCapture();
    if (shutterFlashAt) shutterFlashRaf = requestAnimationFrame(tick);
    else { shutterFlashRaf = null; repaintCapture(); }
  };
  shutterFlashRaf = requestAnimationFrame(tick);
}

/** Repaint the frozen capture — the flash ticker's only way to redraw. */
function repaintCapture() {
  const cap = session.currentCapture;
  if (!cap) return;
  // Density MUST be passed here too. `Screen.draw` defaults it to the 0.62
  // reference, so omitting it re-scaled every dot for the ~180ms the flash
  // ticker runs — a visible pop on every capture at any ρ but the default.
  screen.draw(cap.field, -1, session.params.density);
  drawShutterFlash();
}

// ── Keyboard ───────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  // Auto-repeat is never a deliberate second press.
  //
  // The hazard is NOT flash stacking — shutter() already returns early unless
  // the phase is 'aiming'. It is that Space TOGGLES: aiming → shutter() →
  // frozen, frozen → resumeAiming() → aiming. Holding Space therefore
  // oscillates the two phases at the OS key-repeat rate (~30Hz), repainting the
  // full stage each time. The result is a full-field black ↔ dot-grid inversion
  // flashing at ~30Hz — a large-area luminance strobe squarely in the 3Hz+
  // photosensitive-seizure band (WCAG 2.3.1).
  //
  // Guarded for the WHOLE handler rather than the shutter path alone: held
  // Enter re-enters playback and held I thrashes invert at the same rate, and a
  // guard on one key would leave the others as the same class of bug.
  if (e.repeat) return;

  const t = e.target as HTMLElement | null;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

  if (e.code === 'Space') {
    if (typing || !session.live) return;
    e.preventDefault();
    if (session.phase === 'aiming') { if (session.shutter()) runShutterFlash(); }
    else session.resumeAiming();
  } else if (e.code === 'Enter') {
    if (typing) (t as HTMLInputElement).blur();
    if (session.phase === 'frozen') { e.preventDefault(); void session.play(); }
  } else if (e.code === 'KeyI') {
    if (typing) return; // 'i' is a legitimate character to type
    // Invert is invalidating: it changes which cells are lit, so a frozen
    // capture cannot survive it and resumeAiming() throws it away. The other
    // invalidating controls are visible widgets the user is deliberately
    // touching; this is an unlabelled keystroke, so it is the one path where a
    // capture can be lost by a typo. Ignore it while frozen — Space is the
    // documented way back to live.
    if (session.phase === 'frozen') return;
    e.preventDefault();
    session.setParam('invert', !session.params.invert);
    // The key and the button are two routes to ONE piece of state, so the key
    // must drive the icon too — otherwise pressing `I` inverts the field while
    // the button still reads un-inverted.
    screen.bar.setInverted(session.params.invert);
  }
});

// The capture button goes through Screen's own handler, so the flash is hung
// off the same place the phase change is observed rather than duplicated.
screen.el.querySelector('.screen__capture')!.addEventListener('click', () => {
  if (session.phase === 'frozen') runShutterFlash();
});

// ── Sound config overlay ───────────────────────────────────

let sound: SoundConfig | null = null;

/**
 * Trailing debounce on the audition. A reel fires `onChange` per detent as it
 * spins, and one note per detent during a fast turn is a machine gun rather
 * than a preview. Long enough to swallow a spin, short enough that a
 * deliberate single step still feels immediate.
 */
const PREVIEW_DEBOUNCE_MS = 120;
let previewTimer: number | null = null;

/**
 * The chime's mute state BEFORE the Sound Config screen took over, so closing
 * the screen restores what the user had rather than unmuting for them.
 */
let chimeMutedBeforeSound = false;

function openSound() {
  if (sound) return;
  /*
    SILENCE THE APP WHILE THE SOUND SCREEN IS OPEN.

    The screen's whole job is auditioning voices, and it cannot do that over
    the top of the aim chime firing hundreds of notes a second at the same
    bus — the preview would be buried in the thing it is supposed to let you
    hear. An in-flight playback sweep is stopped for the same reason.

    The chime's own mute state is REMEMBERED, not overwritten: a user who had
    it on gets it back on close, and one who had it off is not surprised by
    sound appearing.
  */
  chimeMutedBeforeSound = audio.isChimeMuted();
  audio.setChimeMuted(true);
  session.stopPlayback();

  sound = new SoundConfig({
    // Seeded from the session, not from the overlay's own defaults, so
    // reopening the panel shows what was last saved rather than resetting to
    // the design's baseline. The session hands out a copy, so the overlay's
    // internal edits cannot reach the live map until Save.
    //
    // `voiceAssignmentIds`, NOT `voiceAssignments`: the overlay speaks in
    // `sp1..sp4` ids and saves them back. Seeding it with resolved voice names
    // made every save fail validation and silently drop the user's levels.
    assignments: session.voiceAssignmentIds,
    onSave: (a) => {
      // The whole point of the pass: the overlay's per-shape profile + level
      // reach the scheduler. `setVoiceAssignments` resolves the `sp1..sp4` ids
      // to synthesis voices and rejects unknown ones at the boundary.
      session.setVoiceAssignments(a);
      closeSound();
    },
    // Exit discards by construction: nothing was written to the session, and
    // the overlay object is thrown away with its edits.
    onExit: () => closeSound(),
    // Audition. This hook existed and was fired in two places, but was never
    // passed in — so the screen that exists to choose sounds made none.
    // Debounced because a reel re-seats per detent while spinning; without it
    // a fast turn fires a preview per letter of travel.
    onPreview: (shape, profileId) => {
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = null;
        session.previewShape(shape, profileId);
      }, PREVIEW_DEBOUNCE_MS);
    },
  });
  sound.el.classList.add('sound-overlay');
  app.appendChild(sound.el);
}

function closeSound() {
  // Drop any queued audition, or a preview fires ~120ms into a screen the
  // user has already dismissed.
  if (previewTimer !== null) { clearTimeout(previewTimer); previewTimer = null; }
  // Stop any audition still ringing, so the screen does not leave a tail
  // behind it.
  audio.stop();
  // Restore the user's own chime setting — see `chimeMutedBeforeSound`.
  audio.setChimeMuted(chimeMutedBeforeSound);
  screen.bar.setChimeMuted(audio.isChimeMuted());
  sound?.el.remove();
  sound = null;
}

// ── Font loading ───────────────────────────────────────────

// Must match `DEFAULTS.fontFamily` in session.ts — see the note there for why
// the mask face is condensed.
// Must match `DEFAULTS.fontFamily` in session.ts — the bundled mask face.
const SYSTEM_FAMILY = '"Impression Mask", "Helvetica Neue", Helvetica, Arial, sans-serif';
let loadedFont: LoadedFont | null = null;

const fontFile = document.createElement('input');
fontFile.type = 'file';
fontFile.accept = '.otf,.ttf,.ttc,.woff,.woff2,font/*';
fontFile.style.display = 'none';
app.appendChild(fontFile);

fontFile.addEventListener('change', async () => {
  const file = fontFile.files?.[0];
  fontFile.value = ''; // so re-picking the same file fires 'change' again
  if (!file) return;
  try {
    const font = await loadFontFile(file);
    loadedFont = font;
    // Loaded faces have their own weights; asking for 700 on a font with no
    // bold makes the browser synthesize a smeared fake bold, which ruins the
    // mask edges. Use the face as designed.
    session.setFont(`"${font.family}"`, 400);
    checkGlyphCoverage();
  } catch (err) {
    const msg = err instanceof FontLoadError ? err.message : String(err);
    gateMsg.textContent = msg;
  }
});

/**
 * Warn when the current character isn't in the loaded font. The browser
 * silently substitutes a fallback, so without this the mask looks plausible
 * while being a completely different typeface.
 */
function checkGlyphCoverage() {
  if (!loadedFont) return;
  const ch = session.params.char;
  if (!hasGlyph(loadedFont.family, ch)) {
    gateMsg.textContent =
      `“${ch}” isn’t in ${loadedFont.fileName}; the browser is substituting another face.`;
  } else if (isColorGlyph(loadedFont.family, ch)) {
    // Passed the load-time probe but this glyph is a bitmap — thresholding it
    // produces a blocky rectangle, not a letterform.
    gateMsg.textContent =
      `“${ch}” is a color glyph; the mask will be its bitmap outline, not a letterform.`;
  }
}

// ── Boot ───────────────────────────────────────────────────

gateBtn.addEventListener('click', () => {
  gateBtn.disabled = true;
  gateMsg.textContent = '';
  session.startCameraStream().catch(() => { /* reported via onStatus */ });
});

window.addEventListener('pagehide', () => session.dispose());

/**
 * Fonts first. A mask rasterized before the webfont resolves would be measured
 * against a fallback face and silently come out as the wrong letterform.
 *
 * Then go live immediately. There is no "start camera" step: the app IS the
 * viewfinder, and a gate in front of it makes the user ask for the thing they
 * already opened the app to do.
 *
 * The gate element survives as the ERROR surface only. `onLive` hides it the
 * moment a stream arrives, and `onStatus` reveals it again with a message and
 * a working retry button if permission is denied, dismissed, or the device is
 * unavailable — which is the one case where a button genuinely is needed,
 * because a second `getUserMedia` call must come from a user gesture.
 */
// Seed the UI from the session so neither starts out of step.
screen.bar.setLetter(session.text);
screen.setText(session.text);
/*
  The aim chime starts MUTED.

  It is ambient sound that would otherwise begin the moment the camera opens,
  before the user has asked for anything. Starting silent makes it opt-in, and
  the button carries the state so it is visible rather than hidden.
*/
audio.setChimeMuted(true);
screen.bar.setChimeMuted(audio.isChimeMuted());
// The mask defaults off (session DEFAULTS), so seed the icon from the session
// rather than assuming — one source of truth.
screen.bar.setMasked(session.params.masked);
syncDialToSession();
// …and the four mini dials, for the same reason: the session's DEFAULTS are
// the single source, the dial faces are a view of them.
syncDialsToSession();

/*
  Unlock the AudioContext, and put iOS into a session category that IGNORES THE
  RINGER SWITCH.

  Two separate problems solved by one gesture handler.

  1. THE CONTEXT. The aim chime plays during live view, before the user has
     pressed play or captured anything, but `AudioContext` starts suspended and
     only `resume()` from inside a gesture handler unlocks it. Not `once: true`:
     `resume()` can reject if the browser does not consider that particular
     gesture qualifying, the OS can suspend the context again on a tab switch,
     and granting camera permission through Safari's own prompt is not a page
     gesture at all — which is exactly the "no sound on load" case. So: listen
     persistently, and no-op cheaply once running.

  2. THE RINGER SWITCH — the one most likely to read as "the app is broken".
     iOS gives a bare `AudioContext` the `ambient` audio-session category, which
     OBEYS the hardware mute switch. With the ringer off the user hears nothing
     at all, and there is no signal: no error, no state change, `ctx.state` is
     `running` and `currentTime` advances normally.

     There is no Web Audio API for the session category. The reliable lever is
     to have a real `<audio>` element playing, which promotes the session to
     `playback` and takes Web Audio with it. It must NOT be `muted` — a muted
     element does not promote the category, which is why `camera.ts`'s muted
     video does not already solve this. A near-silent looping tone at a level
     nobody can hear is the workaround.

     This is INFERRED from WebKit's documented session behaviour, not measured —
     it cannot be tested from a desktop browser. If it turns out not to work on
     a given iOS version, the ringer switch is still the first thing to check.
*/

/** A one-second, near-silent WAV. Not zero: some WebKit versions ignore a
 *  completely silent track when deciding the session category. */
const SILENT_WAV = (() => {
  const rate = 8000, secs = 1, n = rate * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  // Amplitude 1/32768 — inaudible, but not digital silence.
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
})();

const sessionKeeper = document.createElement('audio');
sessionKeeper.src = SILENT_WAV;
sessionKeeper.loop = true;
// `setAttribute`, not the property: `playsInline` is typed on HTMLVideoElement
// only, but iOS reads the ATTRIBUTE on audio elements too.
sessionKeeper.setAttribute('playsinline', '');
// Deliberately NOT `muted` — see above. Volume is low but non-zero.
sessionKeeper.volume = 0.01;
sessionKeeper.setAttribute('aria-hidden', 'true');
// IN THE DOM, not just constructed. A detached media element does not reliably
// promote the iOS audio session category — the entire point of this element.
sessionKeeper.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
app.appendChild(sessionKeeper);

const unlockAudio = () => {
  if (sessionKeeper.paused) {
    void sessionKeeper.play().catch(() => { /* not a qualifying gesture yet */ });
  }
  if (audio.isRunning()) return;
  void audio.getCtx().catch(() => { /* browser wants a different gesture */ });
};
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click'] as const) {
  window.addEventListener(ev, unlockAudio, { passive: true });
}
/*
  Backgrounding: stop working, and come back cleanly.

  On a phone this is routine — a call arrives, the user switches apps, the
  screen locks. Three things went wrong before this existed:

  1. The camera kept streaming and the frame loop kept dithering in the
     background, burning battery for a view nobody can see.
  2. On return, the chime diffed the first new frame against a grid captured
     minutes earlier. Every currently-lit cell read as newly-appeared and fired
     at once — measured at 232 oscillators against 0 in steady state.
  3. iOS can INTERRUPT rather than suspend an AudioContext (a WebKit-specific
     state), and nothing re-opened it.

  Suspending the context on hide is what actually stops audio cost; pausing the
  frame loop stops the rest. `resetChime()` plus clearing the previous frame
  means the first frame back takes the SEED path in `chimeNewCells` — recorded
  as a baseline, silent — so the field re-enters quietly.
*/
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    session.suspendForBackground();
    void audio.suspend();
    sessionKeeper.pause();
  } else {
    unlockAudio();
    session.resumeFromBackground();
  }
});

/*
  BOOT: the mask face must be LOADED before the first rasterization, and
  `document.fonts.ready` is not sufficient to guarantee that.

  `fonts.ready` resolves when all *pending* loads settle. With `font-display:
  block` and no DOM node yet using 'Impression Mask', the browser has not
  STARTED fetching it at boot — so there is nothing pending, `ready` resolves
  immediately, and `status` reports "loaded" while the face is genuinely
  absent. Measured in a fresh document: at `fonts.ready`, `fonts.check('500
  16px "Impression Mask"')` is FALSE and 'A' measures 66.7px — byte-identical
  to the Helvetica fallback (52.2px once the face is really there).

  The visible symptom was a letterform that did not match the rest of the
  alphabet: rasterized against Helvetica, A came out 38 cells wide against
  B and H at 34 and 36; with Oswald all three are 26. It then appeared to
  "fix itself" the moment you touched the RES dial, because that re-rasterizes
  after the font has since arrived — two symptoms, one cause.

  This is the same class as the iOS bug in V4 §4.2 (a silently substituted
  mask face) and the trap named in §10 ("`document.fonts.check` returns false
  before first use — `await document.fonts.load(...)` first").

  `load()` is what actually kicks off the fetch. The `catch` keeps a font
  failure from stranding the app with no camera: a wrong-looking mask beats a
  black screen.
*/
Promise.resolve()
  .then(() => document.fonts.load('500 100px "Impression Mask"'))
  .catch(() => { /* fall through to the fallback face rather than never booting */ })
  .then(() => document.fonts.ready)
  .then(() => {
    /*
      Drop any mask rasterized before the face arrived.

      `getGlyphMask` memoises on (char, family, weight, geometry) — none of
      which change when a font finishes loading, so a mask built against the
      fallback would be served for the rest of the session and the letter would
      stay wrong until the user happened to change the letter or resolution.
      Nothing should rasterize this early, but the cost of being wrong is a
      permanently misshapen letterform against ~10ms of re-raster, so clear it
      unconditionally rather than reasoning about ordering.
    */
    clearMaskCache();
    session.previewMask();
    session.startCameraStream().catch(() => { /* reported via onStatus */ });
  });

/*
  OFFLINE: register the service worker.

  What this buys: after one load, the app runs with NO network at all — the
  Mac asleep, the phone on cellular, airplane mode. The camera and the audio
  are entirely local, so once the JS, CSS and the two fonts are on the device
  there is genuinely nothing left to fetch. Without it the home-screen icon is
  just a bookmark pointing at a laptop, and the app dies the moment the dev
  server stops.

  PRODUCTION ONLY, and that is not caution — it is required. `sw.js` is
  generated from `dist/` and precaches CONTENT-HASHED filenames that exist
  only in a build. In dev, Vite serves unhashed modules that change on every
  save, so a worker would serve stale code and every edit would appear to do
  nothing. `import.meta.env.PROD` is false under `vite dev` and true in the
  built bundle, so this whole block vanishes from the dev path.

  Registration is deliberately LAST and non-blocking: a failure here must cost
  offline support and nothing else. The camera, the audio and the render are
  all unaffected by it, so it is caught and ignored rather than surfaced.
*/
/*
  `import.meta.env` is a Vite injection, not a standard `ImportMeta` member,
  and this project does not pull in `vite/client` ambient types (tsconfig has
  no `types` entry). Narrowing through `unknown` keeps the check honest —
  `PROD` is statically replaced with `true`/`false` at build time, so this
  whole branch is eliminated from the dev bundle either way.
*/
const isProd = (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true;
if (isProd && 'serviceWorker' in navigator) {
  const registerSW = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* No offline support this session. The app is otherwise unaffected. */
    });
  };
  /*
    Register on `load` — but ONLY if `load` has not already fired.

    Deferring to `load` keeps the worker from competing with the camera and
    the first paint for bandwidth. The catch is that `addEventListener` on an
    event that has ALREADY fired never runs: on a fast local load, a warm
    cache, or a bfcache restore, `document.readyState` is already `complete`
    by the time this module executes, and the registration would be skipped
    silently, forever. Measured exactly that against the production build on
    127.0.0.1 — readyState `complete`, secure context true, worker never
    registered — so the readyState branch is load-bearing, not defensive.
  */
  if (document.readyState === 'complete') registerSW();
  else window.addEventListener('load', registerSW, { once: true });
}

// Exposed for the synthetic-webcam harness described in HANDOFF §11 — a real
// camera is unavailable in a preview browser, and this is the only way to
// exercise the real pipeline end to end.
(window as unknown as Record<string, unknown>).__session = session;
(window as unknown as Record<string, unknown>).__screen = screen;
(window as unknown as Record<string, unknown>).__audio = audio;
(window as unknown as Record<string, unknown>).__runShutterFlash = runShutterFlash;
(window as unknown as Record<string, unknown>).__fontPicker = () => fontFile.click();
(window as unknown as Record<string, unknown>).SYSTEM_FAMILY = SYSTEM_FAMILY;
(window as unknown as Record<string, unknown>).__gridHeightFor = gridHeightFor;
