import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { serveSocket } from "../src/local/socket-server.js";
import { BindingStore } from "../src/local/bindings.js";
import { workspaceHandlers } from "../src/core/workspace.js";
import { workspaceWorkload } from "../src/workload/agents/checkout-worker.js";
import type { WorkspacePort } from "../src/platform/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const session = sessionFromWire("download");
async function fixture(open = workspaceWorkload.readFileStream!) {
  const root = mkdtempSync("/tmp/rs-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BindingStore(root);
  await store.import([
    { session: String(session), path: root, currentPath: null, worktree: null },
  ]);
  let active = 0;
  const readFileStream: WorkspacePort["readFileStream"] = async (source) => {
    const opened = await open(source);
    active++;
    return {
      ...opened,
      close: async () => {
        try {
          await opened.close();
        } finally {
          active--;
        }
      },
    };
  };
  const socket = join(root, "s.sock"),
    nonce = randomUUID();
  const server = await serveSocket(socket, nonce, {
    calls: workspaceHandlers(root, store, {
      ...workspaceWorkload,
      readFileStream,
    }),
  });
  cleanups.push(() => server.close());
  const client = await LocalSocketConnection.connect({ socket, nonce });
  cleanups.push(() => client.close());
  return { root, client, active: () => active };
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

it("streams Local file bytes with metadata while ordinary calls retain their inline shape", async () => {
  const f = await fixture();
  const bytes = Buffer.from([0, 1, 2, 255]),
    path = join(f.root, "bytes");
  writeFileSync(path, bytes);
  const parts: Buffer[] = [];
  const info = await f.client.getFile(
    { session, path },
    new Writable({
      write(chunk, _, done) {
        parts.push(Buffer.from(chunk));
        done();
      },
    })
  );
  expect(Buffer.concat(parts)).toEqual(bytes);
  expect(info).toMatchObject({ name: "bytes", size: 4, digest: digest(bytes) });
  expect(info.blob).toMatch(/^download:/);
  expect(await f.client.call("files.get", { session, path })).toEqual({
    name: "bytes",
    size: 4,
    digest: digest(bytes),
    blob: bytes.toString("base64"),
  });
  await vi.waitFor(() => expect(f.active()).toBe(0));
});

it("collects an uncapped Local download above 20 MiB and preserves the bounded default collector", async () => {
  const f = await fixture();
  const size = 21 * 1024 * 1024 + 17;
  const bytes = Buffer.alloc(size, 97),
    path = join(f.root, "large");
  writeFileSync(path, bytes);
  const downloaded = await f.client.collectFile(
    { session, path },
    { maxBytes: null }
  );
  expect(downloaded.length).toBe(size);
  expect(digest(downloaded)).toBe(digest(bytes));
  await expect(f.client.collectFile({ session, path })).rejects.toMatchObject({
    code: "too_large",
  });
  await vi.waitFor(() => expect(f.active()).toBe(0));
  await expect(
    f.client.call("files.get", { session, path })
  ).rejects.toMatchObject({ message: "Session files are limited to 20 MiB." });
});

it("returns native error metadata without leaving a waiting download or breaking the connection", async () => {
  const f = await fixture(),
    path = join(f.root, "missing");
  await expect(
    f.client.collectFile({ session, path }, { maxBytes: null })
  ).rejects.toMatchObject({ code: "not_found", details: { errno: "ENOENT" } });
  writeFileSync(path, "recovered");
  expect(
    (
      await f.client.collectFile({ session, path }, { maxBytes: null })
    ).toString()
  ).toBe("recovered");
  await vi.waitFor(() => expect(f.active()).toBe(0));
});

it.each(["cancel", "disconnect"] as const)(
  "closes the workload stream on %s while its receiver is blocked",
  async (action) => {
    const close = vi.fn(async () => {});
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const f = await fixture(async () => ({ source, close }));
    const first = Promise.withResolvers<void>();
    const controller = new AbortController();
    const sink = new Writable({
      write() {
        first.resolve();
      },
    });
    const result = f.client.getFile(
      { session, path: "unused" },
      sink,
      controller.signal
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: action === "cancel" ? "cancelled" : "unavailable",
    });
    await first.promise;
    if (action === "cancel") controller.abort();
    else f.client.close();
    await rejected;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(source.destroyed).toBe(true);
    expect(f.active()).toBe(0);
  }
);

it("fails promptly against an inline-only peer instead of waiting forever for a stream", async () => {
  const root = mkdtempSync("/tmp/rs-old-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = join(root, "s.sock"),
    nonce = randomUUID();
  const inline = {
    name: "legacy",
    size: 6,
    digest: "",
    blob: Buffer.from("legacy").toString("base64"),
  };
  const server = await serveSocket(socket, nonce, {
    calls: { "files.get": () => inline },
  });
  cleanups.push(() => server.close());
  const client = await LocalSocketConnection.connect({ socket, nonce });
  cleanups.push(() => client.close());
  await expect(
    client.collectFile({ session, path: "legacy" }, { maxBytes: null })
  ).rejects.toMatchObject({ code: "invalid" });
  expect(await client.call("files.get", { session, path: "legacy" })).toEqual(
    inline
  );
}, 2_000);

it("preserves Local readFile behavior for a named pipe", async () => {
  const f = await fixture(),
    path = join(f.root, "pipe");
  execFileSync("mkfifo", [path]);
  const downloaded = f.client.collectFile(
    { session, path },
    { maxBytes: null }
  );
  await writeFile(path, "pipe bytes");
  expect((await downloaded).toString()).toBe("pipe bytes");
  await vi.waitFor(() => expect(f.active()).toBe(0));
});

it("closes a workload source that fails while streaming and leaves the connection usable", async () => {
  const close = vi.fn(async () => {});
  const source = Readable.from(
    (async function* () {
      yield Buffer.from("partial");
      throw Object.assign(new Error("injected read failure"), { code: "EIO" });
    })()
  );
  const f = await fixture(async () => ({ source, close }));
  await expect(
    f.client.collectFile({ session, path: "unused" }, { maxBytes: null })
  ).rejects.toBeInstanceOf(Error);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(source.destroyed).toBe(true);
  expect(
    (await f.client.call("workspace.observe", { session, policy: "ownership" }))
      .ownership
  ).toBe("external");
});
