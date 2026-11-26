import {
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { createEnrolledCheckoutRunner } from "../src/runners/enrolled/checkout.js";
import type { CheckoutSession } from "../src/runners/directory.js";

const placement = { runner: "runner-a", workspace: "@managed" };
const agentId = "agt_archive1";
const session = sessionFromWire(agentId);
const observed = {
  ownership: "owned",
  owner: agentId,
  borrowers: ["agt_review"],
  checkout: null,
};
const release = {
  deleteBranch: true,
  originalBranch: "agt/topic",
};

function service(options: { capable?: boolean; epochs?: number[] } = {}) {
  const epochs = [...(options.epochs ?? [7])];
  let epoch = epochs[0];
  const requestSession = vi.fn(
    async (
      _placement: unknown,
      operation: { kind: string; operation?: { kind?: string } }
    ) => {
      epoch = epochs.shift() ?? epoch;
      return {
        value:
          operation.kind === "workspaceRelease"
            ? JSON.stringify({ removed: true })
            : JSON.stringify(observed),
      };
    }
  );
  return {
    requestSession,
    connectionEpoch: vi.fn(() => epoch),
    supportsWorkspaceRelease: vi.fn(() => options.capable ?? true),
  };
}

function adapter(remote: ReturnType<typeof service>) {
  return createEnrolledCheckoutRunner(
    remote as unknown as RemoteRunnerService,
    placement.runner,
    placement,
    { id: agentId } as CheckoutSession,
    () => ({}) as never
  );
}

describe("archive operations on an enrolled runner", () => {
  it("send the archive transport's frames, on its pinned connection", async () => {
    const viaAdapter = service();
    const runner = adapter(viaAdapter);
    expect(await runner.call("workspace.observe", { session })).toEqual(
      observed
    );
    expect(
      await runner.call("workspace.release", { session, ...release })
    ).toEqual({ removed: true });

    // As sent: `requestSession` stamps the placement's workspace on each.
    const frames = (remote: ReturnType<typeof service>) =>
      remote.requestSession.mock.calls.map(([where, operation, , , epoch]) => [
        where,
        { ...operation, workspace: placement.workspace },
        epoch,
      ]);

    expect(frames(viaAdapter).map(([, , epoch]) => epoch)).toEqual([7, 7]);
  });

  it.each([
    ["a forced archive (ownership alone)", "ownership"],
    ["a decision on the checkout's state", "changes"],
  ] as const)(
    "observe for %s sends the archive transport's own frame",
    async (_case, policy) => {
      const viaAdapter = service();
      await adapter(viaAdapter).call("workspace.observe", {
        session,
        ...(policy === "ownership" && { policy }),
      });
      // Byte for byte, as `requestSession` writes it (workspace appended).
      const sent = (remote: ReturnType<typeof service>) =>
        JSON.stringify({
          ...(remote.requestSession.mock.calls[0]![1] as object),
          workspace: placement.workspace,
        });
      expect(JSON.parse(sent(viaAdapter))).toMatchObject({
        kind: "checkoutRelease",
        operation: { kind: "observe", policy },
      });
    }
  );

  it("releases only on the connection that was observed", async () => {
    // The runner reconnects (epoch 8) between observe and release.
    const remote = service({ epochs: [7, 8] });
    const runner = adapter(remote);
    await runner.call("workspace.observe", { session });
    await runner.call("workspace.release", { session, ...release });
    expect(remote.requestSession.mock.calls.map((call) => call[4])).toEqual([
      7, 7,
    ]);
  });

  it("refuse another session's checkout", async () => {
    const remote = service();
    await expect(
      adapter(remote).call("workspace.observe", {
        session: sessionFromWire("agt_other"),
      })
    ).rejects.toBeInstanceOf(RunnerCallError);
    expect(remote.requestSession).not.toHaveBeenCalled();
  });

  it("reject an observation the runner did not shape", async () => {
    const remote = service();
    remote.requestSession.mockResolvedValueOnce({
      value: JSON.stringify({ ownership: "maybe" }),
    });
    await expect(
      adapter(remote).call("workspace.observe", { session })
    ).rejects.toMatchObject({ code: "failed" });
  });
});
