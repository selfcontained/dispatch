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

function service(options: { epochs?: number[] } = {}) {
  const epochs = options.epochs ?? [7];
  let index = 0;
  return {
    connectionEpoch: () => epochs[Math.min(index, epochs.length - 1)],
    call: vi.fn(
      async (
        _id: string,
        op: string,
        _req: unknown,
        _options: unknown,
        epoch: number
      ) => {
        if (epoch !== epochs[Math.min(index++, epochs.length - 1)])
          throw new RunnerCallError({
            code: "unavailable",
            message: "Connection changed",
          });
        return op === "workspace.release" ? { removed: true } : observed;
      }
    ),
  };
}

function adapter(remote: ReturnType<typeof service>) {
  return createEnrolledCheckoutRunner(
    remote as unknown as RemoteRunnerService,
    placement.runner,
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

    expect(viaAdapter.call.mock.calls).toEqual([
      [placement.runner, "workspace.observe", { session }, undefined, 7],
      [
        placement.runner,
        "workspace.release",
        { session, ...release },
        undefined,
        7,
      ],
    ]);
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
      expect(viaAdapter.call).toHaveBeenCalledExactlyOnceWith(
        placement.runner,
        "workspace.observe",
        {
          session,
          ...(policy === "ownership" && { policy }),
        },
        undefined,
        7
      );
    }
  );

  it("releases only on the connection that was observed", async () => {
    // The runner reconnects (epoch 8) between observe and release.
    const remote = service({ epochs: [7, 8] });
    const runner = adapter(remote);
    await runner.call("workspace.observe", { session });
    await expect(
      runner.call("workspace.release", { session, ...release })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(remote.call.mock.calls.map((call) => call[4])).toEqual([7, 7]);
  });

  it("refuse another session's checkout", async () => {
    const remote = service();
    await expect(
      adapter(remote).call("workspace.observe", {
        session: sessionFromWire("agt_other"),
      })
    ).rejects.toBeInstanceOf(RunnerCallError);
    expect(remote.call).not.toHaveBeenCalled();
  });

  it("reject an observation the runner did not shape", async () => {
    const remote = service();
    remote.call.mockResolvedValueOnce({
      ownership: "maybe",
    });
    await expect(
      adapter(remote).call("workspace.observe", { session })
    ).rejects.toMatchObject({ code: "failed" });
  });
});
