import { enrolledSessions } from "../src/workload/agents/remote/session-operations.js";
import { createCheckoutWorkload } from "../src/workload/agents/checkout-worker.js";
import { describe, expect, it, vi } from "vitest";
import {
  pathFromWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import { enrolledCheckouts } from "../src/workload/agents/remote/checkout-operations.js";
import { enrolledChannels } from "../src/workload/agents/remote/channel-operations.js";

function fixture() {
  const supervisor = {
    checkoutDirectory: vi.fn(),
    withCommandCheckout: vi.fn(),
  };
  const worker = {
    repositoryClone: vi.fn(async () => "/cache/repository"),
    run: vi.fn(async () =>
      JSON.stringify({
        data: {
          repositoryRoot: "/cache/repository",
          checkoutRoot: "/cache/repository",
        },
      })
    ),
    read: vi.fn(),
    manifest: vi.fn(),
  };
  const handlers = enrolledCheckouts(
    supervisor as never,
    worker as never,
    new AbortController().signal
  );
  return { worker, supervisor, handlers };
}
const fileReads = [
  "checkout.access",
  "checkout.read",
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "checkout.image",
] as const;
describe("the enrolled handler's target contract without a VM", () => {
  it.each(fileReads)(
    "%s rejects repository targets before invoking a worker",
    async (op) => {
      const { worker, supervisor, handlers } = fixture();
      await expect(
        handlers.checkoutRead(
          op,
          {
            target: { repository: "https://example.com/offline.git" },
          } as never,
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: "invalid" });
      expect(worker.run).not.toHaveBeenCalled();
      expect(worker.read).not.toHaveBeenCalled();
      expect(supervisor.withCommandCheckout).not.toHaveBeenCalled();
    }
  );
  it.each([
    { path: pathFromWire("/checkout") },
    { repository: "https://example.com/offline.git" },
  ])("watches reject non-session targets: %j", async (target) => {
    const { supervisor } = fixture();
    const subscribe = vi.fn();
    const handlers = enrolledChannels(
      supervisor as never,
      { subscribe } as never,
      { onTerminal: vi.fn() } as never,
      vi.fn() as never
    );
    await expect(
      handlers.opens["checkout.watch"]({ target } as never, {} as never)
    ).rejects.toMatchObject({ code: "invalid" });
    expect(subscribe).not.toHaveBeenCalled();
  });
  // Known opposite-direction gap: Local's existing server adapter needs these
  // path reads. Keep their positive shared scenarios; do not remove Local's
  // existing behavior to make this older enrolled handler look conformant.
  it.each([...fileReads, "checkout.defaultFiles"] as const)(
    "documents the enrolled-only %s path refusal",
    async (op) => {
      const { worker, handlers } = fixture();
      await expect(
        handlers.checkoutRead(
          op,
          { target: { path: pathFromWire("/checkout") } } as never,
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: "invalid" });
      expect(worker.read).not.toHaveBeenCalled();
      expect(worker.run).not.toHaveBeenCalled();
    }
  );
  it("documents the enrolled-only context path refusal", async () => {
    const sessions = enrolledSessions({} as never, () => {});
    await expect(
      sessions.calls["git.context"]({
        target: { path: pathFromWire("/checkout") },
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("context rejects repository targets before probing a session", async () => {
    const sessions = enrolledSessions({} as never, () => {});
    await expect(
      sessions.calls["git.context"]({
        target: { repository: "https://example.com/offline.git" },
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("base rejects repository targets in the shared Git worker", async () => {
    const { worker, handlers } = fixture();
    const workload = createCheckoutWorkload();
    worker.run.mockImplementationOnce(async () => {
      try {
        const data = await workload.run(
          "git.base",
          {
            directory: "/unused",
            repository: "https://example.com/offline.git",
            request: { requested: null, fallback: [] },
          } as never,
          {}
        );
        return JSON.stringify({ data });
      } catch (error) {
        if (!(error instanceof RunnerCallError)) throw error;
        return JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
      }
    });
    await expect(
      handlers.calls["git.base"]({
        target: { repository: "https://example.com/offline.git" },
        requested: null,
        fallback: [],
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("roots resolve repository targets through the shared cache before running the real query shape", async () => {
    const { worker, handlers } = fixture();
    const request = {
      target: { repository: "https://example.com/offline.git" },
    };
    expect(await handlers.calls["git.roots"](request)).toEqual({
      repositoryRoot: "/cache/repository",
      checkoutRoot: "/cache/repository",
    });
    expect(worker.repositoryClone).toHaveBeenCalledExactlyOnceWith(
      request.target.repository
    );
    expect(worker.run).toHaveBeenCalledWith(
      "git.roots",
      "/cache/repository",
      request,
      expect.any(AbortSignal)
    );
  });
});
