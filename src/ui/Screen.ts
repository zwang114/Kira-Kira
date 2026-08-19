/**
 * The app screen — the four screens on Figma page 63:6427:
 *   63:6443  Rest                      63:6462  Rest, auto level open
 *   63:6429  captured                  63:6436  captured, auto level open
 *
 * 390 x 810, three stacked bands:
 *   stage          390 x 496   the letter, full-bleed
 *   utility bar    390 x 40    aperture / auto-level / sound
 *   control group  390 x 274   16px inset; controls row + capture button
 *
 * Control group layout (node 62:5377): a 358px row, large dial on the left,
 * a 166px 2x2 grid of mini dials on the right, 16px column / 20px row gap.
 * Capture button sits 202px down, 358 x 56.
 *
 * STAGE PADDING IS THE SAME IN ALL FOUR SCREENS. A prior audit claimed Rest
 * used px-24/py-25 with aspect 358/449 and captured used px-24/py-16 with
 * aspect 342/428.93. Both halves of that claim are wrong:
 *   - 358/449 and 342/428.933 are the SAME RATIO (342 x 449/358 = 428.933),
 *     just two spellings of it.
 *   - The vector is width-constrained by px-24 (390 - 48 = 342), so its height
 *     is 428.933 and the leftover 33.533px splits evenly top and bottom. The
 *     py value is never reached and cannot affect the render.
 * get_metadata confirms it: the Vector is at x=24, y=33.5335, 342 x 428.9330 in
 * 63:6445, 63:6431, 63:6464 AND 63:6438 alike, and three of the four exported
 * SVGs are byte-identical (md5 18e4e558…, viewBox "0 0 342 428.933"). So the
 * stage needs no per-phase rule — `aspect-ratio` on the letter box does it all.
 */

import { MiniDial } from './MiniDial';
import { LargeDial } from './LargeDial';
import { UtilityBar } from './UtilityBar';
import { MAX_CHARS, MAX_LINES } from '../mask/rasterizeGlyph';
import { icon } from './icons';
import { renderField, type Field } from './field';

export type Phase = 'rest' | 'captured';

export interface ScreenOptions {
  onCapture?: () => void;
  onBackToLive?: () => void;
  onSoundOpen?: () => void;
  onParam?: (name: string, value: number) => void;
  /** Start with the Auto Level panel open — screens 63:6462 / 63:6436. */
  autoLevelOpen?: boolean;
  /**
   * Play/pause tapped. Supplying this makes the OWNER responsible for the
   * dial's lit state: drive it from the transport via `screen.large
   * .setPlaying()`, so the icon reflects what is actually sounding. Omit it
   * and the dial toggles itself, which is right for a standalone gallery.
   */
  onPlayToggle?: () => void;
  /** Loop latched on or off. Receives the NEW value. */
  onLoopToggle?: (on: boolean) => void;
  /** Speed cycled. 1x = the 3-second sweep, so 2x = 1.5s and 3x = 1s. */
  onSpeedChange?: (x: 1 | 2 | 3) => void;
  /** The dial face was turned. `t` is 0..1 across the sweep. */
  onScrub?: (t: number) => void;
  /** The mask text changed. Fires on every keystroke, already length-clamped. */
  onTextChange?: (text: string) => void;
  /** Invert tapped in the utility bar. */
  onInvertToggle?: () => void;
  /** Flip camera tapped. Only reachable while aiming and with two cameras. */
  onFlipCamera?: () => void;
  /** Chime mute tapped in the utility bar. */
  onChimeToggle?: () => void;
  /** Letter mask toggled in the utility bar. */
  onMaskToggle?: () => void;
}


export class Screen {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly large: LargeDial;
  readonly bar: UtilityBar;
  readonly dials: Record<string, MiniDial> = {};
  private textInput!: HTMLTextAreaElement;
  /** Mirrors the session's `masked` param — the keypad is pointless without it. */
  private maskOn = false;

  private captureBtn: HTMLButtonElement;
  private flipBtn!: HTMLButtonElement;
  /** Does this device have a second camera to flip to? */
  private flipAvailable = false;
  private phase: Phase = 'rest';
  private o: ScreenOptions;
  /** Last painted field, so a resize can repaint rather than blank. */
  private lastDraw:
    { field: Field; playhead: number; density: number; trail: boolean } | null = null;

  constructor(opts: ScreenOptions = {}) {
    this.o = opts;

    const el = document.createElement('div');
    el.className = 'screen';

    // ── stage ────────────────────────────────────────────
    const stage = document.createElement('div');
    stage.className = 'screen__stage';
    /*
      The stage is FOCUSABLE and takes arrow keys.

      This is not decoration: it is the app's WCAG 2.1.1 compliance for letter
      selection. The ‹ A › buttons in the utility bar used to carry it, and
      they were removed to make room for the invert icon — so the obligation
      moved here. Swiping is a gesture that keyboard, switch-access and
      voice-control users cannot perform, and screen readers consume
      single-finger drags for exploration, so without this A-Z would be
      unreachable for them entirely.

      `group` rather than `application`: it holds a canvas and a gesture
      surface, not a widget with its own interaction model.
    */
    /*
      TAP THE STAGE TO TYPE.

      The mask is typed text now, so the stage's job is to summon a keyboard and
      hand keystrokes to a hidden field. The field is invisible rather than a
      visible box because the stage IS the subject — a text input sitting over
      the viewfinder would compete with the thing it edits.

      A11y: the textarea is a real focusable form control with a label, so
      keyboard, switch-access and screen-reader users reach the text directly.
      That is a straight improvement on the swipe it replaces, which those users
      could not perform at all — the arrow-key fallback that used to live here
      existed precisely because a gesture is not accessible, and a focusable
      input makes it unnecessary.
    */
    const canvas = document.createElement('canvas');
    canvas.className = 'screen__canvas';
    // The backing store is NOT set here. It is driven by `syncCanvas()` from a
    // ResizeObserver, because the stage height is elastic (see the clamp in
    // `index.html`) and a constant cannot track a box that changes at runtime.
    stage.appendChild(canvas);

    const input = document.createElement('textarea');
    input.className = 'screen__text-input';
    input.setAttribute('aria-label', 'Mask text');
    input.maxLength = MAX_CHARS;
    input.rows = 3;
    /*
      iOS would otherwise capitalise the first letter, autocorrect the word into
      something else, and offer spelling suggestions over the viewfinder. The
      text is a design decision, not prose — every one of those transformations
      is wrong here. `autocapitalize=off` matters especially now that lowercase
      is typeable and meaningful.
    */
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    /*
      MAKE RETURN INSERT A NEWLINE, not dismiss the keyboard.

      iOS decides what its return key DOES from `enterkeyhint`, and with the
      attribute absent it frequently resolves to "done" — the key is labelled
      return, but pressing it blurs the field and closes the keyboard instead of
      breaking the line. Reported exactly that way: "it doesn't actually make a
      hard return, it just closes the keyboard".

      `enter` is the value that means "insert a line break", which is what a
      multi-line mask needs: Enter is how the user forces KIRA / KIRA onto two
      lines rather than letting it wrap.

      Nothing in this app calls `preventDefault` on Enter (verified), so once
      iOS stops treating the key as a dismissal the textarea's own default
      behaviour inserts the newline.
    */
    input.setAttribute('enterkeyhint', 'enter');

    /*
      REFUSE THE LINE BREAK THAT WOULD NOT RENDER.

      `wrapText` caps the render at MAX_LINES, so a fourth line is silently
      dropped — the character appears in the field, the canvas ignores it, and
      nothing says why. Blocking the keystroke makes the ceiling something the
      user can feel instead of something that fails quietly behind them.

      Only a NEW break is refused: Enter still works normally while there is
      room, and every other key is untouched.
    */
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const lines = input.value.split('\n').length;
      if (lines >= MAX_LINES) e.preventDefault();
    });
    /*
      NOT autofocused, deliberately. Focusing on load pops the phone keyboard
      over the stage before the user has seen the app — the first thing they
      would meet is a keyboard covering a viewfinder they never asked to edit.
      The keyboard appears only on a deliberate tap.
    */
    this.textInput = input;
    stage.appendChild(input);

    input.addEventListener('input', () => {
      // Clamp here too: paste, dictation and autocorrect can all exceed
      // `maxLength`, which the UA enforces only for typed keys.
      if (input.value.length > MAX_CHARS) input.value = input.value.slice(0, MAX_CHARS);
      /*
        The field may be emptied freely — clearing it to retype is normal
        editing. The SESSION decides what the canvas shows, and keeps rendering
        the last inked text while the field is empty, so the board never goes
        blank. Restoring the value here (an earlier attempt) made the last
        character undeletable.
      */
      this.o.onTextChange?.(input.value);
    });

    /*
      TAP TO TYPE — and the focus() must happen INSIDE the gesture.

      iOS only opens the keyboard when `focus()` is called synchronously from a
      genuine user-gesture handler. The first version focused on `pointerup`
      from a DOCUMENT-level listener, which is one step removed from the
      gesture; every desktop browser accepted it and iOS silently ignored it —
      the tap registered, the element focused, and no keyboard appeared.

      `click` is the safest signal here: the UA synthesises it only for a real
      tap (it already applies its own movement and timing rules), it is
      unambiguously a user gesture, and it fires on the element rather than the
      document. A pointermove threshold still suppresses drags, because the
      stage is also a scrub surface and a drag ending on it must not summon a
      keyboard.
    */
    let moved = false;
    let downAt: { x: number; y: number } | null = null;
    const TAP_SLOP_PX = 10;
    stage.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      moved = false;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      if (Math.abs(e.clientX - downAt.x) > TAP_SLOP_PX ||
          Math.abs(e.clientY - downAt.y) > TAP_SLOP_PX) moved = true;
    });
    stage.addEventListener('click', () => {
      const wasDrag = moved;
      downAt = null;
      moved = false;
      if (wasDrag) return;
      /*
        NO KEYBOARD WHEN THE MASK IS OFF.

        With the stencil off there is no letterform on screen — the stage is a
        plain dithered camera view and the text edits nothing visible. Opening
        a keyboard over it would be answering a question the user did not ask.
      */
      if (!this.maskOn) return;
      // Text is INVALIDATING: editing while frozen would discard the capture
      // silently. Every other invalidating control is disabled in this phase,
      // and a tap cannot be greyed out — so it is ignored instead.
      if (this.phase === 'captured') return;
      input.focus();
    });

    // ── utility bar ──────────────────────────────────────
    this.bar = new UtilityBar({
      onSoundOpen: () => this.o.onSoundOpen?.(),
      onAutoLevel: (v) => this.o.onParam?.('auto', v),
      onInvertToggle: () => this.o.onInvertToggle?.(),
      onChimeToggle: () => this.o.onChimeToggle?.(),
      onMaskToggle: () => this.o.onMaskToggle?.(),
    });

    // ── control group ────────────────────────────────────
    const group = document.createElement('div');
    group.className = 'screen__controls';

    const row = document.createElement('div');
    row.className = 'controls-row';

    this.large = new LargeDial({
      // If an owner supplies `onPlayToggle`, IT owns play state and is
      // responsible for calling `large.setPlaying()` — the dial must not also
      // flip itself, or the icon and the transport become two sources of
      // truth that drift apart. Falling back to the self-toggle keeps the
      // component usable standalone (components.html, screens.html).
      onPlayToggle: () => {
        if (this.o.onPlayToggle) this.o.onPlayToggle();
        else this.large.setPlaying(!this.large.playing);
      },
      // Loop is a LATCHING toggle the dial owns outright — flip it here, then
      // tell the owner the NEW value. Reading `large.looping` from a separate
      // click listener raced this toggle and sent the stale state.
      onLoopToggle: () => {
        this.large.setLooping(!this.large.looping);
        this.o.onLoopToggle?.(this.large.looping);
      },
      // The dial cycles 1x→2x→3x itself and reports the resulting multiplier.
      onSpeedChange: (x) => this.o.onSpeedChange?.(x),
      onScrub: (t) => this.o.onScrub?.(t),
    });

    const grid = document.createElement('div');
    grid.className = 'controls-grid';

    const defs: Array<[string, ConstructorParameters<typeof MiniDial>[0]]> = [
      ['exp',  { label: 'EXP',  min: -2,   max: 2, value: 0 }],
      ['cont', { label: 'CONT', min: 0,    max: 1, value: 0.30, format: v => v.toFixed(2) }],
      ['res',  { label: 'RES',  min: 20,   max: 60, value: 44, step: 2, format: v => String(Math.round(v)) }],
      // ρ is DENSITY — the dot fill ratio. Figma draws the label parenthesised
      // as `(ρ)` in every screen (62:4971); the key stays `rho`.
      ['rho',  { label: '(ρ)',  min: 0.15, max: 1, value: 0.62, format: v => v.toFixed(2) }],
    ];
    for (const [key, cfg] of defs) {
      const d = new MiniDial({ ...cfg, onChange: (v) => this.o.onParam?.(key, v) });
      this.dials[key] = d;
      grid.appendChild(d.el);
    }

    row.append(this.large.el, grid);

    /*
      The capture row — Figma 106:778.

      Two buttons in a 16px-gap row: a 56px square OUTLINED flip button and the
      FILLED capture button, which is `flex: 1 0 0` and takes the rest.

      In the captured state (63:6429) the flip button is GONE and capture is a
      single full-width 358px button. Hidden rather than disabled, per the
      design and the user's instruction — it is also invalidating, so hiding it
      removes the question rather than answering it.
    */
    const captureRow = document.createElement('div');
    captureRow.className = 'screen__capture-row';

    this.flipBtn = document.createElement('button');
    this.flipBtn.className = 'btn btn--outlined screen__flip';
    this.flipBtn.type = 'button';
    this.flipBtn.innerHTML = icon('flip');
    this.flipBtn.setAttribute('aria-label', 'Flip camera');
    // Hidden until the owner confirms more than one camera exists — see
    // `setFlipAvailable`. Most laptops have one, and a button that cannot do
    // anything is worse than no button.
    this.flipBtn.hidden = true;
    this.flipBtn.addEventListener('click', () => this.o.onFlipCamera?.());

    this.captureBtn = document.createElement('button');
    this.captureBtn.className = 'btn btn--filled screen__capture';
    this.captureBtn.type = 'button';
    this.captureBtn.innerHTML = icon('camera');
    this.captureBtn.setAttribute('aria-label', 'Capture');
    this.captureBtn.addEventListener('click', () => {
      if (this.phase === 'rest') this.o.onCapture?.();
      else this.o.onBackToLive?.();
    });

    captureRow.append(this.flipBtn, this.captureBtn);
    group.append(row, captureRow);
    el.append(stage, this.bar.el, group);

    this.el = el;
    this.canvas = canvas;
    this.setPhase('rest');

    /*
      Keep the backing store in step with the CSS box.

      THREE triggers, deliberately redundant:

      1. `ResizeObserver` — the correct mechanism, and the only one that catches
         a box change with no window event behind it (the `--screen-h` clamp
         resolving, a container query, zoom).
      2. `window.resize` — a fallback, because ResizeObserver callbacks are
         delivered through the rendering pipeline, and in the preview browser
         that pipeline is throttled to ~0 (V3 §0 fact 3, §8). Measured there: a
         fresh observer on a mounted, visible, correctly-sized canvas fired ZERO
         times in 400ms even with rAF shimmed. Without this line the feature is
         unverifiable in the one environment available for verifying it.
      3. A direct call below, plus one after layout settles.

      Redundant triggers are safe: `syncCanvas` early-returns when the size is
      already correct, so extra calls cost one comparison.
    */
    new ResizeObserver(() => this.syncCanvas()).observe(canvas);
    window.addEventListener('resize', () => this.syncCanvas());
    // The element is not in the document yet (main.ts appends it after
    // construction), so clientWidth/Height are 0 here and this early-returns.
    // It is kept for the case where a caller mounts before constructing.
    this.syncCanvas();
    // Runs after the current task, by which point main.ts has appended `el`.
    // This is what actually seeds the backing store on first paint.
    queueMicrotask(() => this.syncCanvas());
    setTimeout(() => this.syncCanvas(), 0);
  }

  /**
   * Seed the hidden input from the session.
   *
   * Called once at boot so the field already holds the default text. Without
   * it the first keystroke would replace KIRA/KIRA/KIRA wholesale, because the
   * input would have started empty while the mask displayed text.
   */
  setText(text: string) { if (this.textInput) this.textInput.value = text; }

  /**
   * Mirror the session's mask state.
   *
   * Drives the utility-bar icon AND the tap-to-type gate, from one call, so the
   * icon and the keypad can never disagree about whether the stencil is on.
   * Callers must use this rather than `screen.bar.setMasked` directly — routing
   * around it would leave `maskOn` stale and the keyboard would open over a
   * stage with no letterform on it.
   */
  setMasked(on: boolean) {
    this.maskOn = on;
    this.bar.setMasked(on);
  }

  setPhase(p: Phase) {
    this.phase = p;
    this.el.classList.toggle('is-captured', p === 'captured');
    // The large dial is inert until a capture exists — requirement 9.
    this.large.setEnabled(p === 'captured');

    /*
      Controls that cannot act on a frozen capture go inert while it exists.

      The three-way split is V3 §3.3, and it is not arbitrary — it follows from
      what a capture actually STORES. A capture holds which cells are lit and
      each cell's shape. So:

        INVALIDATING  res (gridWidth), and the letter — they change WHICH CELLS
                      ARE LIT, which cannot be re-derived from stored booleans.
                      v1 handled this by silently discarding the capture and
                      returning to live: four identical-looking dials, one of
                      which threw your photograph away with no warning, and
                      `onStatus` surfaces only errors so nothing was said.
        LIVE-ONLY     exp, cont, auto level — they affect the NEXT camera frame.
                      Against a frozen grid they are simply no-ops, so leaving
                      them live invites the user to turn a dial that does
                      nothing.
        COSMETIC      rho (density) — genuinely restyles a capture in place, so
                      it STAYS LIVE. This is the one dial that still works, and
                      that is the point: the user can still change how the
                      capture looks.

      Disabling rather than warning reuses the language the large dial already
      speaks in the opposite direction, so the class boundary is discoverable by
      looking instead of by losing work.
    */
    const frozen = p === 'captured';
    this.dials.res?.setEnabled(!frozen);
    this.dials.exp?.setEnabled(!frozen);
    this.dials.cont?.setEnabled(!frozen);
    // rho stays enabled in both phases — cosmetic, applies to a capture.
    this.bar.setAutoLevelEnabled(!frozen);
    // Invert and the mask are both INVALIDATING — same class as res and the
    // letter. Either can be set freely before a capture; neither can change
    // after one is frozen without discarding it.
    this.bar.setInvertEnabled(!frozen);
    this.bar.setMaskEnabled(!frozen);
    // The button changes TYPE between screens, not just its icon:
    // 63:6435 (rest) is Filled, 63:6442 (captured) is Outlined.
    this.captureBtn.classList.toggle('btn--filled', p !== 'captured');
    this.captureBtn.classList.toggle('btn--outlined', p === 'captured');
    this.captureBtn.innerHTML = icon(p === 'captured' ? 'backward' : 'camera');
    this.captureBtn.setAttribute('aria-label', p === 'captured' ? 'Back to live' : 'Capture');
    // Flip vanishes once a capture exists (63:6429 shows one full-width
    // button), and only ever appears where there is a second camera.
    this.flipBtn.hidden = !this.flipAvailable || p === 'captured';
  }

  /**
   * Reveal the flip button. Called by the owner once it knows whether a second
   * camera exists — the check is async, so the button starts hidden and
   * appears only if warranted, never the reverse.
   */
  setFlipAvailable(on: boolean) {
    this.flipAvailable = on;
    this.flipBtn.hidden = !on || this.phase === 'captured';
  }

  /** Paint a dot field onto the stage. */
  /** `density` is the ρ dial's value — the dot fill ratio. */
  draw(field: Field, playhead = -1, density = 0.62, trail = false) {
    // Remembered so `syncCanvas()` can repaint after a resize. Setting
    // `canvas.width` CLEARS the canvas, and while frozen there is no rAF loop
    // to paint the next frame — without this the stage goes black on every
    // resize and stays black until the user captures again.
    this.lastDraw = { field, playhead, density, trail };
    renderField(this.canvas, field, playhead, density, trail);
  }

  /**
   * Keep the backing store equal to the CSS box.
   *
   * `field.ts` derives its letterbox and cell size from the BACKING STORE, so
   * the two must agree or every dot is scaled. V3 §7.4 records a prior mismatch
   * (backing 390 wide, box 342) that rendered the letter at ~44%. Now that the
   * frame height is elastic (`--screen-h` is clamped to the viewport in
   * `index.html`), the box changes at runtime and a constant cannot track it:
   * measured at 1366x768, a fixed 992-tall backing against a 454-tall box
   * squashed dots to aspect 1.0925 — circles became ellipses.
   *
   * DPR is capped at 2, matching the design's 2x intent; uncapped, a 3x phone
   * would allocate 2.25x the pixels for no visible gain.
   */
  // A METHOD, not a class-property arrow. `useDefineForClassFields: true`
  // (tsconfig) defines instance fields AFTER the constructor body runs, so as a
  // property this was still `undefined` at the point the constructor installs
  // the ResizeObserver — `new ResizeObserver(undefined)` and the seeding call
  // both failed silently, leaving the canvas at its 300x150 default. Prototype
  // methods exist before the constructor runs. Bound at the call site.
  private syncCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (!w || !h) return;                       // not laid out yet
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const d = this.lastDraw;
    if (d) renderField(this.canvas, d.field, d.playhead, d.density, d.trail);
  }
}
