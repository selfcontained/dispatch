import type { RunnerUpdateTarget } from "@dispatch/runner-protocol";
import { vi } from "vitest";
import type {
  FenceRecord,
  FenceStore,
} from "../src/agents/remote/update-admission.js";
import type {
  RunnerUpdater,
  StageReport,
  UpdateIdentity,
} from "../src/agents/remote/update-agent.js";

export const fenceRecord: FenceRecord = {
  format: 1,
  attemptId: "6f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
  target: {
    version: "1.7.29",
    os: "linux",
    arch: "x64",
    sha256: "a".repeat(64),
    revision: "b".repeat(40),
  },
  retainSessions: true,
  phase: "fencing",
  retained: [],
};

export function memoryStore(initial: FenceRecord | null = null) {
  const store = {
    record: initial as FenceRecord | null,
    fail: false,
    read: vi.fn(async () => store.record),
    write: vi.fn(async (record: FenceRecord) => {
      if (store.fail) throw new Error("disk full");
      store.record = structuredClone(record);
    }),
    clear: vi.fn(async () => {
      store.record = null;
    }),
  };
  return store satisfies FenceStore;
}

export const identity: UpdateIdentity = {
  os: "linux",
  arch: "x64",
  version: "1.7.28",
  revision: "1".repeat(40),
  sha256: "c".repeat(64),
  handoff: { reads: [1, 2], writes: 2 },
};
export const attemptId = "6f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
export const target: RunnerUpdateTarget = {
  version: "1.7.29",
  os: "linux",
  arch: "x64",
  sha256: "a".repeat(64),
  revision: "b".repeat(40),
};
export const compatible: StageReport = {
  outcome: "staged",
  compatibility: {
    version: target.version,
    revision: target.revision,
    handoff: { reads: [1, 2], writes: 2 },
  },
};
export function mockUpdater(report: StageReport = compatible) {
  return {
    stage: vi.fn(async () => report),
    suppressed: vi.fn(async () => false),
    activate: vi.fn(async () => {}),
    confirm: vi.fn(async () => {}),
    cancelTrial: vi.fn(async () => {}),
  } satisfies RunnerUpdater;
}
