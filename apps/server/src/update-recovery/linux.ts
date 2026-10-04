import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import { RecoveryStore } from "./store.js";
import { packageVersion } from "../generated/runtime-assets.js";
import {
  verifyAndStageRuntime,
  verifyRecoveryCapability,
  type RecoveryCapability,
} from "../server/release-artifact.js";
import { runCommand } from "../shared/lib/run-command.js";
import { recoveryProof, RECOVERY_ROUTE_PREFIX } from "./protocol.js";
import { RecoveryCoordinator, type RecoveryEffects } from "./coordinator.js";
import {
  hashRegular,
  inventoryState,
  readPrivate,
  restoreState,
  syncDirectory,
  writeAtomic,
  type StateInventory,
} from "./files.js";
import {
  createPostgresBackup,
  restorePostgresBackup,
  verifyPostgresBackup,
  verifyRestoredPostgresDatabase,
  type PostgresBackupMetadata,
} from "./postgres.js";

const policySchema = z
  .object({
    kind: z.literal("dedicated-owned"),
    database: z.string().min(1),
    owner: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
  })
  .strict();
const installationSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.string().uuid(),
    stateRoot: z.string().refine(path.isAbsolute),
    runtime: z.string().refine(path.isAbsolute),
    envFile: z.string().refine(path.isAbsolute),
    service: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    helper: z.string().refine(path.isAbsolute),
    policy: policySchema.nullable(),
  })
  .strict();
type Installation = z.infer<typeof installationSchema>;
const planSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    candidate: z.string().refine(path.isAbsolute),
    targetVersion: z.string().min(1),
    targetCapability: z
      .object({
        protocol: z.literal(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    databaseUrl: z.string().min(1),
    databasePolicy: policySchema,
  })
  .strict();
type Plan = z.infer<typeof planSchema>;

/** Reject incomplete writer/inventory proofs before snapshotting or committing. */
export function assertLinuxRecoveryBoundary(
  value: Record<string, unknown>,
  stateRoot: string
): void {
  if (
    value.hostsStopped !== true ||
    !Array.isArray(value.liveHosts) ||
    value.liveHosts.length !== 0 ||
    !Array.isArray(value.statePaths) ||
    !value.statePaths.includes(stateRoot) ||
    value.statePaths.some(
      (entry) =>
        typeof entry !== "string" ||
        !path.isAbsolute(entry) ||
        (path.resolve(entry) !== stateRoot &&
          !path.resolve(entry).startsWith(`${stateRoot}/`))
    )
  ) {
    throw new Error(
      "Recovery boundary is incomplete or outside enrolled state"
    );
  }
}

async function command(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Recovery command timed out"));
    }, 120_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Recovery command could not start"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}
async function checked(commandName: string, args: string[]): Promise<void> {
  if ((await command(commandName, args)) !== 0)
    throw new Error("Recovery service operation failed");
}
async function recoveryRequest(
  env: Record<string, string>,
  keyFile: string,
  name: string,
  body: Record<string, unknown>,
  secret: Record<string, string> = {},
  method: "POST" | "DELETE" = "POST"
): Promise<Record<string, unknown>> {
  const key = (await readPrivate(keyFile)).trim();
  const challenge = randomBytes(32).toString("hex");
  const route = `${RECOVERY_ROUTE_PREFIX}${name}`;
  const response = await fetch(
    `http://127.0.0.1:${env.DISPATCH_PORT}${route}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Dispatch-Recovery ${key}`,
      },
      body: JSON.stringify({ ...body, challenge }),
      signal: AbortSignal.timeout(
        name === "fence" && method === "POST" ? 90_000 : 5000
      ),
    }
  );
  const value = (await response.json()) as Record<string, unknown>;
  const { proof, ...payload } = value;
  const expected = recoveryProof(
    Buffer.from(key),
    route,
    challenge,
    payload,
    secret
  );
  if (
    typeof proof !== "string" ||
    proof.length !== expected.length ||
    !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
  )
    throw new Error("Recovery response identity failed");
  if (!response.ok)
    throw new Error(
      payload.code === "BUSY" || payload.code === "DRAIN_TIMEOUT"
        ? "Update deferred: active work must finish before retrying"
        : "Recovery request was rejected"
    );
  return payload;
}
async function load(config: string): Promise<{
  installation: Installation;
  env: Record<string, string>;
  store: RecoveryStore;
}> {
  const installation = installationSchema.parse(
    JSON.parse(await readPrivate(config))
  );
  const store = await RecoveryStore.open(path.dirname(config));
  const env = parse(await readPrivate(installation.envFile));
  if (
    env.DISPATCH_STATE_DIR !== installation.stateRoot ||
    env.DISPATCH_RUNTIME_PATH !== installation.runtime ||
    env.DISPATCH_SERVICE_NAME !== installation.service
  )
    throw new Error("Recovery enrollment no longer matches installation");
  // Every durable override must be under the inventoried state tree. External
  // repositories are never copied. Unsupported custom state layouts fail closed.
  for (const [key, value] of Object.entries(env)) {
    if (
      (/^DISPATCH_.*_PATH$/.test(key) &&
        !["DISPATCH_RUNTIME_PATH", "DISPATCH_RECOVERY_KEY_PATH"].includes(
          key
        )) ||
      ["DISPATCH_FILES_ROOT", "DISPATCH_AGENT_STATE_ROOT"].includes(key)
    ) {
      const resolved = path.resolve(value);
      if (!resolved.startsWith(`${installation.stateRoot}${path.sep}`))
        throw new Error("Custom durable paths require a recovery adapter");
    }
  }
  if (env.DISPATCH_RECOVERY_KEY_PATH !== path.join(store.root, "key"))
    throw new Error("Recovery enrollment key path changed");
  return { installation, env, store };
}

/** Fresh artifact installer enrollment. Ownership is the installer's
 * attestation that the database, generated or supplied, is dedicated to
 * Dispatch; postgres.ts preflight still verifies it before every backup. */
export async function enrollLinux(
  envFile: string,
  owned: boolean
): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("Linux recovery requires Linux");
  const env = parse(await readPrivate(envFile));
  const stateRoot = path.resolve(env.DISPATCH_STATE_DIR ?? "");
  const runtime = path.resolve(env.DISPATCH_RUNTIME_PATH ?? "");
  if (
    !env.DISPATCH_STATE_DIR ||
    !env.DISPATCH_RUNTIME_PATH ||
    !env.DISPATCH_SERVICE_NAME
  )
    throw new Error("Missing installation layout");
  const store = await RecoveryStore.open(`${stateRoot}.recovery`);
  const helper = path.join(store.root, "dispatch-recovery");
  await copyFile(runtime, helper, 1);
  await chmod(helper, 0o700);
  const handle = await open(helper, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(store.root);
  const url = new URL(env.DATABASE_URL);
  const installation = installationSchema.parse({
    version: 1,
    instanceId: randomUUID(),
    stateRoot,
    runtime,
    envFile: path.resolve(envFile),
    service: env.DISPATCH_SERVICE_NAME,
    helper,
    policy: owned
      ? {
          kind: "dedicated-owned",
          database: decodeURIComponent(url.pathname.slice(1)),
          owner: decodeURIComponent(url.username),
          host: url.hostname,
          port: Number(url.port || 5432),
        }
      : null,
  });
  await writeAtomic(
    path.join(store.root, "installation.json"),
    JSON.stringify(installation)
  );
  const keyFile = path.join(store.root, "key");
  await writeAtomic(keyFile, randomBytes(32).toString("hex"));
  env.DISPATCH_RECOVERY_KEY_PATH = keyFile;
  await writeAtomic(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
}

/** Called after download verification, before changing the runtime. */
export async function prepareLinuxUpdate(
  config: string,
  candidate: string,
  targetVersion: string,
  previousVersion: string,
  targetCapability: RecoveryCapability
): Promise<{ id: string; helper: string; root: string }> {
  const { installation, store, env } = await load(config);
  if (!installation.policy)
    throw new Error(
      "Protected updates require an explicitly owned local PostgreSQL database"
    );
  if ((await lstat(candidate)).isFile() !== true)
    throw new Error("Update candidate must be a regular executable");
  if (!installation.envFile.startsWith(`${installation.stateRoot}${path.sep}`))
    throw new Error(
      "Protected updates require configuration under the inventoried state directory"
    );
  const targetHash = await hashRegular(candidate);
  if (
    targetCapability?.protocol !== 1 ||
    targetCapability.sha256 !== targetHash
  )
    throw new Error(
      "Target cannot be trialled safely: recovery capability does not match executable"
    );
  const transaction = await store.begin({
    instanceId: installation.instanceId,
    previous: {
      version: previousVersion,
      sha256: await hashRegular(installation.runtime),
    },
    target: { version: targetVersion, sha256: targetHash },
    wasRunning: true,
  });
  const quarantined = await lstat(
    path.join(store.root, `quarantine-${transaction.target.sha256}`)
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (quarantined) {
    await store.transition(
      transaction.id,
      "preparing",
      "aborted",
      "TARGET_QUARANTINED"
    );
    throw new Error(
      "This artifact failed recovery probation; inspect recovery before explicitly retrying"
    );
  }
  const workRoot = `${store.root}.staging`;
  await mkdir(workRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(workRoot);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Recovery staging must be private and owned");
  const work = path.join(workRoot, transaction.id);
  await mkdir(work, { mode: 0o700 });
  const pinnedCandidate = path.join(work, "candidate");
  await copyFile(candidate, pinnedCandidate, 1);
  await chmod(pinnedCandidate, 0o700);
  if ((await hashRegular(pinnedCandidate)) !== transaction.target.sha256)
    throw new Error("Candidate changed during preparation");
  const plan: Plan = {
    version: 1,
    id: transaction.id,
    nonce: randomBytes(32).toString("hex"),
    candidate: pinnedCandidate,
    targetVersion,
    targetCapability,
    databaseUrl: env.DATABASE_URL,
    databasePolicy: installation.policy,
  };
  await writeAtomic(path.join(work, "plan.json"), JSON.stringify(plan));
  // The active pointer is written only once the plan is complete. Start gates
  // refuse activation without the same persisted transaction identity.
  await writeAtomic(
    path.join(store.root, "active.json"),
    JSON.stringify({ id: transaction.id })
  );
  return { id: transaction.id, helper: installation.helper, root: store.root };
}

export async function applyProtectedLinuxUpdate(input: {
  tarballPath: string;
  tag: string;
  expectedTarballSha256: string;
  onProgress: (message: string) => void;
  onRestarting?: () => void;
}): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("Protected Linux updates require Linux");
  const stateRoot = process.env.DISPATCH_STATE_DIR;
  if (!stateRoot || !path.isAbsolute(stateRoot))
    throw new Error(
      "Linux update recovery is not enrolled; enable recovery before applying updates"
    );
  const config = path.join(`${stateRoot}.recovery`, "installation.json");
  const { installation, store } = await load(config);
  if (!installation.policy)
    throw new Error(
      "Linux updates require explicit dedicated database recovery enrollment"
    );
  const requestLock = path.join(store.root, "request.lock");
  await withLinuxRequestLease(requestLock, async () => {
    let active: string | undefined;
    try {
      active = z
        .object({ id: z.string().uuid() })
        .strict()
        .parse(
          JSON.parse(await readPrivate(path.join(store.root, "active.json")))
        ).id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      active &&
      !["committed", "rolled-back", "aborted"].includes(
        (await store.read(active)).phase
      )
    )
      throw new Error(
        "An unfinished update must be recovered before another update"
      );
    const unit = await runCommand("systemctl", [
      "--user",
      "show",
      `${installation.service}.service`,
      "-p",
      "ExecStartPre",
      "-p",
      "ExecStart",
      "-p",
      "KillMode",
    ]);
    if (
      !unit.stdout.includes(installation.helper) ||
      !unit.stdout.includes("recovery-serve") ||
      !unit.stdout.includes(config) ||
      !unit.stdout.includes(installation.runtime) ||
      !unit.stdout.includes("KillMode=process")
    )
      throw new Error(
        "Linux service is not using the enrolled recovery startup gate"
      );
    const staging = await mkdtemp(
      path.join(path.dirname(store.root), ".dispatch-update-")
    );
    await chmod(staging, 0o700);
    try {
      const targetCapability = await verifyRecoveryCapability(input);
      const candidate = path.join(staging, "candidate");
      await verifyAndStageRuntime({
        tarballPath: input.tarballPath,
        tag: input.tag,
        livePath: candidate,
        runCommand,
      });
      const prepared = await prepareLinuxUpdate(
        config,
        candidate,
        input.tag,
        packageVersion,
        targetCapability
      );
      input.onProgress(
        "Recovery helper will fence idle Dispatch, verify the backup, and trial the update before commit."
      );
      await checked("systemd-run", [
        "--user",
        "--collect",
        "--no-block",
        `--unit=dispatch-recovery-${prepared.id}`,
        "--property=Type=oneshot",
        "flock",
        "--nonblock",
        path.join(prepared.root, "instance.lock"),
        prepared.helper,
        "recovery-apply",
        config,
        prepared.id,
      ]);
      await observeLinuxHandoff(
        () => store.read(prepared.id),
        input.onRestarting
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function effects(
  config: string,
  id: string,
  boot: boolean
): Promise<{
  store: RecoveryStore;
  effects: RecoveryEffects;
  installation: Installation;
  env: Record<string, string>;
  plan: Plan;
}> {
  const { installation, env, store } = await load(config);
  if (!installation.policy)
    throw new Error("Recovery database is not enrolled");
  const work = path.join(`${store.root}.staging`, id);
  const plan = planSchema.parse(
    JSON.parse(await readPrivate(path.join(work, "plan.json")))
  );
  if (plan.id !== id) throw new Error("Recovery plan identity mismatch");
  const policy = plan.databasePolicy;
  const pgOptions = { databaseUrl: plan.databaseUrl, policy };
  const service = `${installation.service}.service`;
  const proveVersion = async (
    version: string,
    restored = false
  ): Promise<void> => {
    const manifest = await store.verify(id);
    const entry = manifest.files.find(
      (file) => file.source === path.join(work, "database-metadata.json")
    );
    if (!entry) throw new Error("Recovery database identity missing");
    const metadata = JSON.parse(
      await readPrivate(path.join(store.root, "points", id, String(entry.slot)))
    ) as PostgresBackupMetadata;
    const expected = restored
      ? (JSON.parse(
          await readPrivate(path.join(work, "restored-database.json"))
        ) as { databaseUrl: string; databaseOid: string })
      : { databaseUrl: plan.databaseUrl, databaseOid: metadata.databaseOid };
    const databaseName = decodeURIComponent(
      new URL(expected.databaseUrl).pathname.slice(1)
    );
    const deadline = Date.now() + 180_000;
    let stableSince: number | null = null;
    while (Date.now() < deadline) {
      try {
        const value = await recoveryRequest(
          env,
          path.join(store.root, "key"),
          "readiness",
          {
            transactionId: id,
            nonce: plan.nonce,
            instanceId: installation.instanceId,
            expectedVersion: version.replace(/^v/, ""),
          },
          { nonce: plan.nonce }
        );
        assertLinuxRecoveryBoundary(value, installation.stateRoot);
        const database = value.database as
          | { name?: string; oid?: string }
          | undefined;
        if (
          database?.name !== databaseName ||
          database.oid !== expected.databaseOid ||
          !value.ready ||
          (typeof value.version === "string"
            ? value.version.replace(/^v/, "")
            : "") !== version.replace(/^v/, "") ||
          value.instanceId !== installation.instanceId ||
          value.transactionId !== id
        )
          throw new Error("Wrong trial identity");
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 60_000) return;
      } catch {
        stableSince = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Trial readiness timed out");
  };
  const ef: RecoveryEffects = {
    stopAndFence: async (tx) => {
      if (!boot && tx.phase === "preparing") {
        const fenced = await recoveryRequest(
          env,
          path.join(store.root, "key"),
          "fence",
          {
            transactionId: id,
            leaseMs: 600_000,
          }
        );
        assertLinuxRecoveryBoundary(fenced, installation.stateRoot);
        const identity = fenced.instance as
          | { instanceId?: string; stateDir?: string; port?: number }
          | undefined;
        if (
          fenced.transactionId !== id ||
          fenced.mode !== "fenced" ||
          identity?.instanceId !== installation.instanceId ||
          identity.stateDir !== installation.stateRoot ||
          identity.port !== Number(env.DISPATCH_PORT)
        )
          throw new Error(
            "Fenced server identity does not match enrolled installation"
          );
      }
      if (!boot) await checked("systemctl", ["--user", "stop", service]);
    },
    checkpoint: async (tx) => {
      const { inventory, files } = await inventoryState(
        [installation.stateRoot],
        [installation.runtime, path.join(installation.stateRoot, "cache")]
      );
      const inventoryPath = path.join(work, "inventory.json");
      await writeAtomic(inventoryPath, JSON.stringify(inventory));
      const archivePath = path.join(work, "database.dump");
      const metadata = await createPostgresBackup({
        ...pgOptions,
        outputPath: archivePath,
      });
      const metadataPath = path.join(work, "database-metadata.json");
      await writeAtomic(metadataPath, JSON.stringify(metadata));
      return store.checkpoint(tx.id, {
        files: [
          { role: "runtime", source: installation.runtime },
          { role: "database", source: archivePath },
          { role: "state", source: inventoryPath },
          { role: "state", source: metadataPath },
          ...files,
        ],
        verifyDatabaseRestore: async ({ databaseFiles }) =>
          verifyPostgresBackup({
            ...pgOptions,
            archivePath: databaseFiles[0],
            metadata,
          }),
      });
    },
    activate: async (tx) => {
      if (
        plan.targetCapability.protocol !== 1 ||
        plan.targetCapability.sha256 !== tx.target.sha256 ||
        (await hashRegular(plan.candidate)) !== tx.target.sha256
      )
        throw new Error("Target checksum changed");
      const temp = `${installation.runtime}.next-${id}`;
      await copyFile(plan.candidate, temp);
      await chmod(temp, 0o755);
      const handle = await open(temp, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, installation.runtime);
      await syncDirectory(path.dirname(installation.runtime));
    },
    startTrial: async () => checked("systemctl", ["--user", "start", service]),
    proveReady: async (tx) => {
      await proveVersion(plan.targetVersion);
      await writeAtomic(
        path.join(installation.stateRoot, "release-candidate.json"),
        JSON.stringify({
          tag: plan.targetVersion,
          previousTag: `v${tx.previous.version.replace(/^v/, "")}`,
          activatedAt: new Date().toISOString(),
        })
      );
    },
    restore: async (tx, manifest) => {
      const point = path.join(store.root, "points", id);
      const source = (name: string) => {
        const entry = manifest.files.find(
          (file) => file.source === path.join(work, name)
        );
        if (!entry) throw new Error("Recovery metadata missing");
        return path.join(point, String(entry.slot));
      };
      const metadata = JSON.parse(
        await readPrivate(source("database-metadata.json"))
      ) as PostgresBackupMetadata;
      const inventory = JSON.parse(
        await readPrivate(source("inventory.json"))
      ) as StateInventory;
      const database = manifest.files.find((file) => file.role === "database");
      if (!database) throw new Error("Recovery database missing");
      const restoredPath = path.join(work, "restored-database.json");
      let restored: Awaited<ReturnType<typeof restorePostgresBackup>>;
      try {
        restored = JSON.parse(await readPrivate(restoredPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        restored = await restorePostgresBackup({
          ...pgOptions,
          archivePath: path.join(point, String(database.slot)),
          metadata,
        });
        await writeAtomic(restoredPath, JSON.stringify(restored));
      }
      await verifyRestoredPostgresDatabase({
        ...pgOptions,
        databaseUrl: restored.databaseUrl,
        databaseOid: restored.databaseOid,
        metadata,
      });
      // Restore original state, including .env, before switching its DB pointer.
      await restoreState({
        inventory,
        manifest,
        pointDirectory: point,
        transactionId: id,
      });
      const runtime = manifest.files.find((file) => file.role === "runtime");
      if (!runtime) throw new Error("Recovery runtime missing");
      const temp = `${installation.runtime}.restore-${id}`;
      await copyFile(path.join(point, String(runtime.slot)), temp);
      await chmod(temp, runtime.mode);
      await rename(temp, installation.runtime);
      await syncDirectory(path.dirname(installation.runtime));
      const original = parse(await readPrivate(installation.envFile));
      original.DATABASE_URL = restored.databaseUrl;
      await writeAtomic(
        installation.envFile,
        Object.entries(original)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n") + "\n"
      );
      const url = new URL(restored.databaseUrl);
      const updated = {
        ...installation,
        policy: {
          ...policy,
          database: decodeURIComponent(url.pathname.slice(1)),
        },
      };
      await writeAtomic(config, JSON.stringify(updated));
      await writeAtomic(
        path.join(work, "restored-trial.json"),
        JSON.stringify({
          id,
          version: tx.previous.version,
          sha256: tx.previous.sha256,
        })
      );
      await writeAtomic(
        path.join(store.root, `quarantine-${tx.target.sha256}`),
        JSON.stringify({ transactionId: id, target: tx.target })
      );
    },
    startRestoredTrial: async () =>
      checked("systemctl", ["--user", "start", service]),
    proveRestoredReady: async (tx) => proveVersion(tx.previous.version, true),
    startNormal: async (tx) => {
      if (!boot && tx.phase === "aborted") {
        // The request may have failed after the server closed admission.
        // Abort is authenticated and transaction-scoped, including an in-flight fence.
        await recoveryRequest(
          env,
          path.join(store.root, "key"),
          "fence",
          { transactionId: id },
          {},
          "DELETE"
        ).catch(() => {});
      }
      if (!boot)
        await checked("systemctl", [
          "--user",
          tx.phase === "aborted" ? "start" : "restart",
          service,
        ]);
    },
  };
  return { store, effects: ef, installation, env, plan };
}

export async function runLinuxRecovery(
  config: string,
  id: string,
  boot = false,
  resume = false
): Promise<void> {
  const loaded = await effects(config, id, boot);
  await loaded.store.reconcileAbandonedMutationLock(id, () =>
    assertLinuxLease(loaded.store.root)
  );
  const coordinator = new RecoveryCoordinator(loaded.store, loaded.effects);
  if (boot) {
    const tx = await loaded.store.read(id);
    if (tx.phase === "recovery-required")
      throw new Error("Manual recovery inspection required");
    if (["activating", "probation", "restoring"].includes(tx.phase)) {
      await checked("systemd-run", [
        "--user",
        "--collect",
        "--no-block",
        `--unit=dispatch-recovery-${id}`,
        "--property=Type=oneshot",
        "flock",
        path.join(loaded.store.root, "instance.lock"),
        loaded.installation.helper,
        "recovery-resume",
        config,
        id,
      ]);
      throw new Error(
        "Independent boot recovery queued; startup remains fenced"
      );
    }
    await coordinator.resume(id);
  } else if (resume) await coordinator.resume(id);
  else await coordinator.apply(id);
}

async function assertLinuxLease(root: string): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("Linux recovery lease is unavailable");
  const stat = await lstat(path.join(root, "instance.lock"), { bigint: true });
  if (
    !stat.isFile() ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  )
    throw new Error("Invalid recovery lease file");
  const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
  const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
  const match = (await readFile("/proc/locks", "utf8"))
    .split("\n")
    .some((line) => {
      const parts = line.trim().split(/\s+/);
      const device = parts[5]?.split(":");
      return (
        parts[1] === "FLOCK" &&
        parts[3] === "WRITE" &&
        Number(parts[4]) === process.ppid &&
        device?.length === 3 &&
        BigInt(`0x${device[0]}`) === major &&
        BigInt(`0x${device[1]}`) === minor &&
        BigInt(device[2]) === stat.ino
      );
    });
  if (!match)
    throw new Error(
      "Independent recovery helper does not hold the instance OS lease"
    );
}

/** Permanent service entrypoint. Before a normal start, acquire the same OS
 * lease as the installer helper and replay any interrupted transaction. */
export async function serveLinuxRecovery(config: string): Promise<void> {
  let loaded = await load(config);
  let id: string | undefined;
  try {
    id = z
      .object({ id: z.string().uuid() })
      .strict()
      .parse(
        JSON.parse(
          await readPrivate(path.join(loaded.store.root, "active.json"))
        )
      ).id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let trial = false;
  let trialVersion: string | undefined;
  let plan: Plan | undefined;
  if (id) {
    const code = await command("flock", [
      "--nonblock",
      "--conflict-exit-code",
      "75",
      path.join(loaded.store.root, "instance.lock"),
      loaded.installation.helper,
      "recovery-boot",
      config,
      id,
    ]);
    if (code === 75) {
      const tx = await loaded.store.read(id);
      if (tx.phase === "probation" || tx.phase === "restoring") {
        trial = true;
        plan = planSchema.parse(
          JSON.parse(
            await readPrivate(
              path.join(`${loaded.store.root}.staging`, id, "plan.json")
            )
          )
        );
        trialVersion = plan.targetVersion;
        if (tx.phase === "restoring") {
          const restored = z
            .object({
              id: z.string().uuid(),
              version: z.string(),
              sha256: z.string(),
            })
            .strict()
            .parse(
              JSON.parse(
                await readPrivate(
                  path.join(
                    `${loaded.store.root}.staging`,
                    id,
                    "restored-trial.json"
                  )
                )
              )
            );
          if (
            restored.id !== id ||
            restored.version !== tx.previous.version ||
            restored.sha256 !== tx.previous.sha256 ||
            (await hashRegular(loaded.installation.runtime)) !==
              tx.previous.sha256
          )
            throw new Error("Restored trial identity mismatch");
          trialVersion = tx.previous.version;
        }
      } else if (!["committed", "rolled-back", "aborted"].includes(tx.phase))
        throw new Error("Update recovery is still fenced");
    } else if (code !== 0)
      throw new Error("Interrupted update could not be recovered");
    loaded = await load(config);
  }
  const env: Record<string, string> = {
    DISPATCH_INSTANCE_ID: loaded.installation.instanceId,
    DISPATCH_RECOVERY_PROBATION: "",
    DISPATCH_RECOVERY_TRANSACTION_ID: "",
    DISPATCH_RECOVERY_NONCE: "",
    DISPATCH_RECOVERY_INSTANCE_ID: "",
    DISPATCH_RECOVERY_EXPECTED_VERSION: "",
  };
  if (trial && plan) {
    env.DISPATCH_RECOVERY_PROBATION = "1";
    env.DISPATCH_RECOVERY_TRANSACTION_ID = plan.id;
    env.DISPATCH_RECOVERY_NONCE = plan.nonce;
    env.DISPATCH_RECOVERY_INSTANCE_ID = loaded.installation.instanceId;
    env.DISPATCH_RECOVERY_EXPECTED_VERSION = (
      trialVersion ?? plan.targetVersion
    ).replace(/^v/, "");
  }
  // ExecStartPre produces a private EnvironmentFile which systemd rereads
  // before ExecStart. The unit still tracks the compiled server directly.
  await writeAtomic(
    path.join(loaded.store.root, "launch.env"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
}

/** The lock holder follows this process's pipe lifetime, including abrupt death. */
export async function withLinuxRequestLease<T>(
  file: string,
  work: () => Promise<T>
): Promise<T> {
  const handle = await open(
    file,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe request lease");
    const holder = spawn(
      "flock",
      [
        "--nonblock",
        "--conflict-exit-code",
        "75",
        "/proc/self/fd/3",
        "sh",
        "-c",
        "printf 'locked\\n'; cat >/dev/null",
      ],
      { stdio: ["pipe", "pipe", "ignore", handle.fd] }
    );
    const closed = new Promise<void>((resolve) =>
      holder.once("close", () => resolve())
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Request lease timed out")),
          5000
        );
        const finish = (error?: Error) => {
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        holder.once("error", () =>
          finish(new Error("Request lease unavailable"))
        );
        holder.once("exit", () =>
          finish(new Error("Another update request holds the OS lease"))
        );
        holder.stdout!.once("data", () => finish());
      });
      return await work();
    } finally {
      holder.stdin!.end();
      await closed;
    }
  } finally {
    await handle.close();
  }
}

/** Observe pre-stop failures while this server still owns its release job. */
export async function observeLinuxHandoff(
  read: () => Promise<{ phase: string; failureCode?: string }>,
  onRestarting: () => void = () => {},
  timeoutMs = 120_000,
  sleep: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 500))
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = await read();
    if (tx.phase === "aborted")
      throw new Error(
        "Update deferred or preparation aborted; finish active work and retry. Inspect recovery evidence if it persists."
      );
    if (tx.phase === "recovery-required")
      throw new Error("Update recovery requires inspection");
    if (tx.phase !== "preparing") {
      onRestarting();
      return;
    }
    await sleep();
  }
  throw new Error(
    "Recovery helper did not finish admission; inspect the recovery transaction before retrying"
  );
}
