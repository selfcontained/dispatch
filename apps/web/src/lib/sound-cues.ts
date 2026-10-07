/**
 * Synthesized audio cues for agent events. Uses Web Audio API to generate
 * tones at runtime (no asset files). Each cue is a small sequence of
 * envelope-shaped oscillators tuned to feel tactile, not alarming.
 */

let ctx: AudioContext | null = null;
let unlocked = false;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * iOS Safari keeps the AudioContext suspended until a user gesture, and even
 * after resume() it sometimes drops the first scheduled audio. Playing a 1-frame
 * silent buffer during the gesture fully primes the output graph so subsequent
 * scheduled tones are audible. Safe to call repeatedly.
 */
function unlockAudio(): void {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  if (unlocked) return;
  try {
    const buffer = c.createBuffer(1, 1, 22050);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    source.start(0);
    unlocked = true;
  } catch {
    // ignore — will retry on next gesture
  }
}

if (typeof window !== "undefined") {
  const handler = () => unlockAudio();
  window.addEventListener("pointerdown", handler);
  window.addEventListener("touchstart", handler, { passive: true });
  window.addEventListener("keydown", handler);
}

type Tone = {
  freq: number;
  startSec: number;
  durSec: number;
  type?: OscillatorType;
  gain?: number;
};

function playTones(tones: Tone[], masterGain = 0.18): void {
  unlockAudio();
  const c = getContext();
  if (!c) return;
  // Small lookahead so iOS Safari has time to actually start the context
  // when this call is the first audio after a resume().
  const now = c.currentTime + 0.02;
  const master = c.createGain();
  master.gain.value = masterGain;
  master.connect(c.destination);
  for (const t of tones) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = t.type ?? "sine";
    osc.frequency.value = t.freq;
    const peak = t.gain ?? 1;
    const start = now + t.startSec;
    const end = start + t.durSec;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env);
    env.connect(master);
    osc.start(start);
    osc.stop(end + 0.04);
  }
}

export type CueIntent = "blocked" | "waiting_user";

type SoundCue = {
  id: string;
  intent: CueIntent;
  play: () => void;
};

const SOUND_CUES: SoundCue[] = [
  {
    id: "blocked-thud",
    intent: "blocked",
    play: () =>
      playTones(
        [
          { freq: 246.94, startSec: 0, durSec: 0.18, type: "triangle" },
          { freq: 196.0, startSec: 0.12, durSec: 0.3, type: "triangle" },
        ],
        0.2
      ),
  },
  {
    id: "waiting-nudge",
    intent: "waiting_user",
    play: () =>
      playTones([
        { freq: 659.25, startSec: 0, durSec: 0.14 },
        { freq: 659.25, startSec: 0.2, durSec: 0.16, gain: 0.7 },
      ]),
  },
];

export const CUE_INTENTS: Array<{
  intent: CueIntent;
  label: string;
  description: string;
}> = [
  {
    intent: "waiting_user",
    label: "Waiting for input",
    description: "Agent needs your response.",
  },
  {
    intent: "blocked",
    label: "Blocked",
    description: "Agent is stuck with no further approach to try.",
  },
];

const cueByIntent = new Map(SOUND_CUES.map((c) => [c.intent, c]));

/** Play the cue for an event intent. */
export function playCueForIntent(intent: CueIntent): void {
  cueByIntent.get(intent)?.play();
}

/**
 * Short, quiet click used for mobile UI feedback (e.g. on-screen keyboard
 * shortcut taps). Each call jitters pitch, waveform, gain, duration, and
 * sometimes adds a softer overtone so repeated taps feel organic.
 */
export function playTapCue(): void {
  // ±250 cents ≈ ±2.5 semitones — clearly varied, still within a tap family
  const pitchMul = 2 ** ((Math.random() - 0.5) * (500 / 1200));
  const freq = 1400 * pitchMul;
  const durSec = 0.028 + Math.random() * 0.028;
  const masterGain = 0.065 + Math.random() * 0.045;
  const type: OscillatorType = Math.random() < 0.5 ? "triangle" : "sine";
  const tones: Tone[] = [{ freq, startSec: 0, durSec, type }];
  // ~35% of taps get a quieter overtone a fifth or octave up for color
  if (Math.random() < 0.35) {
    const overtoneRatio = Math.random() < 0.5 ? 1.5 : 2;
    tones.push({
      freq: freq * overtoneRatio,
      startSec: 0,
      durSec: durSec * 0.7,
      type: "sine",
      gain: 0.35 + Math.random() * 0.25,
    });
  }
  playTones(tones, masterGain);
  // Paired haptic so Android devices with the ringer muted still feel the
  // tap. iOS Safari has no vibration API; this is a silent no-op there.
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(8 + Math.floor(Math.random() * 7));
  }
}
