import { randomUUID, createHash } from "node:crypto";
import {
  chmod,
  lstat,
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertLinuxRecoveryBoundary,
  prepareLinuxUpdate,
  pruneLinuxRecovery,
  cleanupLinuxAfterStartup,
} from "../src/update-recovery/linux.js";
import { RecoveryStore } from "../src/update-recovery/store.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-linux-recovery-"))
  );
  roots.push(root);
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const store = await RecoveryStore.open(`${state}.recovery`);
  const runtime = path.join(state, "dispatch"),
    envFile = path.join(state, ".env"),
    candidate = path.join(root, "candidate");
  await writeFile(runtime, "old", { mode: 0o700 });
  await writeFile(candidate, "new", { mode: 0o700 });
  await writeFile(
    envFile,
    `DATABASE_URL=postgres://owned:secret@127.0.0.1/owned\nDISPATCH_STATE_DIR=${state}\nDISPATCH_RUNTIME_PATH=${runtime}\nDISPATCH_SERVICE_NAME=dispatch-server\nDISPATCH_RECOVERY_KEY_PATH=${store.root}/key\n`,
    { mode: 0o600 }
  );
  const installation = {
    version: 1,
    instanceId: randomUUID(),
    stateRoot: state,
    runtime,
    envFile,
    service: "dispatch-server",
    helper: path.join(store.root, "helper"),
    policy: {
      kind: "dedicated-owned",
      database: "owned",
      owner: "owned",
      host: "127.0.0.1",
      port: 5432,
    },
  };
  const config = path.join(store.root, "installation.json");
  await writeFile(config, JSON.stringify(installation), { mode: 0o600 });
  return { root, store, config, candidate, runtime, installation, envFile };
}
it("pins a candidate and private recovery plan without changing the live executable", async () => {
  const f = await fixture();
  const prepared = await prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
    protocol: 1,
    sha256: createHash("sha256").update("new").digest("hex"),
  });
  await writeFile(f.candidate, "substituted");
  const plan = JSON.parse(
    await readFile(
      path.join(`${f.store.root}.staging`, prepared.id, "plan.json"),
      "utf8"
    )
  );
  expect(await readFile(plan.candidate, "utf8")).toBe("new");
  expect(await readFile(f.runtime, "utf8")).toBe("old");
  expect((await f.store.read(prepared.id)).previous.version).toBe("1");
  expect(plan.nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(
    JSON.parse(await readFile(path.join(f.store.root, "active.json"), "utf8"))
  ).toEqual({ id: prepared.id });
});
it("rejects mismatched and public control files before activation", async () => {
  const f = await fixture();
  await chmod(f.config, 0o644);
  await expect(
    prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
      protocol: 1,
      sha256: createHash("sha256").update("new").digest("hex"),
    })
  ).rejects.toThrow("private");
  await chmod(f.config, 0o600);
  await writeFile(f.envFile, "DISPATCH_STATE_DIR=/unexpected\n");
  await expect(
    prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
      protocol: 1,
      sha256: createHash("sha256").update("new").digest("hex"),
    })
  ).rejects.toThrow("no longer matches");
});
it("fails closed for unowned durable state overrides", async () => {
  const f = await fixture();
  await writeFile(
    f.envFile,
    (await readFile(f.envFile, "utf8")) +
      "DISPATCH_AGENT_STATE_ROOT=/external\n"
  );
  await expect(
    prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
      protocol: 1,
      sha256: createHash("sha256").update("new").digest("hex"),
    })
  ).rejects.toThrow("Custom durable paths");
});

it("rejects incomplete writer proofs and external durable state", () => {
  const proof = {
    hostsStopped: true,
    liveHosts: [],
    statePaths: ["/owned/state"],
  };
  expect(() =>
    assertLinuxRecoveryBoundary(proof, "/owned/state")
  ).not.toThrow();
  for (const bad of [
    { ...proof, hostsStopped: false },
    { ...proof, liveHosts: ["agent"] },
    { ...proof, statePaths: [] },
    { ...proof, statePaths: ["/owned/state", "/external"] },
    { ...proof, statePaths: ["/owned/state", "/owned/state/../outside"] },
  ])
    expect(() => assertLinuxRecoveryBoundary(bad, "/owned/state")).toThrow(
      /boundary/
    );
});

it("refuses a missing or mismatched target capability before journaling", async () => {
  const f = await fixture();
  await expect(
    prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
      protocol: 1,
      sha256: "0".repeat(64),
    })
  ).rejects.toThrow("cannot be trialled safely");
  expect(await readFile(f.runtime, "utf8")).toBe("old");
});

it("surfaces aborted admission and only reports restarting after backup", async () => {
  const { observeLinuxHandoff } =
    await import("../src/update-recovery/linux.js");
  let restarting = false;
  const phases = ["preparing", "aborted"];
  await expect(
    observeLinuxHandoff(
      async () => ({ phase: phases.shift()! }),
      () => {
        restarting = true;
      },
      1000,
      async () => {}
    )
  ).rejects.toThrow("deferred");
  expect(restarting).toBe(false);
  await observeLinuxHandoff(
    async () => ({ phase: "backed-up" }),
    () => {
      restarting = true;
    }
  );
  expect(restarting).toBe(true);
  await expect(
    observeLinuxHandoff(async () => ({ phase: "recovery-required" }))
  ).rejects.toThrow("inspection");
});

async function prepared(f: Awaited<ReturnType<typeof fixture>>) {
  return prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
    protocol: 1,
    sha256: createHash("sha256").update("new").digest("hex"),
  });
}
it("clears a pre-existing Linux backlog and preserves the active startup plan", async () => {
  const f = await fixture();
  const old = await prepared(f);
  await f.store.transition(old.id, "preparing", "aborted");
  const current = await prepared(f);
  await f.store.transition(current.id, "preparing", "aborted");
  for (const tx of [old, current]) {
    const work = path.join(`${f.store.root}.staging`, tx.id);
    await writeFile(path.join(work, "database.dump"), "backup", {
      mode: 0o600,
    });
    const point = path.join(f.store.root, "points", tx.id + ".incomplete");
    await mkdir(point, { mode: 0o700 });
    await writeFile(path.join(point, "dump"), "backup", { mode: 0o600 });
  }
  const failed = `${f.installation.stateRoot}.failed-${old.id}`;
  await mkdir(failed, { mode: 0o700 });
  await writeFile(path.join(failed, "old-state"), "failed state");
  const partial = `${f.installation.stateRoot}.restore-${old.id}-${randomUUID()}`;
  await mkdir(partial, { mode: 0o700 });
  await writeFile(path.join(partial, "duplicate"), "partial restore");
  const marker = `${f.installation.stateRoot}.restored-${old.id}`;
  await writeFile(marker, JSON.stringify({ transactionId: old.id }), {
    mode: 0o600,
  });
  await expect(
    pruneLinuxRecovery(f.config, async () => {
      throw new Error("no lease");
    })
  ).rejects.toThrow("no lease");
  expect(
    await readFile(
      path.join(`${f.store.root}.staging`, old.id, "database.dump"),
      "utf8"
    )
  ).toBe("backup");
  await pruneLinuxRecovery(f.config, async () => {});
  await expect(
    lstat(path.join(`${f.store.root}.staging`, old.id))
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(failed)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  for (const tx of [old, current]) {
    await expect(
      lstat(path.join(f.store.root, "points", tx.id + ".incomplete"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
  const plan = JSON.parse(
    await readFile(
      path.join(`${f.store.root}.staging`, current.id, "plan.json"),
      "utf8"
    )
  );
  expect(plan.id).toBe(current.id);
  await expect(lstat(plan.candidate)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.store.read(current.id)).phase).toBe("aborted");
  expect(await readFile(f.runtime, "utf8")).toBe("old");
  await pruneLinuxRecovery(f.config, async () => {});
});

it("cleans older completed updates while preserving an unfinished active update", async () => {
  const f = await fixture();
  const old = await prepared(f);
  await f.store.transition(old.id, "preparing", "aborted");
  const pending = await prepared(f);
  await pruneLinuxRecovery(f.config, async () => {});
  await expect(
    lstat(path.join(`${f.store.root}.staging`, old.id))
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(
      path.join(`${f.store.root}.staging`, pending.id, "candidate"),
      "utf8"
    )
  ).toBe("new");
  expect((await f.store.read(pending.id)).phase).toBe("preparing");
});

it("rejects a substituted staging root without deleting the target", async () => {
  const f = await fixture();
  const tx = await prepared(f);
  await f.store.transition(tx.id, "preparing", "aborted");
  const staging = `${f.store.root}.staging`;
  await rm(staging, { recursive: true });
  const outside = path.join(f.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(path.join(outside, "keep"), "keep");
  await symlink(outside, staging);
  await expect(pruneLinuxRecovery(f.config, async () => {})).rejects.toThrow(
    "owned, unlinked"
  );
  expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("keep");
});

it("uses the new runtime to clean older-helper backlogs after normal startup", async () => {
  const f = await fixture();
  await prepared(f);
  let attempts = 0;
  const run = vi.fn(async () => (++attempts === 1 ? 75 : 0));
  const sleep = vi.fn(async () => {});
  await cleanupLinuxAfterStartup({
    platform: "linux",
    executable: f.runtime,
    env: { DISPATCH_STATE_DIR: f.installation.stateRoot },
    run,
    sleep,
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledWith("flock", [
    "--nonblock",
    "--conflict-exit-code",
    "75",
    path.join(f.store.root, "instance.lock"),
    f.runtime,
    "recovery-prune",
    f.config,
  ]);
  expect(sleep).toHaveBeenCalledOnce();
});

it("skips startup cleanup on trials and unenrolled or non-Linux servers", async () => {
  const f = await fixture();
  const run = vi.fn(async () => 0);
  for (const options of [
    {
      platform: "darwin",
      env: { DISPATCH_STATE_DIR: f.installation.stateRoot },
    },
    {
      platform: "linux",
      env: {
        DISPATCH_STATE_DIR: f.installation.stateRoot,
        DISPATCH_RECOVERY_PROBATION: "1",
      },
    },
    { platform: "linux", env: {} },
    {
      platform: "linux",
      executable: "/usr/bin/bun",
      env: { DISPATCH_STATE_DIR: f.installation.stateRoot },
    },
    {
      platform: "linux",
      env: { DISPATCH_STATE_DIR: path.join(f.root, "unenrolled") },
    },
  ])
    await cleanupLinuxAfterStartup({ ...options, run });
  expect(run).not.toHaveBeenCalled();
  // An enrolled instance before its first update has no active transaction.
  await expect(
    pruneLinuxRecovery(f.config, async () => {})
  ).resolves.toBeUndefined();
});

it("cleans installer-mode 0755 displaced state and preserves unsafe entries without blocking the backlog", async () => {
  const f = await fixture();
  await chmod(f.installation.stateRoot, 0o755);
  const unsafe = await prepared(f);
  await f.store.transition(unsafe.id, "preparing", "aborted");
  const outside = path.join(f.root, "outside-state");
  await mkdir(outside, { mode: 0o755 });
  await writeFile(path.join(outside, "keep"), "unrelated");
  await symlink(outside, `${f.installation.stateRoot}.failed-${unsafe.id}`);
  const old = await prepared(f);
  await f.store.transition(old.id, "preparing", "aborted");
  const current = await prepared(f);
  await f.store.transition(current.id, "preparing", "aborted");
  for (const tx of [unsafe, old, current]) {
    const point = path.join(f.store.root, "points", tx.id + ".incomplete");
    await mkdir(point, { mode: 0o700 });
    await writeFile(path.join(point, "dump"), "backup");
  }
  const displaced: string[] = [];
  for (const tx of [old, current]) {
    const failed = `${f.installation.stateRoot}.failed-${tx.id}`;
    const partial = `${f.installation.stateRoot}.restore-${tx.id}-${randomUUID()}`;
    for (const directory of [failed, partial]) {
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
      await writeFile(path.join(directory, "snapshot"), "state");
      displaced.push(directory);
    }
  }
  await expect(pruneLinuxRecovery(f.config, async () => {})).rejects.toThrow(
    "Some completed recovery artifacts"
  );
  for (const directory of displaced)
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  for (const tx of [old, current])
    await expect(
      lstat(path.join(f.store.root, "points", tx.id + ".incomplete"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("unrelated");
  expect(
    (
      await lstat(`${f.installation.stateRoot}.failed-${unsafe.id}`)
    ).isSymbolicLink()
  ).toBe(true);
  expect(
    (
      await lstat(path.join(f.store.root, "points", unsafe.id + ".incomplete"))
    ).isDirectory()
  ).toBe(true);
  expect(
    JSON.parse(
      await readFile(
        path.join(`${f.store.root}.staging`, current.id, "plan.json"),
        "utf8"
      )
    ).id
  ).toBe(current.id);
});
