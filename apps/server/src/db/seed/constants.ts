export const SEED_TAG = "dev-data";

export function seedMetadata(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ seed: SEED_TAG, ...extra });
}

// Deterministic PRNG so seeded data is stable across runs.
export function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// All seeded timestamps are anchored to this "now" so repeat runs produce
// identical data even as wall-clock time drifts during the same dev session.
// Uses the current date at UTC midnight so the activity heatmap lines up
// with the current day when someone boots dispatch-dev.
export function seedNow(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}
