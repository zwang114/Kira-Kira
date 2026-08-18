/**
 * Sound config — Figma node 63:6469.
 *
 * Two 334px reels, mostly off-screen left and right (the frame is 733px wide
 * inside a 390px viewport). Left reel picks the SHAPE, right reel picks the
 * SOUND PROFILE. Each shape keeps its own profile and its own level.
 *
 * The waveform between the wheels oscillates while a profile is being chosen.
 * Its PATH NEVER CHANGES — only amplitude and phase are animated, via a single
 * transform and a scale on the same drawn curve. That is a requirement: the
 * shape of the curve is the design, so it is preserved by construction rather
 * than by care. The curve itself is node 63:6478's own geometry — see WAVE_SVG.
 */

import { Reel } from './Reel';
import { icon } from './icons';
import { SHAPES, type Shape } from './field';

/** Reel codes for the four shapes, per the design (node 23:783). */
/**
 * Reel labels for the four shapes.
 *
 * The lightest shape is labelled STR (star) but the internal key and the drawn
 * mark are `cross`. That is deliberate, not drift: the four shapes were solved
 * for even ink coverage (0.465 / 0.335 / 0.215 / 0.102) so they form a smooth
 * brightness ramp, and at the lightest step a cross is the only form that
 * stays legible — a star's points vanish at ~8px, and thinning it to match
 * coverage renders it as a blob. The label is the user's word; the geometry is
 * the measurement's.
 */
const SHAPE_CODES: Record<Shape, string> = {
  square: 'SQ', circle: 'CL', diamond: 'DM', cross: 'STR',
};

export interface Profile { id: string; code: string; label: string }

/** Four profiles, one per shape — the user's decision. */
/**
 * The four assignable voices.
 *
 * `code` is what the reel shows. The design labels these S.P.1–S.P.4, but a
 * number cannot tell you what it sounds like — you had to hear it to know, and
 * until the audition was wired the screen made no sound at all. Naming the
 * instrument makes the right wheel self-describing.
 *
 * `id` stays `sp1..sp4`: it is the persisted key and the vocabulary
 * `setVoiceAssignments` validates against. Renaming ids would invalidate any
 * saved assignment.
 *
 * Six synth voices exist; `marimba` and `pad` are deliberately not offered.
 * Four shapes × four profiles is a symmetry that answers "which shape gets the
 * fifth?" by not raising the question. Both remain auditionable in
 * `harness.html`, which lists all six.
 */
export const PROFILES: Profile[] = [
  { id: 'sp1', code: 'KEYS',   label: 'Keys' },
  { id: 'sp2', code: 'PIANO',  label: 'Piano' },
  { id: 'sp3', code: 'RHODES', label: 'Rhodes' },
  { id: 'sp4', code: 'GUITAR', label: 'Guitar' },
];

export interface Assignment { profile: string; level: number }

export interface SoundConfigOptions {
  assignments?: Record<Shape, Assignment>;
  onSave?: (a: Record<Shape, Assignment>) => void;
  onExit?: () => void;
  onPreview?: (shape: Shape, profile: string) => void;
}

export class SoundConfig {
  readonly el: HTMLDivElement;
  readonly shapeReel: Reel;
  readonly profileReel: Reel;

  private assignments: Record<Shape, Assignment>;
  private initial: Record<Shape, Assignment>;
  private nowEl!: HTMLDivElement;
  private pctEl!: HTMLDivElement;
  private knob!: HTMLDivElement;
  private railEl!: HTMLDivElement;
  private waveEl!: HTMLElement;
  private o: SoundConfigOptions;
  private waveTimer: number | null = null;

  constructor(opts: SoundConfigOptions = {}) {
    this.o = opts;
    const base: Record<Shape, Assignment> = {
      square:  { profile: 'sp1', level: 0.5 },
      circle:  { profile: 'sp2', level: 0.5 },
      diamond: { profile: 'sp3', level: 0.5 },
      cross:   { profile: 'sp4', level: 0.5 },
    };
    this.assignments = { ...base, ...(opts.assignments ?? {}) };
    this.initial = JSON.parse(JSON.stringify(this.assignments));

    // ── Root 63:6469 — column, items-center justify-between, full size.
    const el = document.createElement('div');
    el.className = 'sound-config';

    // ── Body 63:6470 — flex:1, column, gap 120, pt-8 px-8.
    const body = document.createElement('div');
    body.className = 'sound-config__body';

    // ── Header 63:6471 — row, gap 8, centred. Vector 63:6472 + text 63:6473.
    // The design's glyphs are literally "SOUND CONFIG"; no text-transform.
    const head = document.createElement('div');
    head.className = 'sound-config__head';
    head.innerHTML = icon('sound') + '<p>SOUND CONFIG</p>';

    // ── Reel group 63:6474 — column, gap 24, items-center.
    const reelGroup = document.createElement('div');
    reelGroup.className = 'sound-config__reel-group';

    // ── Reel row 63:6475 — 733x334, position relative. The waveform is a
    // CHILD of this row (63:6478), not a sibling of it: it is centred on the
    // gap between the two wheels, not on the screen.
    const reels = document.createElement('div');
    reels.className = 'sound-config__reels';

    this.shapeReel = new Reel({
      slots: SHAPES.map(s => ({ code: SHAPE_CODES[s], value: s })),
      variant: 'default',
      onChange: () => this.syncFromShape(),
    });

    this.profileReel = new Reel({
      slots: PROFILES.map(p => ({ code: p.code, value: p.id })),
      // The right reel seats its selection at WEST, so the two wheels point
      // at each other across the waveform.
      seat: 'west',
      variant: 'variant2',
      onChange: (_i, slot) => {
        this.assignments[this.shape].profile = slot.value;
        this.pulse();
        this.o.onPreview?.(this.shape, slot.value);
        this.renderMeta();
      },
    });

    this.shapeReel.el.classList.add('sound-config__reel--left');
    this.profileReel.el.classList.add('sound-config__reel--right');

    const wave = document.createElement('div');
    wave.className = 'sound-config__wave';
    wave.innerHTML = WAVE_SVG;
    this.waveEl = wave.firstElementChild as HTMLElement;

    reels.append(this.shapeReel.el, this.profileReel.el, wave);

    // ── Slider block 63:6479 — 390 wide, column, gap 24, pt-40 px-8, r-8.
    const slider = document.createElement('div');
    slider.className = 'sound-config__slider';

    // Row 63:6480 — items-center justify-between, full width.
    const meta = document.createElement('div');
    meta.className = 'sound-config__meta';
    // Left group 63:6481 — gap 8: code, 2px ellipse 63:6483, profile code.
    this.nowEl = document.createElement('div');
    this.nowEl.className = 'sound-config__now';
    // Right 63:6485 "Spacer" — 1px border, r-100, px-12 py-8.
    this.pctEl = document.createElement('div');
    this.pctEl.className = 'sound-config__pct';
    meta.append(this.nowEl, this.pctEl);

    // Rail 63:6487 — h-12, items-center justify-between, full width.
    // 31 ticks alternating 12px / 8px, starting AND ending on a 12px tick.
    const rail = document.createElement('div');
    rail.className = 'sound-config__rail';
    let ticks = '';
    for (let i = 0; i < 31; i++) {
      ticks += `<span class="sound-config__tick${i % 2 ? '' : ' is-tall'}"></span>`;
    }
    rail.innerHTML = ticks;

    // Slider button 63:6519 — 56x27, absolutely centred on the rail.
    const knob = document.createElement('div');
    knob.className = 'sound-config__knob';
    knob.innerHTML = '<i></i><i></i><i></i>';
    rail.appendChild(knob);
    this.knob = knob;
    this.railEl = rail;

    slider.append(meta, rail);

    reelGroup.append(reels, slider);
    body.append(head, reelGroup);

    // ── Footer 63:6523 — row, gap 8, items-start, p-8, top corners r-24.
    // The save button is flex:1 and FILLS; the two icon buttons hug.
    const foot = document.createElement('div');
    foot.className = 'sound-config__foot';
    const resetBtn = this.mkBtn('reset', 'btn--icon', 'Reset');
    const saveBtn = this.mkBtn('save', 'btn--filled btn--save', 'Save and exit');
    const exitBtn = this.mkBtn('backward', 'btn--icon', 'Exit without saving');
    resetBtn.addEventListener('click', () => this.reset());
    saveBtn.addEventListener('click', () => this.o.onSave?.(this.assignments));
    exitBtn.addEventListener('click', () => this.o.onExit?.());
    foot.append(resetBtn, saveBtn, exitBtn);

    el.append(body, foot);
    this.el = el;

    this.bindRail();
    // Seed the profile wheel FROM the saved assignment — the opposite
    // direction from `syncFromShape`, which writes the wheels into state.
    // Calling that here would have overwritten the seated shape's stored voice
    // with whatever the right wheel happened to start on.
    const pi0 = PROFILES.findIndex(p => p.id === this.assignments[this.shape].profile);
    if (pi0 >= 0) this.profileReel.select(pi0, false, false);
    this.renderMeta();
  }

  /**
   * Buttons 63:6524/6525/6526. The icon is wrapped in a 24px box (the design's
   * icon frame) containing the vector at its own native size — the box is what
   * establishes the 24px rhythm, not the glyph.
   */
  private mkBtn(ic: string, cls: string, label: string) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.type = 'button';
    b.innerHTML = `<span class="btn__icon">${icon(ic as any)}</span>`;
    b.setAttribute('aria-label', label);
    return b;
  }

  get shape(): Shape { return this.shapeReel.slot.value as Shape; }

  /**
   * The shape reel moved. Record the pairing — do NOT touch the other wheel.
   *
   * THE TWO WHEELS ARE INDEPENDENT. Each only ever moves when the user turns
   * it. Whatever shape is seated on the left is assigned whatever voice is
   * seated on the right, continuously: turning either wheel writes the pairing
   * for the shape currently showing.
   *
   * This previously drove the profile reel to the new shape's saved voice,
   * which made the right wheel appear to snap on its own the moment you turned
   * the left one. That coupling is gone and must not come back — a wheel that
   * moves without being touched is the single thing this control must never do.
   */
  private syncFromShape(notify = true) {
    // The right wheel stays exactly where it is; its seated voice becomes this
    // shape's assignment.
    const profile = this.profileReel.slot.value;
    this.assignments[this.shape].profile = profile;
    this.renderMeta();
    if (notify) this.o.onPreview?.(this.shape, profile);
  }

  private renderMeta() {
    const a = this.assignments[this.shape];
    const prof = PROFILES.find(p => p.id === a.profile);
    // 63:6482 / 63:6483 / 63:6484 — the separator is a 2px ellipse, not a
    // middot glyph, so it does not shift with the font.
    /*
      Reads as a SENTENCE, not a coordinate pair: "SQ plays KEYS".

      The two wheels look identical but do different jobs — the left one
      SELECTS which shape you are editing, the right one sets that shape's
      voice. Nothing on screen said so, so turning the left wheel and watching
      the right one change read as the right wheel snapping on its own. The
      captions name each wheel's role and the arrow shows which way the
      relationship runs.
    */
    this.nowEl.innerHTML =
      `<span class="sound-config__role">SHAPE</span>`
      + `<b>${SHAPE_CODES[this.shape]}</b>`
      + `<span class="sound-config__arrow" aria-hidden="true">→</span>`
      + `<span class="sound-config__role">VOICE</span>`
      + `<b>${prof?.code ?? ''}</b>`;
    this.pctEl.textContent = `${Math.round(a.level * 100)}%`;
    // The knob is centred by CSS transform; `left` is a pure percentage of the
    // rail so it needs no measured width and is correct before first layout.
    this.knob.style.left = `${a.level * 100}%`;
  }

  private setLevel(v: number) {
    this.assignments[this.shape].level = Math.min(1, Math.max(0, v));
    this.renderMeta();
  }

  private bindRail() {
    const rail = this.railEl;
    let dragging = false;
    const at = (e: PointerEvent) => {
      const r = rail.getBoundingClientRect();
      this.setLevel((e.clientX - r.left) / r.width);
    };
    rail.addEventListener('pointerdown', (e) => {
      dragging = true; at(e);
      try { rail.setPointerCapture(e.pointerId); } catch {}
    });
    rail.addEventListener('pointermove', (e) => { if (dragging) at(e); });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { rail.releasePointerCapture(e.pointerId); } catch {}
    };
    rail.addEventListener('pointerup', end);
    rail.addEventListener('pointercancel', end);
  }

  /** Oscillate the waveform. Amplitude and phase only — never the path. */
  private pulse() {
    if (this.waveTimer !== null) clearInterval(this.waveTimer);
    let t = 0;
    this.waveTimer = window.setInterval(() => {
      t += 0.12;
      const amp = 1 + Math.sin(t * 3) * 0.35 * Math.max(0, 1 - t / 2.2);
      this.waveEl.style.transform = `scaleY(${amp.toFixed(3)})`;
      if (t > 2.2) {
        this.waveEl.style.transform = 'scaleY(1)';
        clearInterval(this.waveTimer!);
        this.waveTimer = null;
      }
    }, 40);
  }

  reset() {
    this.assignments = JSON.parse(JSON.stringify(this.initial));
    // Restore the profile wheel to the seated shape's reverted voice. This is
    // the ONE case where the right wheel moves without being turned, because
    // the user asked for a revert — it is not the shape wheel driving it.
    //
    // `spin` MUST be true. With `spin: false` the face's `angle` keeps whatever
    // the user's last drag left it at while `idx` jumps to the reverted slot,
    // and the two then disagree: measured idx=0 against angle=-180 after a drag
    // to slot 2 followed by Reset. Two visible consequences — the highlighted
    // voice sits in the wrong well, and the NEXT drag silently undoes the
    // revert, because both `pointermove` and `end` recompute `idx` from `angle`
    // (Reel.ts). The `spin: false` calls elsewhere are correct: they re-seat a
    // label without moving a face the user did not turn. Here the face must
    // follow, because the selection itself changed.
    const pi = PROFILES.findIndex(p => p.id === this.assignments[this.shape].profile);
    if (pi >= 0) this.profileReel.select(pi, false, true);
    this.renderMeta();
  }
}

/*
  The drawn curve — node 63:6478, verbatim.

  An earlier version of this file invented a smooth sine here and asserted in
  its docstring that "the shape of the curve is the design." It was never the
  design's curve: the real mark is a stepped pulse envelope, 46.5x38.5, drawn
  at stroke-width 0.5 in accent orange with a Gaussian glow. Do not redraw it.
  The filter id is namespaced to avoid colliding with other inline SVGs.
*/
const WAVE_SVG = `<svg width="46.5" height="38.5" viewBox="0 0 46.5 38.5" fill="none"
  xmlns="http://www.w3.org/2000/svg" style="transform-origin:50% 50%">
  <g filter="url(#sc-wave-glow)">
    <path d="M4.25 19.25H4.35C8.49214 19.25 11.85 15.8921 11.85 11.75V7.1C11.85 5.52599 13.126 4.25 14.7 4.25C16.274 4.25 17.55 5.52599 17.55 7.1V31.4C17.55 32.974 18.826 34.25 20.4 34.25C21.974 34.25 23.25 32.974 23.25 31.4V19.25V12.725C23.25 11.151 24.526 9.875 26.1 9.875C27.674 9.875 28.95 11.151 28.95 12.725V23.9C28.95 25.474 30.226 26.75 31.8 26.75C33.374 26.75 34.65 25.474 34.65 23.9V23C34.65 20.9289 36.3289 19.25 38.4 19.25H42.25"
      stroke="#FF6200" stroke-width="0.5" stroke-linecap="round"/>
  </g>
  <defs>
    <filter id="sc-wave-glow" x="0" y="0" width="46.5" height="38.5"
      filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feColorMatrix in="SourceAlpha" type="matrix"
        values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset/>
      <feGaussianBlur stdDeviation="2"/>
      <feComposite in2="hardAlpha" operator="out"/>
      <feColorMatrix type="matrix"
        values="0 0 0 0 1 0 0 0 0 0.384314 0 0 0 0 0 0 0 0 1 0"/>
      <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
      <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
    </filter>
  </defs>
</svg>`;
