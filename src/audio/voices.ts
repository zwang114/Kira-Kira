/**
 * Synth voices, ported from glyph-studio's `audio/audioEngine.ts` (:124-422).
 *
 * The synthesis below is carried over essentially verbatim — it is hand-tuned
 * and the tuning is not obvious from reading it. The ADSR in particular encodes
 * a fix worth preserving: a flat sustain plateau, without which long merged-run
 * notes decay to half volume by their midpoint.
 *
 * WHAT CHANGED IN THE SHAPE-AWARE PASS
 *
 * `playNote` used to take a `DotShape` and branch on it, which hardwired
 * shape → voice. That model is wrong for v2. A dot's shape is assigned by
 * BRIGHTNESS (field.ts: square darkest → cross lightest), and the user picks,
 * per shape, which of four SOUND PROFILES it plays via the Sound Config
 * overlay. So shape does not select a voice; it selects an ASSIGNMENT SLOT,
 * and the assignment names the profile.
 *
 * `playNote` therefore takes a `VoiceProfile` — the thing actually being
 * synthesized — and knows nothing about shapes, grids or dither. The
 * shape → profile lookup happens one level up, in `engine.ts`, against the
 * assignment map that `SoundConfig` produces.
 *
 * DEAD BRANCHES, DELIBERATELY KEPT
 *
 * `marimba` and `pad` (formerly the `triangle` and `star` shapes) are no longer
 * reachable: v2 has four shapes and four profiles, and no default assignment
 * names either one. They are retained rather than deleted — see the comment at
 * `PROFILE_LABELS`. `voices.v1.ts` is a byte copy of this file before the
 * change, kept as the reference for the pre-v2 shape-keyed signature.
 */

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

/**
 * The synthesis voices, named for what they SOUND like rather than for a shape.
 *
 * The rename is the whole point of the pass: `circle` as a voice name meant
 * "the voice that circles happen to play", which stopped being true the moment
 * the user could assign any profile to any shape. Each id below maps 1:1 to a
 * branch in `playNote`, and the old shape name is noted so the port back to
 * `voices.v1.ts` is unambiguous.
 */
export type VoiceProfile =
  | 'piano'    // was shape 'circle'
  | 'keys'     // was shape 'square'
  | 'rhodes'   // was shape 'diamond'
  | 'marimba'  // was shape 'triangle' — UNREACHABLE in v2, see below
  | 'pad'      // was shape 'star'     — UNREACHABLE in v2, see below
  | 'guitar';  // was shape 'cross'

export const PROFILE_LABELS: Record<VoiceProfile, string> = {
  piano: 'piano',
  keys: 'keys',
  rhodes: 'rhodes',
  marimba: 'marimba',
  pad: 'pad',
  guitar: 'guitar',
};

/**
 * DEAD CODE, KEPT ON PURPOSE — do not delete `marimba` or `pad`.
 *
 * v2 has four shapes and four profile slots (`sp1..sp4`), and `PROFILE_BY_ID`
 * in `engine.ts` maps those four slots onto piano / keys / rhodes / guitar. No
 * assignment can currently name marimba or pad, so their branches in `playNote`
 * never run.
 *
 * They stay because they are ~130 lines of hand-tuned Web Audio with no test
 * and no ear-verification behind them. Deleting them would mean reconstructing
 * tuning that was never validated in the first place if a fifth or sixth
 * profile is ever wanted. Reaching them again costs one line in `PROFILE_BY_ID`.
 */
export const UNREACHABLE_PROFILES: VoiceProfile[] = ['marimba', 'pad'];

export function playNote(
  freq: number,
  profile: VoiceProfile,
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

  /*
    TEAR THE NOTE DOWN WHEN IT FINISHES.

    Calling `stop()` on an oscillator makes IT collectable, but every gain and
    filter it fed stays connected to the destination for as long as the
    destination lives — and the sequence bus lives for the whole session. So
    each note leaked ~8 nodes into a graph that is never rebuilt.

    That was invisible for the playhead sweep: ~100 notes, then `stop()` tears
    the whole bus down. The aim chime is different in kind — it plays
    continuously at hundreds of notes per second, so the leak compounds until
    the audio thread cannot render in real time. Measured before this fix: the
    context clock held 1.0 for ~11 seconds and then collapsed to 0.17-0.36 and
    stayed there, which is exactly the reported "sound stops after a while".

    One `onended` on the note's own envelope is enough: disconnecting
    `masterGain` and `hpf` detaches the whole subtree from the destination, and
    everything upstream is then unreachable and collectable.
  */
  /*
    The pad's tremolo LFO reaches `masterGain.gain` — an AudioParam, not a node
    input. `masterGain.disconnect()` with no arguments severs only its OUTGOING
    edges, so that incoming param connection survives and the LFO pair stays
    reachable: ~2 nodes leaked per pad note, which is the same class of leak
    this teardown exists to fix.

    Declared out here rather than in the branch so the closure can reach them;
    they stay null for every other voice, and the optional calls below are
    no-ops in that case. `pad` is currently unreachable (it is not in
    `PROFILE_BY_ID`), so this leaks nothing today — it is fixed now so that
    wiring the profile up later cannot silently reintroduce the ~11-second
    audio-death regression in a voice nobody would think to suspect.
  */
  let padLfo: OscillatorNode | null = null;
  let padLfoGain: GainNode | null = null;

  const teardown = () => {
    try { masterGain.disconnect(); } catch { /* already gone */ }
    try { hpf.disconnect(); } catch { /* already gone */ }
    // Severs the AudioParam edge that `masterGain.disconnect()` cannot reach.
    try { padLfoGain?.disconnect(); } catch { /* not a pad note */ }
    try { padLfo?.disconnect(); } catch { /* not a pad note */ }
  };

  /*
    A silent timer node, rather than hanging `onended` off one of the voice
    oscillators.

    Each branch below starts a different set of sources with different stop
    times (the guitar's `cStop`, the pad's LFO, the marimba's short bell), so
    picking "the last one" would mean six separate correct answers and a new
    leak every time a voice is edited. This node belongs to no branch: it is
    connected to nothing, produces no sound, and simply outlives the longest
    possible envelope.
  */
  const life = context.createConstantSource();
  life.offset.value = 0;
  life.onended = teardown;
  life.start(t);
  /*
    Outlive the longest source in ANY branch, and no longer.

    This was `Math.max(oscStop, t + duration + 1.0) + 0.2`, i.e. always at least
    `duration + 1.2s`. That blanket second was a worst-case guess, and it is the
    quantity that governs how many nodes are alive at once — node population is
    (notes per second) x (this lifetime), NOT the ring time. It made a shorter
    chime MORE expensive rather than less: at a 0.18s ring the note still held
    its subtree for 1.38s, so raising the chime rate raised live nodes with it.

    The real bound is the guitar's `ringTail`, which is explicitly clamped to a
    1.0s maximum below, so its last source stops at `t + 1.05`. Every other
    branch stops at `oscStop` (= t + duration + release + 0.03). Taking the max
    of those two plus a 0.1s margin covers all six voices exactly, and drops the
    per-note node lifetime by ~1s at chime durations.
  */
  const GUITAR_MAX_TAIL = 1.05;   // ringTail is clamped to <= 1.0, + 0.05
  life.stop(Math.max(oscStop, t + GUITAR_MAX_TAIL) + 0.1);

  if (profile === 'piano') {
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

  } else if (profile === 'keys') {
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

  } else if (profile === 'rhodes') {
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

  } else if (profile === 'marimba') {
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

  } else if (profile === 'pad') {
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

    padLfo = context.createOscillator();
    padLfo.type = 'sine';
    padLfo.frequency.setValueAtTime(2.0, t);
    padLfoGain = context.createGain();
    padLfoGain.gain.setValueAtTime(0.3, t);
    padLfo.connect(padLfoGain);
    padLfoGain.connect(masterGain.gain);

    const padHpf = context.createBiquadFilter();
    padHpf.type = 'highpass';
    padHpf.frequency.setValueAtTime(200, t);
    padHpf.Q.setValueAtTime(0.5, t);
    carrierMix.connect(padHpf);
    padHpf.connect(masterGain);

    carrier1.start(t); carrier1.stop(oscStop);
    carrier2.start(t); carrier2.stop(oscStop);
    padLfo.start(t); padLfo.stop(oscStop);

  } else if (profile === 'guitar') {
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
