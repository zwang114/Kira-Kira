/**
 * Synth voices, ported from glyph-studio's `audio/audioEngine.ts` (:124-422).
 *
 * These are carried over essentially verbatim — they are hand-tuned and the
 * tuning is not obvious from reading them. The ADSR in particular encodes a
 * fix worth preserving: a flat sustain plateau, without which long merged-run
 * notes decay to half volume by their midpoint.
 *
 * The one structural change: the original selects a voice by the per-cell
 * PixelShape, because a hand-drawn glyph has varied shapes. Every dot here
 * comes from the same dither pass, so shape is a single global choice per
 * capture — the same six voices, chosen once rather than per cell.
 */

import type { DotShape } from '../render/drawGrid';

/**
 * Shared noise buffer for the 'cross' voice's pick attack.
 *
 * Cached per-module, which is only safe because the AudioContext is never
 * closed or recreated. An AudioBuffer belongs to the context that made it, so
 * if the context is ever torn down this must be invalidated with it.
 */
let noiseBuffer: AudioBuffer | null = null;
let noiseBufferCtx: AudioContext | null = null;

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBufferCtx !== context) {
    const length = Math.floor(context.sampleRate * 0.5);
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    noiseBufferCtx = context;
  }
  return noiseBuffer;
}

export const VOICE_LABELS: Record<DotShape, string> = {
  circle: 'piano',
  square: 'keys',
  diamond: 'rhodes',
  triangle: 'marimba',
  star: 'pad',
  cross: 'guitar',
};

export function playNote(
  freq: number,
  shape: DotShape,
  gain: number,
  startTime: number,
  duration: number,
  context: AudioContext,
  destination: AudioNode
): void {
  const t = startTime;

  // ADSR. The `setValueAtTime(sustainLevel, t + duration)` line is the one that
  // makes long sustained notes actually hold their level instead of sagging.
  const attack = 0.012;
  const decay = 0.12;
  const sustainLevel = gain * 0.8;
  const releaseTime = Math.max(0.04, Math.min(duration * 0.15, 0.08));
  const envelopeEnd = t + duration + releaseTime;
  // Oscillators stop only AFTER the envelope reaches silence, so the hard stop
  // never cuts a live waveform (which would click).
  const oscStop = envelopeEnd + 0.03;

  const masterGain = context.createGain();
  masterGain.gain.setValueAtTime(0.0001, t);
  masterGain.gain.exponentialRampToValueAtTime(gain, t + attack);
  const sustainStart = Math.min(t + attack + decay, t + duration);
  masterGain.gain.exponentialRampToValueAtTime(sustainLevel, sustainStart);
  masterGain.gain.setValueAtTime(sustainLevel, t + duration);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, envelopeEnd);

  // Tames DC offset and sub-rumble from modulation swings — a common source of
  // low-frequency pop at note boundaries.
  const hpf = context.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.setValueAtTime(60, t);
  hpf.Q.setValueAtTime(0.707, t);
  masterGain.connect(hpf);
  hpf.connect(destination);

  if (shape === 'circle') {
    // Bright lo-fi piano: sine fundamental + octave + brief 3× sparkle.
    const fundamental = context.createOscillator();
    fundamental.type = 'sine';
    fundamental.frequency.setValueAtTime(freq, t);

    const octave = context.createOscillator();
    octave.type = 'sine';
    octave.frequency.setValueAtTime(freq * 2, t);
    const octaveGain = context.createGain();
    octaveGain.gain.setValueAtTime(0.28, t);

    const sparkle = context.createOscillator();
    sparkle.type = 'sine';
    sparkle.frequency.setValueAtTime(freq * 3, t);
    const sparkleGain = context.createGain();
    sparkleGain.gain.setValueAtTime(0.08, t);
    sparkleGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

    fundamental.connect(masterGain);
    octave.connect(octaveGain); octaveGain.connect(masterGain);
    sparkle.connect(sparkleGain); sparkleGain.connect(masterGain);

    fundamental.start(t); fundamental.stop(oscStop);
    octave.start(t); octave.stop(oscStop);
    sparkle.start(t); sparkle.stop(t + 0.1);

  } else if (shape === 'square') {
    // Warm mid keys: triangle body through a fixed lowpass + octave sparkle.
    const body = context.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(freq, t);

    const bright = context.createOscillator();
    bright.type = 'sine';
    bright.frequency.setValueAtTime(freq * 2, t);
    const brightGain = context.createGain();
    brightGain.gain.setValueAtTime(0.15, t);

    const thump = context.createBiquadFilter();
    thump.type = 'lowpass';
    thump.frequency.setValueAtTime(2200, t);
    thump.Q.setValueAtTime(0.5, t);

    body.connect(thump); thump.connect(masterGain);
    bright.connect(brightGain); brightGain.connect(masterGain);

    body.start(t); body.stop(oscStop);
    bright.start(t); bright.stop(oscStop);

  } else if (shape === 'diamond') {
    // Rhodes-ish: triangle tine + quiet filtered saw for the bell buzz.
    const tine = context.createOscillator();
    tine.type = 'triangle';
    tine.frequency.setValueAtTime(freq, t);

    const buzz = context.createOscillator();
    buzz.type = 'sawtooth';
    buzz.frequency.setValueAtTime(freq, t);
    const buzzGain = context.createGain();
    buzzGain.gain.setValueAtTime(0.18, t);

    const toneFilter = context.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.setValueAtTime(freq * 9, t);
    toneFilter.frequency.exponentialRampToValueAtTime(freq * 7, t + 0.3);
    toneFilter.Q.setValueAtTime(2.0, t);

    tine.connect(toneFilter);
    buzz.connect(buzzGain); buzzGain.connect(toneFilter);
    toneFilter.connect(masterGain);

    tine.start(t); tine.stop(oscStop);
    buzz.start(t); buzz.stop(oscStop);

  } else if (shape === 'triangle') {
    // Vibraphone/marimba: root sine + fast-decaying 4× metallic overtone.
    const root = context.createOscillator();
    root.type = 'sine';
    root.frequency.setValueAtTime(freq, t);

    const bell = context.createOscillator();
    bell.type = 'sine';
    bell.frequency.setValueAtTime(freq * 4.0, t);
    const bellGain = context.createGain();
    bellGain.gain.setValueAtTime(0.28, t);
    bellGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

    root.connect(masterGain);
    bell.connect(bellGain); bellGain.connect(masterGain);

    root.start(t); root.stop(oscStop);
    bell.start(t); bell.stop(t + 0.15);

  } else if (shape === 'star') {
    // Airy pad: two detuned carriers with 2Hz tremolo.
    const carrier1 = context.createOscillator();
    carrier1.type = 'sine';
    carrier1.frequency.setValueAtTime(freq, t);
    carrier1.detune.setValueAtTime(-6, t);

    const carrier2 = context.createOscillator();
    carrier2.type = 'sine';
    carrier2.frequency.setValueAtTime(freq, t);
    carrier2.detune.setValueAtTime(+6, t);

    const carrierMix = context.createGain();
    carrierMix.gain.setValueAtTime(0.5, t);
    carrier1.connect(carrierMix);
    carrier2.connect(carrierMix);

    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(2.0, t);
    const lfoGain = context.createGain();
    lfoGain.gain.setValueAtTime(0.3, t);
    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);

    const padHpf = context.createBiquadFilter();
    padHpf.type = 'highpass';
    padHpf.frequency.setValueAtTime(200, t);
    padHpf.Q.setValueAtTime(0.5, t);
    carrierMix.connect(padHpf);
    padHpf.connect(masterGain);

    carrier1.start(t); carrier1.stop(oscStop);
    carrier2.start(t); carrier2.stop(oscStop);
    lfo.start(t); lfo.stop(oscStop);

  } else if (shape === 'cross') {
    // Reverb guitar. Overrides the shared ADSR: a plucked string decays from
    // peak immediately rather than sustaining flat.
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(0.0001, t);
    masterGain.gain.exponentialRampToValueAtTime(gain * 1.05, t + 0.006);
    const ringTail = Math.max(0.5, Math.min(1.0, duration + 0.4));
    masterGain.gain.exponentialRampToValueAtTime(0.0001, t + ringTail);

    const detune = 6;
    const tri1 = context.createOscillator();
    tri1.type = 'triangle';
    tri1.frequency.setValueAtTime(freq, t);
    tri1.detune.setValueAtTime(-detune, t);
    const tri2 = context.createOscillator();
    tri2.type = 'triangle';
    tri2.frequency.setValueAtTime(freq, t);
    tri2.detune.setValueAtTime(+detune, t);
    const saw = context.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(freq, t);

    const bodyMix = context.createGain();
    bodyMix.gain.setValueAtTime(0.55, t);
    const sawMix = context.createGain();
    sawMix.gain.setValueAtTime(0.22, t);
    tri1.connect(bodyMix);
    tri2.connect(bodyMix);
    saw.connect(sawMix);

    const noise = context.createBufferSource();
    noise.buffer = getNoiseBuffer(context);
    const noiseHpf = context.createBiquadFilter();
    noiseHpf.type = 'highpass';
    noiseHpf.frequency.setValueAtTime(1800, t);
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(gain * 0.3, t + 0.003);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    noise.connect(noiseHpf); noiseHpf.connect(noiseGain);

    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.setValueAtTime(1.1, t);
    tone.frequency.setValueAtTime(Math.max(1400, freq * 4), t);
    tone.frequency.exponentialRampToValueAtTime(Math.max(900, freq * 2.4), t + 0.25);

    bodyMix.connect(tone);
    sawMix.connect(tone);
    noiseGain.connect(tone);
    tone.connect(masterGain);

    const cStop = t + ringTail + 0.05;
    tri1.start(t); tri1.stop(cStop);
    tri2.start(t); tri2.stop(cStop);
    saw.start(t); saw.stop(cStop);
    noise.start(t); noise.stop(t + 0.06);
  }
}
