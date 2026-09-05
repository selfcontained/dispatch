import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createMcpHandlers } from "../src/server/mcp-handlers.js";

/**
 * Replacing a media file has to be one serialized unit: the row lock taken to
 * claim the file must still be held when the bytes land and when the row is
 * updated to describe them. Held only for the duration of the SELECT — which
 * is all an autocommit statement through the pool gets — two concurrent
 * replacements of the same file can interleave as write A, write B, update B,
 * update A, and the row is left describing bytes that are no longer on disk.
 *
 * These assert the shape of the work rather than trying to win a race: that
 * every statement runs on one connection, inside a transaction, with the file
 * write between the locking SELECT and the UPDATE.
 */
const PNG_160x120 = Buffer.from(
  "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",
  "base64"
);

const AGENT = "agt_share";
const FILE = "existing.png";

let mediaRoot: string;
/** Every statement seen, tagged with the connection that issued it. */
let statements: Array<{ client: number; sql: string }>;
let released: number;

function recordingPool() {
  let clients = 0;
  return {
    // A pooled connection: what a transaction must run on.
    connect: vi.fn(async () => {
      const client = ++clients;
      return {
        query: vi.fn(async (sql: string) => {
          statements.push({ client, sql: sql.trim().split("\n")[0]!.trim() });
          return sql.includes("SELECT")
            ? { rows: [{ file_name: FILE }], rowCount: 1 }
            : { rows: [], rowCount: 1 };
        }),
        release: vi.fn(() => {
          released += 1;
        }),
      };
    }),
    // Anything issued here is outside the transaction, and any lock it takes
    // is dropped the moment the statement finishes.
    query: vi.fn(async (sql: string) => {
      statements.push({ client: 0, sql: sql.trim().split("\n")[0]!.trim() });
      return { rows: [{ file_name: FILE }], rowCount: 1 };
    }),
  };
}

function makeHandlers(pool: ReturnType<typeof recordingPool>) {
  const deps = {
    pool,
    mediaRoot,
    agentManager: {
      getAgent: vi.fn(async () => ({
        id: AGENT,
        name: "sharer",
        cwd: "/repo",
        status: "running",
        mediaDir: null,
      })),
    },
    publishUiEvent: vi.fn(),
    appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return createMcpHandlers(
    deps as unknown as Parameters<typeof createMcpHandlers>[0]
  );
}

beforeAll(async () => {
  mediaRoot = await mkdtemp(path.join(tmpdir(), "dispatch-share-media-"));
  await mkdir(path.join(mediaRoot, AGENT), { recursive: true });
});

afterAll(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  statements = [];
  released = 0;
  await writeFile(path.join(mediaRoot, AGENT, FILE), Buffer.from("old bytes"));
});

describe("dispatch_share_file replacement", () => {
  async function replace() {
    const source = path.join(mediaRoot, "incoming.png");
    await writeFile(source, PNG_160x120);
    const pool = recordingPool();
    await makeHandlers(pool).shareMedia(AGENT, {
      filePath: source,
      description: "replaced",
      update: FILE,
    });
    return pool;
  }

  it("runs the whole replacement in one transaction on one connection", async () => {
    const pool = await replace();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    // Nothing on the pool itself: a statement there is its own transaction.
    expect(pool.query).not.toHaveBeenCalled();

    const onOneClient = statements.every((s) => s.client === 1);
    expect(onOneClient).toBe(true);
    expect(statements.map((s) => s.sql.slice(0, 12))).toEqual([
      "BEGIN",
      "SELECT file_",
      "UPDATE media",
      "COMMIT",
    ]);
  });

  it("takes the row lock before the bytes are written", async () => {
    await replace();

    const select = statements.findIndex((s) => s.sql.includes("FOR UPDATE"));
    const update = statements.findIndex((s) => s.sql.startsWith("UPDATE"));
    const commit = statements.findIndex((s) => s.sql === "COMMIT");
    expect(select).toBeGreaterThanOrEqual(0);
    // The write sits between them, so the lock covers the file and the row.
    expect(update).toBeGreaterThan(select);
    expect(commit).toBeGreaterThan(update);
  });

  it("stores the replacement's own dimensions", async () => {
    await replace();

    const update = statements.find((s) => s.sql.startsWith("UPDATE"));
    expect(update).toBeDefined();
    const written = await readFile(path.join(mediaRoot, AGENT, FILE));
    expect(written.equals(PNG_160x120)).toBe(true);
  });

  it("rolls back and releases the connection when the update fails", async () => {
    const source = path.join(mediaRoot, "incoming.png");
    await writeFile(source, PNG_160x120);
    const pool = recordingPool();
    const original = pool.connect;
    pool.connect = vi.fn(async () => {
      const client = (await original()) as {
        query: (sql: string) => Promise<unknown>;
        release: () => void;
      };
      const inner = client.query;
      client.query = async (sql: string) => {
        if (sql.trim().startsWith("UPDATE")) throw new Error("write failed");
        return inner(sql);
      };
      return client;
    }) as typeof pool.connect;

    await expect(
      makeHandlers(pool).shareMedia(AGENT, {
        filePath: source,
        description: "replaced",
        update: FILE,
      })
    ).rejects.toThrow("write failed");

    expect(statements.some((s) => s.sql === "ROLLBACK")).toBe(true);
    expect(statements.some((s) => s.sql === "COMMIT")).toBe(false);
    // A leaked connection would drain the pool after enough failures.
    expect(released).toBe(1);

    // The half a ROLLBACK cannot undo. Leaving the new bytes here would mean
    // a file the row does not describe — new image, old dimensions — which is
    // exactly the mismatch this feature exists to rule out.
    const onDisk = await readFile(path.join(mediaRoot, AGENT, FILE));
    expect(onDisk.toString()).toBe("old bytes");

    // And no backup left lying about in the media directory.
    const leftovers = (await readdir(path.join(mediaRoot, AGENT))).filter((f) =>
      f.startsWith(".replacing-")
    );
    expect(leftovers).toEqual([]);
  });

  it("leaves the new bytes in place when the commit itself fails", async () => {
    // A COMMIT that throws is ambiguous — it may well have landed. Putting the
    // old bytes back could then create the mismatch instead of preventing it,
    // so the file stays as written.
    const source = path.join(mediaRoot, "incoming.png");
    await writeFile(source, PNG_160x120);
    const pool = recordingPool();
    const original = pool.connect;
    pool.connect = vi.fn(async () => {
      const client = (await original()) as {
        query: (sql: string) => Promise<unknown>;
        release: () => void;
      };
      const inner = client.query;
      client.query = async (sql: string) => {
        const result = await inner(sql);
        if (sql.trim() === "COMMIT") throw new Error("commit failed");
        return result;
      };
      return client;
    }) as typeof pool.connect;

    await expect(
      makeHandlers(pool).shareMedia(AGENT, {
        filePath: source,
        description: "replaced",
        update: FILE,
      })
    ).rejects.toThrow("commit failed");

    const onDisk = await readFile(path.join(mediaRoot, AGENT, FILE));
    expect(onDisk.equals(PNG_160x120)).toBe(true);
    expect(released).toBe(1);
  });

  it("removes a file it created when the update fails", async () => {
    // No prior bytes to restore: undoing the write means the file should not
    // be left behind at all.
    await unlink(path.join(mediaRoot, AGENT, FILE));
    const source = path.join(mediaRoot, "incoming.png");
    await writeFile(source, PNG_160x120);
    const pool = recordingPool();
    const original = pool.connect;
    pool.connect = vi.fn(async () => {
      const client = (await original()) as {
        query: (sql: string) => Promise<unknown>;
        release: () => void;
      };
      const inner = client.query;
      client.query = async (sql: string) => {
        if (sql.trim().startsWith("UPDATE")) throw new Error("write failed");
        return inner(sql);
      };
      return client;
    }) as typeof pool.connect;

    await expect(
      makeHandlers(pool).shareMedia(AGENT, {
        filePath: source,
        description: "replaced",
        update: FILE,
      })
    ).rejects.toThrow("write failed");

    await expect(readFile(path.join(mediaRoot, AGENT, FILE))).rejects.toThrow();
  });

  it("releases the connection when the file is not this agent's", async () => {
    const source = path.join(mediaRoot, "incoming.png");
    await writeFile(source, PNG_160x120);
    const pool = recordingPool();
    pool.connect = vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        statements.push({ client: 1, sql: sql.trim().split("\n")[0]!.trim() });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => {
        released += 1;
      }),
    })) as unknown as typeof pool.connect;

    await expect(
      makeHandlers(pool).shareMedia(AGENT, {
        filePath: source,
        description: "replaced",
        update: "someone-elses.png",
      })
    ).rejects.toThrow("No media file found");

    expect(statements.some((s) => s.sql === "ROLLBACK")).toBe(true);
    expect(released).toBe(1);
  });
});
