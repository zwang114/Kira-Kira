/**
 * Large dial — Figma nodes 62:5042 (Disabled) / 62:5079 (Active).
 *
 * 170px circle. Houses three controls in a row — loop, play/pause, and a speed
 * cycle (1x / 2x / 3x) — and the whole face also scrubs the playhead when
 * turned. A notch ring runs around the inside edge; the 4px dot at top is the
 * scrub position indicator.
 *
 * Padding 24px sides / 16px top+bottom, 24px gap between the three controls.
 *
 * Tap vs scrub: a pointerdown inside one of the three hit targets arms a tap.
 * If the pointer travels more than TAP_SLOP before release the tap is
 * cancelled and it becomes a scrub instead. Anywhere else on the face scrubs
 * immediately.
 */

import { icon } from './icons';

const TAP_SLOP = 8;      // px of travel that cancels a tap

/**
 * The notch ring, exactly as node 62:5089 ships it: 24 segments in one path,
 * viewBox 0 0 167 167, centre 83.495, outer r 83 → inner r 79. Four cardinals
 * are axis-aligned (H/V), the other 20 are the same 4px length at their own
 * angles (L). Every mark is 4px — the count was right in the old code, but its
 * 3px/8px quarter-mark length split was invented and is not in the design.
 * Stroke colour comes from CSS so the disabled state can swap it.
 */
const NOTCH_PATH =
  'M166.5 83.495H162.5M4.5 83.495H0.5M83.4949 0.5V4.5M83.4949 162.5V166.5' +
  'M163.673 104.977L159.809 103.942M7.19304 63.0485L3.32933 62.0132' +
  'M155.382 124.995L151.918 122.995M15.0863 43.9953L11.6222 41.9953' +
  'M142.193 142.185L139.364 139.357M27.6413 27.6342L24.8129 24.8057' +
  'M125.003 155.376L123.003 151.912M44.0034 15.0801L42.0034 11.616' +
  'M104.986 163.669L103.95 159.805M63.057 7.18855L62.0217 3.32485' +
  'M104.977 3.32689L103.942 7.19059M63.0485 159.807L62.0132 163.671' +
  'M124.995 11.617L122.995 15.0811M43.9952 151.913L41.9952 155.377' +
  'M142.185 24.8056L139.357 27.634M27.634 139.357L24.8056 142.185' +
  'M155.377 41.9941L151.912 43.9941M15.0804 122.994L11.6163 124.994' +
  'M163.669 62.0109L159.806 63.0462M7.18927 103.94L3.32557 104.975';

/**
 * Pointer capture, guarded. A synthetic PointerEvent (tests, or a scripted
 * interaction) has no active pointer, so these throw NotFoundError and abort
 * the handler mid-way — which silently breaks the tap that follows. Real
 * pointers never hit this, but the failure mode is invisible, so guard it.
 */
function capture(el: Element, id: number) {
  try { el.setPointerCapture(id); } catch { /* no active pointer */ }
}
function release(el: Element, id: number) {
  try { el.releasePointerCapture(id); } catch { /* already gone */ }
}

export interface LargeDialOptions {
  onPlayToggle?: () => void;
  onLoopToggle?: () => void;
  onSpeedChange?: (x: 1 | 2 | 3) => void;
  /** Fired while scrubbing. `t` is 0..1 across the sweep. */
  onScrub?: (t: number) => void;
}

export class LargeDial {
  readonly el: HTMLDivElement;
  private dot: HTMLDivElement;
  private loopBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private o: LargeDialOptions;

  private _enabled = false;
  private _playing = false;
  private _looping = false;
  private _speed: 1 | 2 | 3 = 1;
  private _pos = 0;              // 0..1 playhead position

  private down: { x: number; y: number; onTap: HTMLButtonElement | null } | null = null;
  private scrubbing = false;
  private lastAngle = 0;

  constructor(opts: LargeDialOptions = {}) {
    this.o = opts;

    const el = document.createElement('div');
    el.className = 'large-dial is-disabled';

    // Notch ring — the node's own geometry, verbatim. Do NOT regenerate this
    // trigonometrically: an earlier version drew 24 marks with a 3px/8px
    // length split, and the design has 32 marks of equal 4px length whose only
    // differentiation is angular position. Downloaded from node 62:5089.
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('class', 'large-dial__ring');
    ring.setAttribute('viewBox', '0 0 167 167');
    ring.setAttribute('fill', 'none');
    const ringPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ringPath.setAttribute('d', NOTCH_PATH);
    ringPath.setAttribute('stroke-linecap', 'round');
    ring.appendChild(ringPath);

    const dot = document.createElement('div');
    dot.className = 'large-dial__dot';

    const control = document.createElement('div');
    control.className = 'large-dial__control';

    this.loopBtn = this.mkBtn('loop', ICON_LOOP());
    this.playBtn = this.mkBtn('play', ICON_PLAY());
    this.speedBtn = document.createElement('button');
    this.speedBtn.className = 'large-dial__speed readout';
    this.speedBtn.type = 'button';
    this.speedBtn.textContent = '1x';
    this.speedBtn.setAttribute('aria-label', 'Playback speed');

    control.append(this.loopBtn, this.playBtn, this.speedBtn);
    el.append(ring, dot, control);

    this.el = el;
    this.dot = dot;
    this.bind();
    this.setEnabled(false);
  }

  private mkBtn(name: string, svg: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `large-dial__icon large-dial__icon--${name}`;
    b.type = 'button';
    b.innerHTML = svg;
    b.setAttribute('aria-label', name);
    return b;
  }

  setEnabled(on: boolean) {
    this._enabled = on;
    this.el.classList.toggle('is-disabled', !on);
    [this.loopBtn, this.playBtn, this.speedBtn].forEach(b => (b.disabled = !on));
  }

  setPlaying(on: boolean) {
    this._playing = on;
    this.playBtn.innerHTML = on ? ICON_PAUSE() : ICON_PLAY();
    this.playBtn.setAttribute('aria-label', on ? 'pause' : 'play');
  }

  setLooping(on: boolean) {
    this._looping = on;
    this.loopBtn.classList.toggle('is-on', on);
  }

  /** Move the indicator. `t` is 0..1. */
  setPosition(t: number) {
    this._pos = Math.min(1, Math.max(0, t));
    this.dot.style.transform = `rotate(${this._pos * 360}deg)`;
  }

  get speed() { return this._speed; }
  get playing() { return this._playing; }
  get looping() { return this._looping; }

  /**
   * Set the speed without cycling — for an owner re-syncing the dial to
   * transport state. `cycleSpeed` is the user-facing path and notifies;
   * this one is silent, so driving it from a session update cannot loop back
   * into another `onSpeedChange`.
   */
  setSpeed(x: 1 | 2 | 3) {
    this._speed = x;
    this.speedBtn.textContent = `${x}x`;
  }

  private cycleSpeed() {
    this._speed = (this._speed === 3 ? 1 : this._speed + 1) as 1 | 2 | 3;
    this.speedBtn.textContent = `${this._speed}x`;
    this.o.onSpeedChange?.(this._speed);
  }

  private angleFrom(e: PointerEvent): number {
    const r = this.el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2),
                      e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  }

  private bind() {
    const el = this.el;

    el.addEventListener('pointerdown', (e) => {
      if (!this._enabled) return;
      const target = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      this.down = { x: e.clientX, y: e.clientY, onTap: target };
      this.lastAngle = this.angleFrom(e);
      this.scrubbing = !target;          // off a button = scrub straight away
      capture(el, e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.down) return;
      const dx = e.clientX - this.down.x, dy = e.clientY - this.down.y;
      if (!this.scrubbing && Math.hypot(dx, dy) > TAP_SLOP) {
        // travelled too far — this was never a tap
        this.scrubbing = true;
        this.down.onTap = null;
      }
      if (!this.scrubbing) return;
      const a = this.angleFrom(e);
      let d = a - this.lastAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.lastAngle = a;
      this.setPosition(this._pos + d / 360);
      this.o.onScrub?.(this._pos);
    });

    const end = (e: PointerEvent) => {
      if (!this.down) return;
      const tapped = this.down.onTap;
      this.down = null;
      this.scrubbing = false;
      release(el, e.pointerId);
      if (!tapped) return;
      if (tapped === this.playBtn) this.o.onPlayToggle?.();
      else if (tapped === this.loopBtn) this.o.onLoopToggle?.();
      else if (tapped === this.speedBtn) this.cycleSpeed();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

// Loop and play come from the design's own icon set (node 62:5454).
// These are FUNCTIONS, not module-scope constants: a `const X = icon(...)` at
// the bottom of the file is evaluated during module initialisation, which in a
// circular-import graph can run before `icon` is bound — a real ReferenceError
// that only shows up at runtime.
const ICON_LOOP = () => icon('loop');
const ICON_PLAY = () => icon('play');

const ICON_PAUSE = () => icon('pause');
