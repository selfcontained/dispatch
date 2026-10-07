import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inventoryState, restoreState } from "../src/update-recovery/files.js";
import { RecoveryStore } from "../src/update-recovery/store.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-state-recovery-"))
  );
  roots.push(root);
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  await mkdir(path.join(state, "empty"));
  await writeFile(path.join(state, "settings"), "before", { mode: 0o600 });
  const runtime = path.join(root, "runtime"),
    database = path.join(root, "database");
  await writeFile(runtime, "old", { mode: 0o700 });
  await writeFile(database, "backup", { mode: 0o600 });
  const store = await RecoveryStore.open(path.join(root, "recovery"));
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const tx = await store.begin({
    instanceId: "one",
    previous: { version: "1", sha256: hash("old") },
    target: { version: "2", sha256: hash("new") },
    wasRunning: true,
  });
  const { inventory, files } = await inventoryState([state]);
  const manifest = await store.checkpoint(tx.id, {
    files: [
      { role: "runtime", source: runtime },
      { role: "database", source: database },
      ...files,
    ],
    verifyDatabaseRestore: async () => {},
  });
  const restore = () =>
    restoreState({
      inventory,
      manifest,
      pointDirectory: path.join(store.root, "points", tx.id),
      transactionId: tx.id,
    });
  return { root, state, tx, restore };
}
it("restores state and empty directories while preserving the failed tree", async () => {
  const f = await fixture();
  await writeFile(path.join(f.state, "settings"), "failed target data");
  await writeFile(path.join(f.state, "new"), "new data");
  await f.restore();
  expect(await readFile(path.join(f.state, "settings"), "utf8")).toBe("before");
  expect(await realpath(path.join(f.state, "empty"))).toBe(
    path.join(f.state, "empty")
  );
  const failed = `${f.state}.failed-${f.tx.id}`;
  expect(await readFile(path.join(failed, "settings"), "utf8")).toBe(
    "failed target data"
  );
  expect(await readFile(path.join(failed, "new"), "utf8")).toBe("new data");
  await f.restore();
  expect(await readFile(path.join(failed, "settings"), "utf8")).toBe(
    "failed target data"
  );
});
it("reconciles an interruption after install but before the durable marker", async () => {
  const f = await fixture();
  await writeFile(path.join(f.state, "settings"), "failed");
  await f.restore();
  await rm(`${f.state}.restored-${f.tx.id}`);
  await f.restore();
  expect(
    await readFile(
      path.join(`${f.state}.failed-${f.tx.id}`, "settings"),
      "utf8"
    )
  ).toBe("failed");
});
it("fails closed if an installed restore has changed before retry", async () => {
  const f = await fixture();
  await f.restore();
  await rm(`${f.state}.restored-${f.tx.id}`);
  await writeFile(path.join(f.state, "settings"), "unexpected writes");
  await expect(f.restore()).rejects.toThrow("unexpected live data");
});
it("rejects linked durable state and overlapping roots", async () => {
  const f = await fixture();
  await symlink(path.join(f.state, "settings"), path.join(f.state, "link"));
  await expect(inventoryState([f.state])).rejects.toThrow("linked or special");
  await expect(
    inventoryState([f.state, path.join(f.state, "empty")])
  ).rejects.toThrow("overlap");
});
