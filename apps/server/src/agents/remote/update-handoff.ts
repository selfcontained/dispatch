import type { BuildIdentity } from "../build-identity.js";

export type HandoffFormats = { reads: readonly number[]; writes: number };

export const runnerHandoff = { reads: [1, 2], writes: 2 } as const;

export type RunnerCompatibility = BuildIdentity & { handoff: HandoffFormats };

export type RetainedHost = {
  sessionId: string;
  instanceId: string;
  build: BuildIdentity;
};

export function requiresQuiescence(
  retainedFormats: readonly (number | null)[],
  previous: HandoffFormats,
  candidate: HandoffFormats | null
): boolean {
  return (
    candidate === null ||
    !previous.reads.includes(candidate.writes) ||
    retainedFormats.some(
      (format) => format === null || !candidate.reads.includes(format)
    )
  );
}
