import type {
  AssistedPhase,
  AssistedUpdateState,
} from "../assisted-update-store.js";

/**
 * Wire types for the release job + SSE stream, shared with the web client.
 *
 * This module is intentionally a leaf: the web app imports these types
 * directly (type-only) via apps/web/src/hooks/use-release-stream.ts, so it
 * must not import release-runtime.js or anything that reaches
 * ../generated/runtime-assets.js — that file only exists after
 * `prepare:runtime-assets` runs, which web type checking does not do.
 * release-runtime.js re-exports everything here for server-side importers.
 */

export const RELEASE_VERSION_TYPES = ["patch", "minor", "major"] as const;
export type ReleaseVersionType = (typeof RELEASE_VERSION_TYPES)[number];

export type CreatePhase =
  | "preflight"
  | "triggering"
  | "watching"
  | "done"
  | "failed";
export type UpdatePhase =
  | "fetching"
  | "deploying"
  | "restarting"
  | "done"
  | "failed";
export type AssistedReleasePhase = AssistedPhase;
export type ReleasePhase = CreatePhase | UpdatePhase | AssistedReleasePhase;

export type ReleaseProgress = {
  step: string;
  label: string;
  detail?: string | null;
  bytesReceived?: number | null;
  totalBytes?: number | null;
};

type CommonReleaseJobFields = {
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
  progress: ReleaseProgress | null;
};

export type ReleaseJob =
  | (CommonReleaseJobFields & {
      jobType: "create";
      versionType: ReleaseVersionType;
      phase: CreatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update";
      versionType: null;
      phase: UpdatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update-assisted";
      versionType: null;
      phase: AssistedReleasePhase;
      assisted: AssistedUpdateState;
    });

export type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "progress"; progress: ReleaseProgress | null }
  | { type: "info-progress"; progress: ReleaseProgress | null }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string }
  | { type: "assisted"; state: AssistedUpdateState };
