/*
 * Session files on the local runner. A put goes to the child when it is
 * ready and holds the session: the socket passes the file's path in place,
 * so the child reads nothing and the agent opens the file where it is (T13b's
 * rules: the path comes back unchanged, a missing prompt file fails, a
 * listed reference keeps its path). With no child, one that is not ready or
 * holds no binding, or one that dies mid-call, the same port runs in
 * process with the same answers. A get streams through the child when bound, with the same native fallback.
 */
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runnerIdFromWire,
  RunnerCallError,
  sessionFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { serveSocket } from "../../../packages/runner/src/local/socket-server.js";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { workspaceHandlers } from "../../../packages/runner/src/core/workspace.js";
import { checkoutHandlers } from "../../../packages/runner/src/core/checkout.js";
import {
  checkoutWorkload,
  sessionFilesWorkload,
  workspaceWorkload,
} from "./helpers/checkout-workload.js";
import { createLocalCheckoutRunner } from "../src/runners/local.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { getSessionFile, putSessionFile } from "../src/files/session-file.js";

const description = {
  runnerId: runnerIdFromWire("local"),
  displayName: "Local",
  build: { version: "test" },
  protocol: 1,
  engines: [],
  capabilities: {},
} as const;

let root: string;
let socket: { close(): void };
let session: LocalRunnerSession;
let ops: string[] = [];
const agentId = "agt_files";
const handle = sessionFromWire(agentId);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "local-files-")));
  const state = path.join(root, "state");
  const store = new BindingStore(state);
  await store.import([
    { session: agentId, path: root, currentPath: null, worktree: null },
  ]);
  const socketDir = mkdtempSync(path.join("/tmp", "files-child-"));
  const socketPath = path.join(socketDir, "s");
  const nonce = randomUUID();
  socket = await serveSocket(socketPath, nonce, {
    calls: {
      ...checkoutHandlers(store, {
        workload: checkoutWorkload,
        workspace: workspaceWorkload,
      }),
      ...workspaceHandlers(state, store, workspaceWorkload),
    },
  });
  session = new LocalRunnerSession({ description });
  session.setEndpoint({ socket: socketPath, nonce });
  // Which operations reach the child.
  const call = session.call.bind(session);
  session.call = ((op: never, ...rest: never[]) => {
    ops.push(op);
    return call(op, ...rest);
  }) as typeof session.call;
  await session.call("runner.describe" as never, {} as never).catch(() => {});
});

afterAll(() => {
  session?.close();
  socket?.close();
  rmSync(root, { recursive: true, force: true });
});

const row = {
  id: agentId,
  cwd: "",
  worktreePath: null,
  workspacePath: null,
  placement: controllerPlacement,
};

function runner(child?: Runner) {
  return createLocalCheckoutRunner({ ...row, cwd: root }, description, child);
}

/** T13b's put rules through `runner`, and which ops reached the child. */
async function putRules(child?: Runner) {
  ops = [];
  const deliver = vi.spyOn(sessionFilesWorkload, "put");
  deliver.mockClear();
  const unreadable = path.join(root, `prompt-${randomUUID()}.txt`);
  writeFileSync(unreadable, "secret");
  chmodSync(unreadable, 0o000);
  const missing = path.join(root, `gone-${randomUUID()}.txt`);
  const through = runner(child);
  const results = {
    // Nothing reads it: an unreadable file is handed over as it is.
    prompt: await putSessionFile(
      through,
      handle,
      unreadable,
      "prompt.txt",
      "prompt"
    ),
    missingPrompt: await putSessionFile(
      through,
      handle,
      missing,
      "gone.txt",
      "prompt"
    ).then(
      () => "kept",
      () => "failed"
    ),
    missingReference: await putSessionFile(
      through,
      handle,
      missing,
      "gone.txt",
      "reference"
    ),
  };
  chmodSync(unreadable, 0o600);
  expect(results).toEqual({
    prompt: unreadable,
    missingPrompt: "failed",
    missingReference: missing,
  });
  expect(deliver.mock.calls).toEqual([
    [unreadable, "prompt"],
    [missing, "prompt"],
    [missing, "reference"],
  ]);
  deliver.mockRestore();
  return ops.filter((op) => op === "files.put").length;
}

function dying(code: "unavailable" | "unknown_outcome") {
  return {
    connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    sendBlob: vi.fn(async () => {}),
    call: vi.fn(async (op: string) => {
      if (op === "workspace.describe")
        return { path: root, moved: false, checkoutRoot: root };
      throw new RunnerCallError({ code, message: "The child went away" });
    }),
  } as unknown as Runner;
}

describe("files.put on the local runner", () => {
  it("goes through the child when it is ready and holds the session", async () => {
    expect(await putRules(session)).toBe(3);
  });

  it.each([
    ["no child", undefined],
    [
      "a child that is not ready",
      {
        connection: { state: "connecting", epoch: 0, onChange: () => () => {} },
        call: vi.fn(),
      } as unknown as Runner,
    ],
    ["a child that never received it", dying("unavailable")],
  ])("runs the same port in process with %s", async (_name, child) => {
    expect(await putRules(child)).toBe(0);
  });

  it("answers a put whose reply was lost with a clean error, never a second put", async () => {
    const deliver = vi.spyOn(sessionFilesWorkload, "put");
    deliver.mockClear();
    const file = path.join(root, `lost-${randomUUID()}.txt`);
    writeFileSync(file, "x");
    await expect(
      putSessionFile(
        runner(dying("unknown_outcome")),
        handle,
        file,
        "lost.txt",
        "prompt"
      )
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(deliver).not.toHaveBeenCalled();
    deliver.mockRestore();
  });

  it("runs in process for a session the child holds no binding for", async () => {
    const other = createLocalCheckoutRunner(
      { ...row, id: "agt_unbound", cwd: root },
      description,
      session
    );
    const file = path.join(root, "unbound.txt");
    writeFileSync(file, "x");
    ops = [];
    expect(
      await putSessionFile(
        other,
        sessionFromWire("agt_unbound"),
        file,
        "unbound.txt",
        "prompt"
      )
    ).toBe(file);
    expect(ops).not.toContain("files.put");
  });
});

describe("files.get on the local runner", () => {
  it("streams through the bound child, with no in-process read", async () => {
    const file = path.join(root, "share.bin");
    const bytes = Buffer.from([0, 1, 2, 255]);
    writeFileSync(file, bytes);
    const read = vi.spyOn(sessionFilesWorkload, "get");
    const transfer = vi.spyOn(session, "getFile");
    try {
      expect(await getSessionFile(runner(session), handle, file)).toEqual(
        bytes
      );
      expect(transfer).toHaveBeenCalledWith(
        { session: handle, path: file },
        undefined
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      transfer.mockRestore();
    }
  });

  it("preserves symlink traversal, relative paths, and native error metadata", async () => {
    const nested = path.join(root, "nested");
    mkdirSync(path.join(nested, "subdir"), { recursive: true });
    symlinkSync(path.join(nested, "subdir"), path.join(root, "link"));
    writeFileSync(path.join(root, "pick.txt"), "wrong");
    writeFileSync(path.join(nested, "pick.txt"), "right");
    for (const prefix of [root, path.relative(process.cwd(), root)]) {
      const source = `${prefix}/link/../pick.txt`;
      expect(
        (await getSessionFile(runner(session), handle, source)).toString()
      ).toBe("right");
    }
    const missing = `${path.relative(process.cwd(), root)}/absent`;
    const expected = await sessionFilesWorkload
      .get(missing)
      .catch((error) => error);
    await expect(
      getSessionFile(runner(session), handle, missing)
    ).rejects.toMatchObject({
      code: expected.code,
      errno: expected.errno,
      syscall: expected.syscall,
      path: expected.path,
      message: expected.message,
    });
    const empty = await sessionFilesWorkload.get("").catch((error) => error);
    await expect(
      getSessionFile(runner(session), handle, "")
    ).rejects.toMatchObject({ code: empty.code, message: empty.message });
  });

  it("forwards cancellation through the session wrapper and closes the source", async () => {
    const source = new PassThrough();
    const closed = vi.fn(async () => {
      source.destroy();
    });
    const open = vi
      .spyOn(workspaceWorkload, "readFileStream")
      .mockResolvedValue({ source, close: closed });
    const fallback = vi.spyOn(sessionFilesWorkload, "get");
    const abort = new AbortController();
    try {
      const pending = runner(session).call(
        "files.get",
        { session: handle, path: path.join(root, "blocked") },
        { signal: abort.signal }
      );
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(open).toHaveBeenCalled());
      abort.abort();
      await rejected;
      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      fallback.mockRestore();
      source.destroy();
    }
  });

  it("keeps uncapped reads and native missing-file errors", async () => {
    const file = path.join(root, "large.bin");
    const bytes = Buffer.alloc(21 * 1024 * 1024, 127);
    writeFileSync(file, bytes);
    const actual = await getSessionFile(runner(session), handle, file);
    expect(actual.equals(bytes)).toBe(true);
    await expect(
      getSessionFile(runner(session), handle, file + ".missing")
    ).rejects.toMatchObject({ code: "ENOENT", path: file + ".missing" });
  });

  it.each([
    ["no child", undefined],
    ["an unavailable child", dying("unavailable")],
    [
      "an old inline-only child",
      {
        ...dying("unavailable"),
        getFile: vi.fn(async () => {
          throw new RunnerCallError({ code: "invalid", message: "No stream" });
        }),
      } as unknown as Runner,
    ],
  ])("preserves native recovery reads with %s", async (_name, peer) => {
    const file = path.join(root, "recovery.bin");
    writeFileSync(file, "recover");
    expect(await getSessionFile(runner(peer), handle, file)).toEqual(
      Buffer.from("recover")
    );
  });
});
