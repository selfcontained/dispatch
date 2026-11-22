import {
  MAX_UPDATE_RETAINED,
  encodeUpdateStatus,
  isTerminalEvent,
  parseReadyFrame,
  parseServiceFrame,
  parseSelfUpdateAdvert,
  parseUpdateServiceFrame,
  parseUpdateStatus,
  type Command,
} from "@dispatch/runner-protocol";
import {
  RunnerAcknowledgementLost,
  RunnerConnection,
  RunnerUnavailable,
  RunnerUpdateFenced,
  runnerReplyTimeoutMs,
} from "@dispatch/runner-protocol/connection";
import { describe, expect, it, vi } from "vitest";

const attemptId = "6f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
const sha256 = "a".repeat(64);
const revision = "b".repeat(40);
const target = {
  version: "1.7.29",
  os: "linux",
  arch: "x64",
  sha256,
  revision,
};
const advert = {
  protocol: 1,
  os: "linux",
  arch: "arm64",
  version: "1.7.28",
  revision,
  installedSha256: "c".repeat(64),
  handoff: { reads: [1, 2], writes: 2 },
};
const installed = { version: "1.7.28", revision, sha256: "c".repeat(64) };
const instance = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("ready.selfUpdate", () => {
  const ready = { type: "ready", version: 1, workspaces: ["@session"] };

  it("is absent unless advertised and rebuilt from known fields", () => {
    expect(parseReadyFrame(ready)).not.toHaveProperty("selfUpdate");
    const parsed = parseReadyFrame({
      ...ready,
      selfUpdate: { ...advert, extra: "x", pendingAttemptId: attemptId },
    });
    expect(parsed?.selfUpdate).toEqual({
      ...advert,
      pendingAttemptId: attemptId,
    });
    expect(parsed?.selfUpdate).not.toHaveProperty("extra");
  });

  it("preserves the explicit unreadable fence flag", () => {
    expect(
      parseReadyFrame({
        ...ready,
        selfUpdate: { ...advert, fenceUnreadable: true },
      })?.selfUpdate
    ).toEqual({ ...advert, fenceUnreadable: true });
  });

  it.each([
    ["protocol", { protocol: 2 }],
    ["os", { os: "darwin" }],
    ["arch", { arch: "ia32" }],
    ["short revision", { revision: "b".repeat(12) }],
    ["null revision", { revision: null }],
    ["digest", { installedSha256: "A".repeat(64) }],
    ["empty reads", { handoff: { reads: [], writes: 2 } }],
    ["zero format", { handoff: { reads: [0], writes: 2 } }],
    ["too many reads", { handoff: { reads: Array(33).fill(1), writes: 1 } }],
    ["pending attempt", { pendingAttemptId: "not-a-uuid" }],
    ["string unreadable flag", { fenceUnreadable: "true" }],
    ["false unreadable flag", { fenceUnreadable: false }],
    ["ambiguous fence", { fenceUnreadable: true, pendingAttemptId: attemptId }],
  ])(
    "drops a malformed advert (%s) without failing the handshake",
    (_, change) => {
      expect(parseSelfUpdateAdvert({ ...advert, ...change })).toBeNull();
      const parsed = parseReadyFrame({
        ...ready,
        selfUpdate: { ...advert, ...change },
      });
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty("selfUpdate");
    }
  );
});

describe("service update frames", () => {
  it.each([
    { type: "update_offer", attemptId, target, retry: false },
    { type: "update_fence", attemptId, retainSessions: true },
    { type: "update_activate", attemptId },
    { type: "update_confirm", attemptId, revision, sha256 },
    { type: "update_cancel", attemptId, reason: "quiesce_timeout" },
  ])("accepts $type and rebuilds it", (frame) => {
    const parsed = parseServiceFrame({ ...frame, extra: { large: true } });
    expect(parsed).toEqual(frame);
    expect(parsed).not.toHaveProperty("extra");
    expect(parseUpdateServiceFrame(frame)).toEqual(frame);
  });

  it.each([
    ["missing attempt", { type: "update_activate" }],
    [
      "uppercase attempt",
      { type: "update_activate", attemptId: attemptId.toUpperCase() },
    ],
    ["retry type", { type: "update_offer", attemptId, target, retry: "no" }],
    [
      "target os",
      {
        type: "update_offer",
        attemptId,
        target: { ...target, os: "darwin" },
        retry: false,
      },
    ],
    [
      "target arch",
      {
        type: "update_offer",
        attemptId,
        target: { ...target, arch: "riscv" },
        retry: false,
      },
    ],
    [
      "target digest",
      {
        type: "update_offer",
        attemptId,
        target: { ...target, sha256: "a".repeat(63) },
        retry: false,
      },
    ],
    [
      "abbreviated revision",
      {
        type: "update_offer",
        attemptId,
        target: { ...target, revision: "b".repeat(12) },
        retry: false,
      },
    ],
    [
      "target version",
      {
        type: "update_offer",
        attemptId,
        target: { ...target, version: "v1" },
        retry: false,
      },
    ],
    ["fence flag", { type: "update_fence", attemptId, retainSessions: 1 }],
    [
      "confirm digest",
      { type: "update_confirm", attemptId, revision, sha256: "x" },
    ],
    ["cancel reason", { type: "update_cancel", attemptId, reason: "because" }],
    ["unknown update frame", { type: "update_rename", attemptId }],
  ])("rejects %s", (_, frame) => {
    expect(parseServiceFrame(frame)).toBeNull();
  });

  it("leaves existing frames to their v1 validation", () => {
    const frame = { type: "accept_health", engineInventory: true, extra: 1 };
    expect(parseServiceFrame(frame)).toBe(frame);
  });
});

describe("update_status", () => {
  const status = {
    type: "update_status",
    attemptId,
    phase: "deferred",
    reason: "fence_ready",
    installed,
    retained: [{ sessionId: "agt_one", instanceId: instance(1) }],
    requiresQuiescence: false,
  };

  it("accepts a status and drops fields outside the contract", () => {
    const parsed = parseUpdateStatus({
      ...status,
      retained: [{ ...status.retained[0], command: "/opt/x", pid: 4 }],
      path: "/var/lib",
    });
    expect(parsed).toEqual(status);
  });

  it("carries the floor only on a downgrade refusal", () => {
    const refused = { ...status, reason: "downgrade", floorVersion: "1.7.31" };
    expect(parseUpdateStatus(refused)).toEqual(refused);
    for (const change of [
      { reason: "ready" },
      { floorVersion: "latest" },
      { floorVersion: null },
      { floorVersion: `1.${"0".repeat(64)}` },
    ])
      expect(parseUpdateStatus({ ...refused, ...change })).toBeNull();
  });

  it("reports a cleared fence only as a cancellation", () => {
    const { retained: _, ...base } = status;
    const cleared = {
      ...base,
      phase: "deferred",
      reason: "cancelled",
      fenceCleared: true,
    };
    expect(parseUpdateStatus(cleared)).toEqual(cleared);
    for (const change of [
      { fenceCleared: false },
      { phase: "rolled_back" },
      { reason: "ready" },
    ])
      expect(parseUpdateStatus({ ...cleared, ...change })).toBeNull();
  });

  it("sends an interrupted trial in terms an older service accepts", () => {
    // The closed vocabulary of a service from before the reason existed.
    const olderReasons = [
      "staging",
      "ready",
      "incompatible_handoff",
      "operations_pending",
      "fence_ready",
      "trial",
      "verify_failed",
      "downgrade",
      "boot_failed",
      "confirm_timeout",
      "reattach_failed",
      "suppressed",
      "cancelled",
    ];
    for (const phase of ["deferred", "rolled_back"] as const) {
      const frame = {
        type: "update_status" as const,
        attemptId,
        phase,
        reason: "trial_interrupted" as const,
        installed,
      };
      const wire = encodeUpdateStatus(frame);
      expect(olderReasons).toContain(wire.reason);
      expect(wire).toEqual({
        ...frame,
        reason: "cancelled",
        interrupted: true,
      });
      expect(parseUpdateStatus(wire)).toEqual(frame);
      expect(parseUpdateStatus(frame)).toEqual(frame);
      for (const change of [
        { interrupted: false },
        { reason: "confirm_timeout" },
        { phase: "confirmed" },
        { phase: "deferred", fenceCleared: true },
      ])
        expect(parseUpdateStatus({ ...wire, ...change })).toBeNull();
      // A real cancellation stays one, and other reasons travel unchanged.
      const cancelled = { ...frame, reason: "cancelled" as const };
      expect(encodeUpdateStatus(cancelled)).toBe(cancelled);
      expect(parseUpdateStatus(cancelled)).toEqual(cancelled);
    }
  });

  it("bounds the retained inventory", () => {
    const retained = Array.from({ length: MAX_UPDATE_RETAINED }, (_, n) => ({
      sessionId: `agt_${n}`,
      instanceId: instance(n),
    }));
    expect(parseUpdateStatus({ ...status, retained })?.retained).toHaveLength(
      MAX_UPDATE_RETAINED
    );
    expect(
      parseUpdateStatus({
        ...status,
        retained: [
          ...retained,
          { sessionId: "agt_x", instanceId: instance(99_999) },
        ],
      })
    ).toBeNull();
  });

  it.each([
    ["phase", { phase: "renaming" }],
    ["reason", { reason: "unknown" }],
    ["installed", { installed: { ...installed, revision: null } }],
    ["requiresQuiescence", { requiresQuiescence: "yes" }],
    ["retained shape", { retained: {} }],
    ["instance", { retained: [{ sessionId: "agt_one", instanceId: "x" }] }],
    ["session", { retained: [{ sessionId: "", instanceId: instance(1) }] }],
    [
      "duplicate instance",
      {
        retained: [
          { sessionId: "agt_one", instanceId: instance(1) },
          { sessionId: "agt_two", instanceId: instance(1) },
        ],
      },
    ],
  ])("rejects a bad %s", (_, change) => {
    expect(parseUpdateStatus({ ...status, ...change })).toBeNull();
  });
});

describe("existing envelopes", () => {
  it("surfaces update-fenced as a definite not-started error", async () => {
    const sent: { id: string }[] = [];
    const connection = new RunnerConnection((frame) =>
      sent.push(frame as { id: string })
    );
    const command = {
      kind: "alive",
      agentId: "agt_one",
      workspace: "@session",
    } as Command;
    const fenced = connection.request(command);
    connection.receive({
      type: "result",
      id: sent[0]!.id,
      code: "update-fenced",
      error: "The runner is updating; the operation was not started.",
    });
    await expect(fenced).rejects.toBeInstanceOf(RunnerUpdateFenced);
    await expect(fenced).rejects.not.toBeInstanceOf(RunnerUnavailable);
  });

  it("tells a reply lost to a closed connection from one never sent or timed out", async () => {
    const sent: { id: string }[] = [];
    const command = {
      kind: "alive",
      agentId: "agt_one",
      workspace: "@session",
    } as Command;
    const connection = new RunnerConnection((frame) =>
      sent.push(frame as { id: string })
    );
    const lost = connection.request(command);
    connection.close();
    await expect(lost).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
    await expect(lost).rejects.toBeInstanceOf(RunnerUnavailable);
    await expect(lost).rejects.toThrow("execution is unknown");
    // Closed before sending: never started.
    const closed = connection.request(command);
    await expect(closed).rejects.toBeInstanceOf(RunnerUnavailable);
    await expect(closed).rejects.not.toBeInstanceOf(RunnerAcknowledgementLost);
    // A failed write.
    const broken = new RunnerConnection(() => {
      throw new Error("EPIPE");
    });
    await expect(broken.request(command)).rejects.not.toBeInstanceOf(
      RunnerAcknowledgementLost
    );
    // A timeout leaves the operation possibly still running there.
    vi.useFakeTimers();
    try {
      const slow = new RunnerConnection(() => {});
      const pending = slow.request(command);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(runnerReplyTimeoutMs(command));
      const error = await settled;
      expect(error).toBeInstanceOf(RunnerUnavailable);
      expect(error).not.toBeInstanceOf(RunnerAcknowledgementLost);
      expect((error as Error).message).toBe(
        "Runner acknowledgement was lost; execution is unknown."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts an optional UUID launch ID and the reconcile capability", () => {
    const launch = (launchId: unknown) => ({
      type: "request",
      id: "req-1",
      command: {
        kind: "launch",
        agentId: "agt_one",
        workspace: "@session",
        launch: {
          agentId: "agt_one",
          engine: "codex",
          model: null,
          systemPrompt: null,
          resumeSessionId: null,
          ...(launchId !== undefined && { launchId }),
        },
      },
    });
    expect(parseServiceFrame(launch(undefined))).not.toBeNull();
    expect(parseServiceFrame(launch(attemptId))).not.toBeNull();
    for (const bad of ["", "not-a-uuid", 7, null, attemptId.toUpperCase()])
      expect(parseServiceFrame(launch(bad))).toBeNull();

    const ready = { type: "ready", version: 1, workspaces: ["@session"] };
    expect(parseReadyFrame(ready)).not.toHaveProperty("launchReconcile");
    expect(
      parseReadyFrame({ ...ready, launchReconcile: "yes" })
    ).not.toHaveProperty("launchReconcile");
    expect(parseReadyFrame({ ...ready, launchReconcile: true })).toMatchObject({
      launchReconcile: true,
    });
  });

  it("keeps the reply deadlines", () => {
    const base = { agentId: "agt_one", workspace: "@session" };
    expect(runnerReplyTimeoutMs({ ...base, kind: "alive" } as Command)).toBe(
      20_000
    );
    expect(
      runnerReplyTimeoutMs({
        ...base,
        kind: "viewCheckout",
        query: { kind: "changes" },
      } as unknown as Command)
    ).toBe(300_000);
    expect(
      runnerReplyTimeoutMs({
        ...base,
        kind: "launch",
        launch: { prepareWorkspace: true },
      } as unknown as Command)
    ).toBe(300_000);
  });

  it("accepts only the update reason on a terminal error", () => {
    expect(
      isTerminalEvent({ type: "error", message: "closed", reason: "update" })
    ).toBe(true);
    expect(isTerminalEvent({ type: "error", message: "closed" })).toBe(true);
    expect(
      isTerminalEvent({ type: "error", message: "closed", reason: "other" })
    ).toBe(false);
  });
});
