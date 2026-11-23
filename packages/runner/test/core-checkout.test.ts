/*
 * The core's checkout reads: a session's target resolves only through the
 * runner's own binding, the workload gets a directory and the request
 * without its target, and the replies cross the socket whole, however long.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { BindingStore } from "../src/local/bindings.js";
import { WriteFence } from "../src/local/fence.js";
import { serveSocket } from "../src/local/socket-server.js";
import { checkoutHandlers } from "../src/core/checkout.js";
import type { Platform } from "../src/platform/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0).reverse()) run();
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "core-checkout-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function harness(reply: (op: string, input: unknown) => unknown) {
  const root = temp();
  const store = new BindingStore(root);
  await store.import([
    { session: "plain", path: "/plain", currentPath: null, worktree: null },
    {
      session: "moved",
      path: "/launch",
      currentPath: "/moved",
      worktree: null,
    },
  ]);
  const calls: Array<{ op: string; input: unknown }> = [];
  const platform: Platform = {
    workload: {
      async run(op, input) {
        calls.push({ op, input });
        return reply(op, input) as never;
      },
    },
  };
  const fence = new WriteFence(false);
  const socket = join(root, "r.sock");
  const nonce = randomBytes(8).toString("hex");
  const server = await serveSocket(
    socket,
    nonce,
    { calls: checkoutHandlers(store, platform) },
    fence
  );
  const connection = await LocalSocketConnection.connect({ socket, nonce });
  cleanups.push(() => {
    connection.close();
    server.close();
  });
  return { connection, calls, fence };
}

const listing = { truncated: false, entries: [] };
const target = (session: string, checkout?: "current" | "launch" | "moved") =>
  ({
    session: sessionFromWire(session),
    ...(checkout && { checkout }),
  }) as const;

describe("core checkout reads", () => {
  it("resolves a session's target from its binding, by selector", async () => {
    const { connection, calls } = await harness(() => listing);
    for (const [session, checkout] of [
      ["plain", undefined],
      ["moved", "current"],
      ["moved", "launch"],
      ["moved", "moved"],
    ] as const)
      await connection.call("checkout.list", {
        target: target(session, checkout),
        path: "src",
      });
    expect(calls).toEqual([
      {
        op: "checkout.list",
        input: { directory: "/plain", request: { path: "src" } },
      },
      {
        op: "checkout.list",
        input: { directory: "/moved", request: { path: "src" } },
      },
      {
        op: "checkout.list",
        input: { directory: "/launch", request: { path: "src" } },
      },
      {
        op: "checkout.list",
        input: { directory: "/moved", request: { path: "src" } },
      },
    ]);
  });

  it("answers not_found for a session it holds no binding for, or no moved checkout", async () => {
    const { connection, calls } = await harness(() => listing);
    for (const t of [target("unknown"), target("plain", "moved")])
      await expect(
        connection.call("checkout.list", { target: t, path: "" })
      ).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toEqual([]);
  });

  it("reads a path target as given and refuses a repository target", async () => {
    const { connection, calls } = await harness(() => listing);
    await connection.call("checkout.list", {
      target: { path: pathFromWire("/elsewhere") },
      path: "",
    });
    expect(calls[0]?.input).toMatchObject({ directory: "/elsewhere" });
    await expect(
      connection.call("checkout.list", {
        target: { repository: "https://example.com/r.git" },
        path: "",
      })
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("describes a binding from the stored record", async () => {
    const { connection } = await harness(() => listing);
    await expect(
      connection.call("workspace.describe", {
        session: sessionFromWire("moved"),
      })
    ).resolves.toEqual({
      path: "/moved",
      moved: true,
      origin: null,
      checkoutRoot: "/launch",
      worktree: null,
    });
    await expect(
      connection.call("workspace.describe", {
        session: sessionFromWire("none"),
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("passes a workload's runner error through and wraps any other", async () => {
    const { connection } = await harness((op, input) => {
      if ((input as { request: { path: string } }).request.path === "a")
        throw new RunnerCallError({
          code: "forbidden",
          message: "no",
          details: { status: 403 },
        });
      throw new Error("plain failure");
    });
    await expect(
      connection.call("checkout.list", { target: target("plain"), path: "a" })
    ).rejects.toMatchObject({ code: "forbidden", details: { status: 403 } });
    await expect(
      connection.call("checkout.list", { target: target("plain"), path: "b" })
    ).rejects.toMatchObject({ code: "failed", message: "plain failure" });
  });

  it("serves reads while frozen", async () => {
    const { connection, fence } = await harness(() => listing);
    await fence.freeze();
    try {
      await expect(
        connection.call("checkout.list", { target: target("plain"), path: "" })
      ).resolves.toEqual(listing);
      await expect(
        connection.call("workspace.describe", {
          session: sessionFromWire("plain"),
        })
      ).resolves.toMatchObject({ path: "/plain" });
    } finally {
      fence.thaw();
    }
  });

  it("carries a 5 MiB reply on a reply stream", async () => {
    const data = "y".repeat(5 * 1024 * 1024);
    const { connection } = await harness(() => ({ data, digest: "d" }));
    const file = await connection.call("checkout.read", {
      target: target("plain"),
      path: "big",
      encoding: "utf8",
      maxBytes: null,
    });
    expect(file?.data.length).toBe(data.length);
  });
});
