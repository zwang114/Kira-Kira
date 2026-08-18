/**
 * Mini dial — Figma node 62:4972 ("Mini DIal").
 *
 * 79px circle, grey fill, a 4px dot at top marking the indicator, readout and
 * label stacked centre. Padding 8px top / 16px bottom / 8px sides, so the
 * content sits slightly high in the circle. Those numbers are from the design.
 *
 * The whole dial rotates: dragging turns it, and the dot travels with the
 * rotation. Value maps to angle across a 300deg sweep with a 60deg dead zone
 * at the bottom, so the dot never hides behind the readout's descenders.
 */

export interface MiniDialOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  /** Formats the readout. Defaults to 2dp with an explicit sign. */
  format?: (v: number) => string;
  onChange?: (v: number) => void;
}

const SWEEP = 300;      // degrees of travel
const START = -150;     // degrees from 12 o'clock at min value

/** Pointer capture, guarded — synthetic events have no active pointer. */
function capture(el: Element, id: number) {
  try { el.setPointerCapture(id); } catch { /* no active pointer */ }
}
function release(el: Element, id: number) {
  try { el.releasePointerCapture(id); } catch { /* already gone */ }
}

export class MiniDial {
  readonly el: HTMLDivElement;
  private dot: HTMLDivElement;
  private readoutEl: HTMLParagraphElement;
  private o: Required<MiniDialOptions>;
  private v: number;
  private dragging = false;
  private lastAngle = 0;
  private enabled = true;

  constructor(opts: MiniDialOptions) {
    this.o = {
      step: 0.01,
      format: (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2),
      onChange: () => {},
      ...opts,
    } as Required<MiniDialOptions>;
    this.v = opts.value;

    const el = document.createElement('div');
    el.className = 'mini-dial';
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', opts.label);
    el.setAttribute('aria-valuemin', String(opts.min));
    el.setAttribute('aria-valuemax', String(opts.max));
    el.tabIndex = 0;

    const dot = document.createElement('div');
    dot.className = 'mini-dial__dot';

    const content = document.createElement('div');
    content.className = 'mini-dial__content';

    const readout = document.createElement('p');
    readout.className = 'mini-dial__readout readout';

    const label = document.createElement('p');
    label.className = 'mini-dial__label';
    label.textContent = opts.label;

    content.append(readout, label);
    el.append(dot, content);

    this.el = el;
    this.dot = dot;
    this.readoutEl = readout;

    this.bind();
    this.set(this.v, false);
  }

  get value() { return this.v; }

  set(v: number, notify = true) {
    const { min, max, step } = this.o;
    const clamped = Math.min(max, Math.max(min, Math.round(v / step) * step));
    this.v = clamped;
    this.readoutEl.textContent = this.o.format(clamped);
    this.el.setAttribute('aria-valuenow', clamped.toFixed(2));
    // The DOT rotates, not the whole dial — rotating the dial would rotate the
    // readout with it, which the design does not do.
    const t = (clamped - min) / (max - min);
    this.dot.style.transform = `rotate(${START + t * SWEEP}deg)`;
    if (notify) this.o.onChange(clamped);
  }

  private angleFrom(e: PointerEvent): number {
    const r = this.el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2),
                      e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  }

  /**
   * Enable or disable the dial.
   *
   * Mirrors `LargeDial.setEnabled` so the app has ONE disabled language: the
   * large dial is inert until a capture exists, and these go inert once one
   * does. Used for the parameters that cannot act on a frozen capture — see
   * `Screen.setPhase`.
   *
   * `aria-disabled`, not the `disabled` attribute: this is a `role="slider"` on
   * a div, which has no `disabled` property, and `aria-disabled` keeps it
   * discoverable to a screen reader (announced as unavailable) rather than
   * removing it from the tree. `tabIndex` is dropped so keyboard focus skips it.
   */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.el.classList.toggle('is-disabled', !on);
    this.el.setAttribute('aria-disabled', String(!on));
    this.el.tabIndex = on ? 0 : -1;
    if (!on) {
      // A drag in flight when the phase changes would otherwise keep tracking
      // the pointer against a dial that is no longer live.
      this.dragging = false;
      this.el.classList.remove('is-active');
    }
  }

  get isEnabled() { return this.enabled; }

  private bind() {
    const el = this.el;

    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.lastAngle = this.angleFrom(e);
      capture(el, e.pointerId);
      el.classList.add('is-active');
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const a = this.angleFrom(e);
      let d = a - this.lastAngle;
      // Unwrap across the -180/180 seam, or a single drag past 9 o'clock
      // would slam the value to the opposite end.
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.lastAngle = a;
      const range = this.o.max - this.o.min;
      this.set(this.v + (d / SWEEP) * range);
    });

    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      release(el, e.pointerId);
      el.classList.remove('is-active');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const range = this.o.max - this.o.min;
      const fine = e.shiftKey ? 0.25 : 1;
      const big = range / 10;
      let handled = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': this.set(this.v + this.o.step * 4 * fine); break;
        case 'ArrowDown': case 'ArrowLeft': this.set(this.v - this.o.step * 4 * fine); break;
        case 'PageUp':   this.set(this.v + big); break;
        case 'PageDown': this.set(this.v - big); break;
        case 'Home':     this.set(this.o.min); break;
        case 'End':      this.set(this.o.max); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });

    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const range = this.o.max - this.o.min;
      this.set(this.v - Math.sign(e.deltaY) * range * 0.02);
    }, { passive: false });
  }
}
