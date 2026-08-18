/**
 * Utility bar — Figma nodes 62:5813 (collapsed) / 62:6144 (expanded),
 * with the Auto Level panel at 62:6071.
 *
 * The Auto Level tick pattern, read directly from node 62:6039's 29 children:
 *
 *   [12, 8] x 6      twelve ticks, alternating tall/short
 *   12               the tall tick that closes the run before the marker
 *   16, 32, 16       the centre marker: a 32px rule flanked by two 16px
 *   [12, 8] x 6      twelve more
 *   12               one closing tall tick
 *
 * That is 29 ticks, NOT 31 — the node has 29 vectors (62:6040…62:6068) and the
 * accent trio sits at indices 13/14/15, with a 12 on either side of it. An
 * earlier build used 31 entries and marked 12/13/14 accent, which seated the
 * orange on the wrong marks and painted three per repeat (nine on screen).
 *
 * The ticks are positioned, not justify-between: the node's own x values run
 * 0 -> 326 in 28 equal steps, so the PITCH (centre-to-centre) is exactly
 * 326/28 = 11.642857px. Because a period's last tick is the next period's
 * first, one period of travel is 29 pitches wide, not 28.
 *
 * THE RAIL IS INFINITE. The pattern above is one PERIOD, repeated enough times
 * to cover the panel plus a period of overscroll either side. Scrolling
 * translates the strip and wraps the offset modulo one period, so there is no
 * end to reach — the previous build translated a single finite strip and ran
 * out of ticks, which is the bug that was reported.
 */

import { icon } from './icons';

/**
 * One period of the design's tick pattern, in px heights — 29 ticks.
 *
 * The scrolling strip is UNIFORM: alternating 12/8 with a 12 at each end. The
 * 16/32/16 accent trio is NOT part of it — see CENTRE_MARK below.
 */
const PERIOD: number[] = [
  ...Array.from({ length: 6 }, () => [12, 8]).flat(),
  12, 12, 12, 12,
  ...Array.from({ length: 6 }, () => [12, 8]).flat(),
  12,
];

/**
 * The centre marker — 16/32/16, accent, FIXED at the panel's centre.
 *
 * It does not scroll. In the design the orange trio always sits dead centre
 * and marks the current value; the ticks travel past it. An earlier version
 * baked the accent into `PERIOD` at fixed indices, so the orange scrolled away
 * with the strip and reappeared once per period — three copies of it were
 * visible at once, which is why nine orange ticks were on screen.
 */
const CENTRE_MARK: number[] = [16, 32, 16];

/** The panel is 310 wide when open (62:6146); 326 is the collapsed variant. */
const PANEL_W = 310;
/** Centre-to-centre spacing: the node's 29 ticks span the panel in 28 steps. */
const PITCH = PANEL_W / (PERIOD.length - 1);
/** A period's last tick coincides with the next period's first, so 29 pitches. */
const PERIOD_W = PERIOD.length * PITCH;
/** One tick step of travel = this much auto-level. */
const UNITS_PER_TICK = 0.05;

/**
 * Value bounds. The RAIL is deliberately infinite — it wraps modulo one period
 * so it can never run out of ticks — but the VALUE must not be. Without these,
 * a 12,000px scrub drove the readout to −51.53 and would have kept going.
 *
 * Bipolar, matching the readout's signed `+0.00` format and the orange centre
 * marker that marks zero. The range mirrors the EXP dial (−2…+2); `dither.ts`
 * clamps its own `autoLevel` to 0…1 at :238, so nothing downstream ever saw
 * the runaway — this was a UI defect, not a pipeline one.
 */
const VALUE_MIN = -2;
const VALUE_MAX = 2;

export interface UtilityBarOptions {
  onSoundOpen?: () => void;
  /** Step to the previous (-1) or next (+1) letter. */
  onStepLetter?: (dir: 1 | -1) => void;
  /** Invert tapped. The OWNER holds the state and calls `setInverted`. */
  onInvertToggle?: () => void;
  /** Chime mute tapped. The OWNER holds the state and calls `setChimeMuted`. */
  onChimeToggle?: () => void;
  /** Mask toggled. The OWNER holds the state and calls `setMasked`. */
  onMaskToggle?: () => void;
  onAutoLevel?: (v: number) => void;
  autoLevel?: number;
}

export class UtilityBar {
  readonly el: HTMLDivElement;
  private overlay: HTMLDivElement;
  private railInner: HTMLDivElement;
  private valueEl: HTMLParagraphElement;
  private apertureBtn: HTMLButtonElement;
  private invertBtn!: HTMLButtonElement;
  private maskBtn!: HTMLButtonElement;
  private chimeBtn!: HTMLButtonElement;
  private letterEl!: HTMLSpanElement;
  private o: UtilityBarOptions;

  private value: number;
  private dragging = false;
  private lastX = 0;

  constructor(opts: UtilityBarOptions = {}) {
    this.o = opts;
    this.value = opts.autoLevel ?? 0;

    const el = document.createElement('div');
    el.className = 'utility-bar';

    this.apertureBtn = document.createElement('button');
    this.apertureBtn.className = 'utility-bar__icon';
    this.apertureBtn.type = 'button';
    this.apertureBtn.innerHTML = icon('aperture');
    this.apertureBtn.setAttribute('aria-label', 'Auto level');
    this.apertureBtn.setAttribute('aria-expanded', 'false');

    const soundBtn = document.createElement('button');
    soundBtn.className = 'utility-bar__icon';
    soundBtn.type = 'button';
    soundBtn.innerHTML = icon('sound');
    soundBtn.setAttribute('aria-label', 'Sound config');
    soundBtn.addEventListener('click', () => this.o.onSoundOpen?.());

    // ── Auto Level panel ────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'auto-level';
    overlay.setAttribute('role', 'slider');
    overlay.setAttribute('aria-label', 'Auto level');
    // A `role="slider"` without bounds is an invalid ARIA node — screen readers
    // compute a percentage from absent min/max and announce nothing useful.
    overlay.setAttribute('aria-valuemin', String(VALUE_MIN));
    overlay.setAttribute('aria-valuemax', String(VALUE_MAX));
    // Focusable ONLY while open: it carries arrow-key and Escape handlers that
    // were previously unreachable by keyboard entirely, but a permanently
    // focusable node would also trap Tab on a panel that is not visible.
    // `setOpen()` keeps this in sync.
    overlay.tabIndex = -1;

    const number = document.createElement('div');
    number.className = 'auto-level__number';
    const dot = document.createElement('div');
    dot.className = 'auto-level__dot';
    const value = document.createElement('p');
    value.className = 'auto-level__value readout';
    number.append(dot, value);

    const rail = document.createElement('div');
    rail.className = 'auto-level__rail';
    const railInner = document.createElement('div');
    railInner.className = 'auto-level__rail-inner';
    // Three periods: one on screen, one either side for overscroll. Each tick is
    // absolutely placed at its exact pitch — a flex row with margins sized the
    // inner to its 1000px content box, which escaped the rail's overflow clip
    // and showed all three copies at once.
    let html = '';
    for (let rep = 0; rep < 3; rep++) {
      PERIOD.forEach((h, i) => {
        const x = rep * PERIOD_W + i * PITCH;
        html += `<span class="auto-level__tick" `
             +  `style="height:${h}px;left:${x}px"></span>`;
      });
    }
    railInner.innerHTML = html;
    railInner.style.width = `${PERIOD_W * 3}px`;

    /*
      The centre marker: a sibling of the scrolling strip, not part of it, so
      it stays put while the ticks travel underneath. Three marks spaced one
      pitch apart and centred on the rail, so the tall 32px rule sits exactly
      at the panel's midpoint and reads as "you are here".
    */
    const centre = document.createElement('div');
    centre.className = 'auto-level__centre';
    centre.innerHTML = CENTRE_MARK.map((h, i) =>
      `<span class="auto-level__tick auto-level__tick--accent" `
      + `style="height:${h}px;left:${(i - 1) * PITCH}px"></span>`).join('');

    const label = document.createElement('p');
    label.className = 'auto-level__label';
    label.textContent = 'AUTO LEVEL';

    overlay.append(number, rail, label);
    rail.appendChild(railInner);
    rail.appendChild(centre);
    /*
      Invert — node 102:622, centred at x=183 between the aperture (x=16) and
      the sound mark (x=350).

      This slot previously held ‹ A › letter-step buttons. They were the
      keyboard-reachable path to A–Z (WCAG 2.1.1), since swiping is a gesture
      that keyboard, switch-access and voice-control users cannot perform. The
      user removed them for the invert icon, so that obligation moves to the
      STAGE, which now takes arrow keys — see `Screen`. The swipe is unchanged.

      `letterEl` survives as a visually-hidden live region: the letter still
      has to be ANNOUNCED when it changes, or a screen-reader user swiping (or
      arrowing) gets no feedback that anything happened.
    */
    this.invertBtn = document.createElement('button');
    this.invertBtn.className = 'utility-bar__icon';
    this.invertBtn.type = 'button';
    this.invertBtn.innerHTML = icon('invert');
    this.invertBtn.setAttribute('aria-label', 'Invert');
    this.invertBtn.setAttribute('aria-pressed', 'false');
    this.invertBtn.addEventListener('click', () => this.o.onInvertToggle?.());

    this.letterEl = document.createElement('span');
    this.letterEl.className = 'utility-bar__letter-current sr-only';
    this.letterEl.setAttribute('aria-live', 'polite');

    /*
      Chime mute — node 103:704, `Type=Noise` / `Type=Mute`.

      Rightmost at x=350; the bar's four icons are evenly spaced at
      16 / 127.33 / 238.67 / 350, which `space-between` reproduces exactly.

      It mutes ONLY the aim chime. Playback of a capture is unaffected, which
      is why this is not labelled as a global mute.
    */
    /*
      Mask toggle — node 103:736, at x=266.5 of the five evenly-spaced icons
      (16 / 99.5 / 183 / 266.5 / 350).

      OFF on load and grey; ON turns it accent, the same rest/active rule the
      other marks use. Off means the stage shows the raw dithered environment;
      on means the letterform gates it.
    */
    this.maskBtn = document.createElement('button');
    this.maskBtn.className = 'utility-bar__icon';
    this.maskBtn.type = 'button';
    this.maskBtn.innerHTML = icon('mask');
    this.maskBtn.setAttribute('aria-label', 'Letter mask');
    this.maskBtn.setAttribute('aria-pressed', 'false');
    this.maskBtn.addEventListener('click', () => this.o.onMaskToggle?.());

    this.chimeBtn = document.createElement('button');
    this.chimeBtn.className = 'utility-bar__icon';
    this.chimeBtn.type = 'button';
    this.chimeBtn.innerHTML = icon('noise');
    this.chimeBtn.setAttribute('aria-label', 'Mute aim chime');
    this.chimeBtn.setAttribute('aria-pressed', 'false');
    this.chimeBtn.addEventListener('click', () => this.o.onChimeToggle?.());

    el.append(
      this.apertureBtn, this.invertBtn, soundBtn, this.maskBtn, this.chimeBtn,
      overlay, this.letterEl,
    );

    this.el = el;
    this.overlay = overlay;
    this.railInner = railInner;
    this.valueEl = value;

    this.render();
    this.bind();
  }

  /** Show the current letter. `aria-live` announces the change. */
  setLetter(ch: string) { this.letterEl.textContent = ch; }

  /**
   * Invert is INVALIDATING — it changes which cells are lit, so a frozen
   * capture cannot survive it. Disabled while one exists rather than silently
   * discarding it, exactly as RES and Auto Level are.
   *
   * This replaces `setLetterNavEnabled`: the ‹ A › buttons it disabled are
   * gone, and letter stepping is now reachable only by swipe or arrow keys on
   * the stage — both of which `Screen` guards for the same reason.
   */
  setInvertEnabled(on: boolean) {
    this.invertBtn.disabled = !on;
  }

  /**
   * Reflect invert state. The OWNER holds the truth (`session.params.invert`)
   * and drives this — the button must not toggle its own appearance, or the
   * icon and the pipeline become two sources of truth that drift. That is the
   * bug class V3 §7.7 pattern 1 records six times over.
   *
   * Rest is `--grey` like the other two marks; active is `--accent`, via the
   * existing `.is-on` rule the aperture already uses.
   */
  setInverted(on: boolean) {
    this.invertBtn.classList.toggle('is-on', on);
    this.invertBtn.setAttribute('aria-pressed', String(on));
  }

  /**
   * Reflect chime-mute state. The ICON ITSELF changes — `Type=Noise` when
   * audible, `Type=Mute` when silenced — because that is how the design
   * distinguishes them, rather than by colour alone. Colour still follows the
   * same rest/active rule as the other marks.
   */
  /** Reflect mask state — grey when off, accent when on. */
  setMasked(on: boolean) {
    this.maskBtn.classList.toggle('is-on', on);
    this.maskBtn.setAttribute('aria-pressed', String(on));
  }

  /**
   * The mask is INVALIDATING, so it goes inert while a capture exists — the
   * same treatment as res, invert and auto level. Captures can be taken in
   * either mode; what cannot happen is switching after freezing.
   */
  setMaskEnabled(on: boolean) {
    this.maskBtn.disabled = !on;
  }

  setChimeMuted(muted: boolean) {
    this.chimeBtn.innerHTML = icon(muted ? 'mute' : 'noise');
    this.chimeBtn.classList.toggle('is-on', muted);
    this.chimeBtn.setAttribute('aria-pressed', String(muted));
    this.chimeBtn.setAttribute(
      'aria-label', muted ? 'Unmute aim chime' : 'Mute aim chime');
  }

  /**
   * Auto Level is LIVE-ONLY — it affects the next camera frame and is a no-op
   * against a frozen grid. Closed as well as disabled: leaving an inert panel
   * open would invite dragging a rail that does nothing.
   */
  setAutoLevelEnabled(on: boolean) {
    this.apertureBtn.disabled = !on;
    if (!on && this.isOpen) this.setOpen(false);
  }

  get isOpen() { return this.el.classList.contains('is-open'); }

  setOpen(on: boolean) {
    this.el.classList.toggle('is-open', on);
    this.apertureBtn.setAttribute('aria-expanded', String(on));
    this.apertureBtn.classList.toggle('is-on', on);
    // Enter the tab order only while open, so a keyboard user can Tab to the
    // rail and operate it; leave it on close so Tab does not stop on a hidden
    // control. Returning focus to the aperture keeps the sequence predictable.
    this.overlay.tabIndex = on ? 0 : -1;
    if (on) this.overlay.focus();
    else if (this.el.contains(document.activeElement)) this.apertureBtn.focus();
  }

  setValue(v: number) {
    // Clamp here rather than at each call site: drag, wheel, and the arrow
    // keys all funnel through this method.
    this.value = Math.min(VALUE_MAX, Math.max(VALUE_MIN, v));
    this.render();
    this.o.onAutoLevel?.(this.value);
  }

  private render() {
    const sign = this.value >= 0 ? '+' : '−';
    this.valueEl.textContent = sign + Math.abs(this.value).toFixed(2);
    this.overlay.setAttribute('aria-valuenow', this.value.toFixed(2));
    // Wrap the offset into one period so the strip never runs out. Start one
    // period to the left so there is always material on both sides.
    const raw = -(this.value / UNITS_PER_TICK) * PITCH;
    const wrapped = ((raw % PERIOD_W) + PERIOD_W) % PERIOD_W;
    this.railInner.style.transform = `translateX(${wrapped - PERIOD_W}px)`;
  }

  private bind() {
    this.apertureBtn.addEventListener('click', () => this.setOpen(!this.isOpen));

    const ov = this.overlay;
    ov.addEventListener('pointerdown', (e) => {
      // Read the class, not a stored flag — the two can drift apart.
      if (!this.isOpen) return;
      this.dragging = true;
      this.lastX = e.clientX;
      try { ov.setPointerCapture(e.pointerId); } catch {}
    });
    ov.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.setValue(this.value - (dx / PITCH) * UNITS_PER_TICK);
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { ov.releasePointerCapture(e.pointerId); } catch {}
    };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);

    ov.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft':  this.setValue(this.value - UNITS_PER_TICK); break;
        case 'ArrowRight': this.setValue(this.value + UNITS_PER_TICK); break;
        case 'Escape':     this.setOpen(false); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
  }
}
