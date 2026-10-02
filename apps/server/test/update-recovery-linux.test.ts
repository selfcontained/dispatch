import { randomUUID, createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertLinuxRecoveryBoundary,
  prepareLinuxUpdate,
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
it("rejects unenrolled supplied databases before recording a transaction", async () => {
  const f = await fixture();
  await writeFile(
    f.config,
    JSON.stringify({ ...f.installation, policy: null })
  );
  await expect(
    prepareLinuxUpdate(f.config, f.candidate, "v2", "1", {
      protocol: 1,
      sha256: createHash("sha256").update("new").digest("hex"),
    })
  ).rejects.toThrow("explicitly owned");
  expect(await readFile(f.runtime, "utf8")).toBe("old");
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
