import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryStore } from "../src/update-recovery/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// A regression in FIFO handling must not strand a libuv thread in this test
// process. Run the actual store in a killable child with a bounded deadline.
async function expectFifoRejected(root: string, operation: string) {
  const moduleUrl = new URL("../src/update-recovery/store.ts", import.meta.url);
  const script = `
    const { RecoveryStore } = await import(${JSON.stringify(moduleUrl.href)});
    const store = await RecoveryStore.open(${JSON.stringify(root)});
    try {
      ${operation}
      throw new Error("FIFO was accepted");
    } catch (error) {
      if (!/regular file/.test(error.message)) throw error;
    }
  `;
  await promisify(execFile)("bun", ["--eval", script], {
    timeout: 5000,
    killSignal: "SIGKILL",
  });
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-recovery-"))
  );
  roots.push(root);
  const runtime = path.join(root, "dispatch");
  const database = path.join(root, "database.dump");
  const state = path.join(root, "settings.json");
  await writeFile(runtime, "old executable", { mode: 0o755 });
  await writeFile(database, "database snapshot", { mode: 0o600 });
  await writeFile(state, "private settings", { mode: 0o600 });
  const store = await RecoveryStore.open(path.join(root, "recovery"));
  const transaction = await store.begin({
    instanceId: "installation-one",
    wasRunning: true,
    previous: { version: "v1.0.1", sha256: sha256("old executable") },
    target: { version: "v1.0.2", sha256: sha256("new executable") },
  });
  const input = {
    files: [
      { role: "runtime" as const, source: runtime },
      { role: "database" as const, source: database },
      { role: "state" as const, source: state },
    ],
    // The actual database adapter must do a disposable restore. This storage
    // fixture only verifies that the adapter receives the immutable dump copy.
    verifyDatabaseRestore: vi.fn(
      async ({ databaseFiles }: { databaseFiles: string[] }) => {
        expect(await readFile(databaseFiles[0], "utf8")).toBe(
          "database snapshot"
        );
      }
    ),
  };
  return { root, store, transaction, runtime, database, state, input };
}

describe("durable update recovery storage", () => {
  it("preserves abandoned lock evidence only after proving the external OS lease", async () => {
    const { store, transaction } = await fixture();
    const lock = path.join(store.root, "locks", transaction.id);
    await mkdir(lock, { mode: 0o700 });
    await expect(
      store.reconcileAbandonedMutationLock(transaction.id, async () => {
        throw new Error("no lease");
      })
    ).rejects.toThrow("no lease");
    expect((await lstat(lock)).isDirectory()).toBe(true);
    const proof = vi.fn(async () => {});
    await store.reconcileAbandonedMutationLock(transaction.id, proof);
    expect(proof).toHaveBeenCalledOnce();
    expect(
      (await readdir(path.dirname(lock))).some((name) =>
        name.startsWith(`${transaction.id}.abandoned-`)
      )
    ).toBe(true);
    await store.transition(transaction.id, "preparing", "aborted");
  });
  it("copies private snapshots, verifies the database copy before sealing, and reopens offline", async () => {
    const { store, transaction, runtime, state, input } = await fixture();
    const manifest = await store.checkpoint(transaction.id, input);
    expect(input.verifyDatabaseRestore).toHaveBeenCalledOnce();
    expect(manifest.files[0]).toMatchObject({
      mode: 0o755,
      sha256: transaction.previous.sha256,
    });
    expect((await store.read(transaction.id)).phase).toBe("backed-up");
    await writeFile(runtime, "changed live executable");
    await writeFile(state, "changed live settings");
    const reopened = await RecoveryStore.open(store.root);
    expect(await reopened.verify(transaction.id)).toEqual(manifest);
    const point = path.join(store.root, "points", transaction.id);
    expect(await readFile(path.join(point, "0"), "utf8")).toBe(
      "old executable"
    );
    expect(await readFile(path.join(point, "2"), "utf8")).toBe(
      "private settings"
    );
    for (const file of await readdir(point)) {
      expect((await lstat(path.join(point, file))).mode & 0o777).toBe(0o600);
    }
    for (const dir of [
      store.root,
      point,
      path.join(store.root, "transactions"),
      path.join(store.root, "locks"),
    ]) {
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("does not seal or discard a checkpoint when the restore test fails", async () => {
    const { store, transaction, input } = await fixture();
    input.verifyDatabaseRestore.mockRejectedValueOnce(
      new Error("restore failed")
    );
    await expect(store.checkpoint(transaction.id, input)).rejects.toThrow(
      "restore failed"
    );
    expect((await store.read(transaction.id)).phase).toBe("preparing");
    await expect(store.verify(transaction.id)).rejects.toThrow(
      "not been sealed"
    );
    const incomplete = path.join(
      store.root,
      "points",
      `${transaction.id}.incomplete`
    );
    expect(await readFile(path.join(incomplete, "0"), "utf8")).toBe(
      "old executable"
    );
    await expect(store.checkpoint(transaction.id, input)).rejects.toMatchObject(
      { code: "EEXIST" }
    );
    expect(input.verifyDatabaseRestore).toHaveBeenCalledOnce();
  });

  it("detects a verifier mutating its dump and keeps the checkpoint incomplete", async () => {
    const { store, transaction, input } = await fixture();
    input.verifyDatabaseRestore.mockImplementationOnce(
      async ({ databaseFiles }) => {
        await writeFile(databaseFiles[0], "modified snapshot");
      }
    );
    await expect(store.checkpoint(transaction.id, input)).rejects.toThrow(
      "integrity"
    );
    expect((await store.read(transaction.id)).manifestSha256).toBeUndefined();
  });

  it.each(["runtime", "database", "state"] as const)(
    "refuses activation when a sealed %s file is corrupted",
    async (role) => {
      const { store, transaction, input } = await fixture();
      const manifest = await store.checkpoint(transaction.id, input);
      const file = manifest.files.find((file) => file.role === role)!;
      await writeFile(
        path.join(store.root, "points", transaction.id, String(file.slot)),
        "corrupt"
      );
      await expect(
        store.transition(transaction.id, "backed-up", "activating")
      ).rejects.toThrow("integrity");
      expect((await store.read(transaction.id)).phase).toBe("backed-up");
    }
  );

  it("detects manifest edits before allowing restore", async () => {
    const { store, transaction, input } = await fixture();
    await store.checkpoint(transaction.id, input);
    await store.transition(transaction.id, "backed-up", "activating");
    await writeFile(
      path.join(store.root, "points", transaction.id, "manifest.json"),
      "{}"
    );
    await expect(
      store.transition(transaction.id, "activating", "restoring")
    ).rejects.toThrow("manifest integrity");
  });

  it("checks the pinned old runtime identity before testing the database", async () => {
    const { store, transaction, runtime, input } = await fixture();
    await writeFile(runtime, "unexpected executable");
    await expect(store.checkpoint(transaction.id, input)).rejects.toThrow(
      "Previous runtime checksum"
    );
    expect(input.verifyDatabaseRestore).not.toHaveBeenCalled();
  });

  it("cannot skip the checkpoint or rewind a committed update", async () => {
    const { store, transaction, input } = await fixture();
    await expect(
      store.transition(transaction.id, "preparing", "activating")
    ).rejects.toThrow("Invalid");
    await expect(
      store.transition(transaction.id, "preparing", "backed-up")
    ).rejects.toThrow("Invalid");
    await store.checkpoint(transaction.id, input);
    await store.transition(transaction.id, "backed-up", "activating");
    await store.transition(transaction.id, "activating", "probation");
    await store.transition(transaction.id, "probation", "committed");
    await expect(
      store.transition(transaction.id, "committed", "restoring")
    ).rejects.toThrow("Invalid");
    expect((await store.read(transaction.id)).phase).toBe("committed");
    expect(await store.verify(transaction.id)).toBeDefined();
  });

  it("retains a failed transaction and permits an explicit verified recovery attempt", async () => {
    const { store, transaction, input } = await fixture();
    await store.checkpoint(transaction.id, input);
    await store.transition(transaction.id, "backed-up", "activating");
    const failed = await store.transition(
      transaction.id,
      "activating",
      "recovery-required",
      "STARTUP_FAILED"
    );
    expect(failed.failureCode).toBe("STARTUP_FAILED");
    const reopened = await RecoveryStore.open(store.root);
    await reopened.transition(transaction.id, "recovery-required", "restoring");
    await reopened.transition(transaction.id, "restoring", "rolled-back");
    await expect(
      reopened.transition(transaction.id, "rolled-back", "activating")
    ).rejects.toThrow("Invalid");
    expect(await reopened.verify(transaction.id)).toBeDefined();
  });

  it("rejects stale phase changes without overwriting a newer writer", async () => {
    const { store, transaction, input } = await fixture();
    await store.checkpoint(transaction.id, input);
    await store.transition(transaction.id, "backed-up", "activating");
    await expect(
      store.transition(transaction.id, "backed-up", "aborted")
    ).rejects.toThrow("Invalid");
    expect((await store.read(transaction.id)).phase).toBe("activating");
  });

  it("excludes another writer during checkpointing and never steals an abandoned lock", async () => {
    const { store, transaction, input } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    input.verifyDatabaseRestore.mockImplementationOnce(async () => {
      entered();
      await gate;
    });
    const copying = store.checkpoint(transaction.id, input);
    await ready;
    const other = await RecoveryStore.open(store.root);
    await expect(
      other.transition(transaction.id, "preparing", "aborted")
    ).rejects.toMatchObject({ code: "EEXIST" });
    release();
    await copying;
    await mkdir(path.join(store.root, "locks", transaction.id), {
      mode: 0o700,
    });
    await expect(
      other.transition(transaction.id, "backed-up", "activating")
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect((await other.read(transaction.id)).phase).toBe("backed-up");
  });

  it("treats missing checkpoint journal linkage as incomplete after an interrupted seal", async () => {
    const { store, transaction, input } = await fixture();
    await store.checkpoint(transaction.id, input);
    // The files made it to disk, but the journal rename did not. Existence is
    // not evidence of a complete transaction; future reconciliation must inspect it.
    await writeFile(
      path.join(store.root, "transactions", transaction.id),
      JSON.stringify(transaction)
    );
    await expect(store.verify(transaction.id)).rejects.toThrow(
      "not been sealed"
    );
    await expect(
      store.transition(transaction.id, "preparing", "activating")
    ).rejects.toThrow("Invalid");
  });

  it("fails closed on invalid IDs, corrupt journals, and raw sensitive errors", async () => {
    const { store, transaction } = await fixture();
    await expect(store.read("../other")).rejects.toThrow();
    await expect(
      store.transition(
        transaction.id,
        "preparing",
        "recovery-required",
        "postgres://password@host"
      )
    ).rejects.toThrow();
    expect((await store.read(transaction.id)).phase).toBe("preparing");
    await writeFile(path.join(store.root, "transactions", transaction.id), "{");
    await expect(store.read(transaction.id)).rejects.toThrow();
  });

  it("rejects symlink and non-regular source files", async () => {
    const { store, transaction, runtime, root, input } = await fixture();
    const link = path.join(root, "link");
    await symlink(runtime, link);
    await expect(
      store.checkpoint(transaction.id, {
        ...input,
        files: [{ role: "runtime", source: link }, input.files[1]],
      })
    ).rejects.toThrow();
    // Use a different transaction because incomplete material is never reused.
    const second = await store.begin(transaction);
    await expect(
      store.checkpoint(second.id, {
        ...input,
        files: [{ role: "runtime", source: root }, input.files[1]],
      })
    ).rejects.toThrow("regular file");
  });

  it("rejects a FIFO source promptly and releases the transaction lock", async () => {
    const { root, store, transaction, runtime } = await fixture();
    const fifo = path.join(root, "database.fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    await expectFifoRejected(
      store.root,
      `
      await store.checkpoint(${JSON.stringify(transaction.id)}, {
        files: [
          { role: "runtime", source: ${JSON.stringify(runtime)} },
          { role: "database", source: ${JSON.stringify(fifo)} }
        ],
        verifyDatabaseRestore: async () => { throw new Error("verifier must not run"); }
      });
    `
    );
    expect(await readdir(path.join(store.root, "locks"))).toEqual([]);
    expect((await store.read(transaction.id)).phase).toBe("preparing");
  });

  it.each(["journal", "snapshot"] as const)(
    "rejects a stored %s FIFO promptly",
    async (kind) => {
      const { store, transaction, input } = await fixture();
      await store.checkpoint(transaction.id, input);
      const file =
        kind === "journal"
          ? path.join(store.root, "transactions", transaction.id)
          : path.join(store.root, "points", transaction.id, "0");
      await rm(file);
      execFileSync("mkfifo", ["-m", "600", file]);
      await expectFifoRejected(
        store.root,
        `await store.${kind === "journal" ? "read" : "verify"}(${JSON.stringify(transaction.id)});`
      );
    }
  );

  it("rejects duplicate sources and recovery files as checkpoint inputs", async () => {
    const { store, transaction, input } = await fixture();
    await expect(
      store.checkpoint(transaction.id, {
        ...input,
        files: [
          input.files[0],
          { role: "database", source: input.files[0].source },
        ],
      })
    ).rejects.toThrow("unique");
    const second = await store.begin(transaction);
    await expect(
      store.checkpoint(second.id, {
        ...input,
        files: [
          {
            role: "runtime",
            source: path.join(store.root, "transactions", transaction.id),
          },
          input.files[1],
        ],
      })
    ).rejects.toThrow("outside");
  });

  it("rejects insecure storage paths and a substituted snapshot symlink", async () => {
    const { root, store, transaction, input } = await fixture();
    const publicRoot = path.join(root, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    await expect(RecoveryStore.open(publicRoot)).rejects.toThrow("private");
    const link = path.join(root, "store-link");
    await symlink(store.root, link);
    await expect(RecoveryStore.open(link)).rejects.toThrow("symlink");
    await store.checkpoint(transaction.id, input);
    const file = path.join(store.root, "points", transaction.id, "0");
    await rm(file);
    await symlink(input.files[0].source, file);
    await expect(store.verify(transaction.id)).rejects.toThrow();
  });

  it("refuses group-readable manifests or transaction records", async () => {
    const { store, transaction, input } = await fixture();
    await store.checkpoint(transaction.id, input);
    await chmod(
      path.join(store.root, "points", transaction.id, "manifest.json"),
      0o644
    );
    await expect(store.verify(transaction.id)).rejects.toThrow("private");
    await chmod(path.join(store.root, "transactions", transaction.id), 0o644);
    await expect(store.read(transaction.id)).rejects.toThrow("private");
  });
});
