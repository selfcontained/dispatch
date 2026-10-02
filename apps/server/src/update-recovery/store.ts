import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const idSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z
  .object({ version: z.string().min(1), sha256: digestSchema })
  .strict();
const phaseSchema = z.enum([
  "preparing",
  "backed-up",
  "activating",
  "probation",
  "committed",
  "restoring",
  "rolled-back",
  "aborted",
  "recovery-required",
]);
export type RecoveryPhase = z.infer<typeof phaseSchema>;
const fileSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    role: z.enum(["runtime", "database", "state"]),
    source: z.string().refine(path.isAbsolute),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: digestSchema,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    transactionId: idSchema,
    instanceId: z.string().min(1),
    createdAt: z.string().datetime(),
    previous: artifactSchema,
    target: artifactSchema,
    files: z.array(fileSchema).min(2),
  })
  .strict();
export type RecoveryManifest = z.infer<typeof manifestSchema>;
const transactionSchema = z
  .object({
    formatVersion: z.literal(1),
    id: idSchema,
    instanceId: z.string().min(1),
    previous: artifactSchema,
    target: artifactSchema,
    wasRunning: z.boolean(),
    phase: phaseSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    manifestSha256: digestSchema.optional(),
    // Machine-readable codes only. Raw errors may contain credentials.
    failureCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
export type RecoveryTransaction = z.infer<typeof transactionSchema>;

const transitions: Record<RecoveryPhase, readonly RecoveryPhase[]> = {
  preparing: ["backed-up", "aborted", "recovery-required"],
  "backed-up": ["activating", "aborted", "recovery-required"],
  activating: ["probation", "restoring", "recovery-required"],
  probation: ["committed", "restoring", "recovery-required"],
  restoring: ["rolled-back", "recovery-required"],
  "recovery-required": ["restoring"],
  committed: [],
  "rolled-back": [],
  aborted: [],
};

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(path.dirname(directory));
}

async function openRegular(file: string): Promise<FileHandle> {
  // Reject devices before opening; the descriptor check still handles a path
  // replaced after lstat. NONBLOCK prevents a substituted FIFO waiting for a writer.
  if (!(await lstat(file)).isFile()) {
    throw new Error("Recovery input must be a regular file");
  }
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("Recovery input must be a regular file");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openPrivate(file: string): Promise<FileHandle> {
  const handle = await openRegular(file);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error(
        "Recovery file must be a private, user-owned regular file"
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readPrivate(file: string): Promise<Buffer> {
  const handle = await openPrivate(file);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeDurable(file: string, bytes: string): Promise<void> {
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(
  file: string
): Promise<{ sha256: string; bytes: number }> {
  const handle = await openPrivate(file);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

/** Copy, never hardlink: the running installation can mutate after checkpointing. */
async function snapshotFile(source: string, destination: string) {
  const input = await openRegular(source);
  let output: FileHandle | undefined;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "Recovery sources must be regular files of supported size"
      );
    }
    output = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      let offset = 0;
      while (offset < buffer.length) {
        const result = await output.write(
          buffer,
          offset,
          buffer.length - offset
        );
        if (result.bytesWritten === 0)
          throw new Error("Recovery snapshot write made no progress");
        offset += result.bytesWritten;
      }
    }
    await output.sync();
    const after = await input.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== before.size
    ) {
      throw new Error("Recovery source changed while being copied");
    }
    return {
      sha256: hash.digest("hex"),
      bytes,
      mode: Number(before.mode) & 0o777,
    };
  } finally {
    await output?.close();
    await input.close();
  }
}

/**
 * Storage only: callers must fence writers and inventory every durable store.
 * This module neither stops services nor restores live data. No global config,
 * server imports or database connection is required to inspect it offline.
 */
export class RecoveryStore {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<RecoveryStore> {
    if (!path.isAbsolute(root))
      throw new Error("Recovery root must be absolute");
    // Require an existing trusted parent; avoid recursively following planted paths.
    const parent = await realpath(path.dirname(root));
    const resolved = path.join(parent, path.basename(root));
    try {
      await privateDirectory(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await RecoveryStore.checkDirectory(resolved);
    const store = new RecoveryStore(resolved);
    for (const name of ["transactions", "points", "locks"]) {
      const directory = path.join(resolved, name);
      try {
        await privateDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await RecoveryStore.checkDirectory(directory);
    }
    return store;
  }

  private static async checkDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error(
        "Recovery directory must be private, user-owned and not a symlink"
      );
    }
  }

  private location(area: string, id: string): string {
    idSchema.parse(id);
    return path.join(this.root, area, id);
  }

  private async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const lock = this.location("locks", id);
    // No stale-lock takeover: a crashed writer must be inspected by the future
    // helper before this lock is cleared. Guessing from age/PID is unsafe.
    await privateDirectory(lock);
    try {
      return await run();
    } finally {
      await rm(lock, { recursive: true });
      await syncDirectory(path.dirname(lock));
    }
  }

  async begin(
    input: Pick<
      RecoveryTransaction,
      "instanceId" | "previous" | "target" | "wasRunning"
    >
  ): Promise<RecoveryTransaction> {
    const timestamp = new Date().toISOString();
    const record = transactionSchema.parse({
      instanceId: input.instanceId,
      previous: input.previous,
      target: input.target,
      wasRunning: input.wasRunning,
      formatVersion: 1,
      id: randomUUID(),
      phase: "preparing",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await writeDurable(
      this.location("transactions", record.id),
      JSON.stringify(record)
    );
    await syncDirectory(path.join(this.root, "transactions"));
    return record;
  }

  async read(id: string): Promise<RecoveryTransaction> {
    const record = transactionSchema.parse(
      JSON.parse(
        (await readPrivate(this.location("transactions", id))).toString("utf8")
      )
    );
    if (record.id !== id)
      throw new Error("Recovery transaction identity mismatch");
    return record;
  }

  /** Only the independent helper may reconcile a dead mutation writer, after
   * proving its instance-wide OS lease. Preserve lock evidence rather than
   * guessing from age or a reused PID. The server never calls this method. */
  async reconcileAbandonedMutationLock(
    id: string,
    assertExclusiveLease: () => Promise<void>
  ): Promise<void> {
    await assertExclusiveLease();
    await this.read(id);
    const lock = this.location("locks", id);
    try {
      await RecoveryStore.checkDirectory(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rename(lock, `${lock}.abandoned-${randomUUID()}`);
    await syncDirectory(path.dirname(lock));
  }

  private async save(record: RecoveryTransaction): Promise<void> {
    transactionSchema.parse(record);
    const destination = this.location("transactions", record.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeDurable(temporary, JSON.stringify(record));
      await rename(temporary, destination);
      await syncDirectory(path.dirname(destination));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Integrity is necessary but database restorability must also be proven. */
  async checkpoint(
    id: string,
    input: {
      files: Array<{ role: "runtime" | "database" | "state"; source: string }>;
      verifyDatabaseRestore: (input: {
        databaseFiles: string[];
        manifest: RecoveryManifest;
      }) => Promise<void>;
    }
  ): Promise<RecoveryManifest> {
    return this.locked(id, async () => {
      const transaction = await this.read(id);
      if (transaction.phase !== "preparing")
        throw new Error("Recovery checkpoint requires preparing phase");
      if (
        input.files.filter((file) => file.role === "runtime").length !== 1 ||
        !input.files.some((file) => file.role === "database")
      ) {
        throw new Error(
          "Recovery checkpoint requires one runtime and database files"
        );
      }
      const destination = this.location("points", id);
      // Fixed staging identity keeps interrupted/incomplete evidence. Never reuse
      // or remove it automatically, including on verification failure.
      const staging = `${destination}.incomplete`;
      await privateDirectory(staging);
      const files: RecoveryManifest["files"] = [];
      const sources = new Set<string>();
      for (const [slot, file] of input.files.entries()) {
        if (!path.isAbsolute(file.source))
          throw new Error("Recovery source must be absolute");
        const source = path.join(
          await realpath(path.dirname(file.source)),
          path.basename(file.source)
        );
        if (
          source === this.root ||
          source.startsWith(`${this.root}${path.sep}`) ||
          sources.has(source)
        ) {
          throw new Error(
            "Recovery sources must be unique and outside the recovery root"
          );
        }
        sources.add(source);
        const copied = await snapshotFile(
          source,
          path.join(staging, String(slot))
        );
        files.push({ slot, role: file.role, source, ...copied });
      }
      const manifest = manifestSchema.parse({
        formatVersion: 1,
        transactionId: id,
        instanceId: transaction.instanceId,
        createdAt: new Date().toISOString(),
        previous: transaction.previous,
        target: transaction.target,
        files,
      });
      // This initial adapter supports a single executable. A signed macOS
      // bundle inventory/identity adapter will be added with native integration.
      const runtimeFiles = files.filter((file) => file.role === "runtime");
      if (runtimeFiles[0].sha256 !== transaction.previous.sha256) {
        throw new Error("Previous runtime checksum does not match transaction");
      }
      await input.verifyDatabaseRestore({
        databaseFiles: files
          .filter((file) => file.role === "database")
          .map((file) => path.join(staging, String(file.slot))),
        manifest: structuredClone(manifest),
      });
      // The restore verifier must not mutate the immutable checkpoint inputs.
      await this.verifyFiles(staging, manifest);
      const bytes = JSON.stringify(manifest);
      await writeDurable(path.join(staging, "manifest.json"), bytes);
      await syncDirectory(staging);
      await rename(staging, destination);
      await syncDirectory(path.dirname(destination));
      await this.save({
        ...transaction,
        phase: "backed-up",
        manifestSha256: digest(Buffer.from(bytes)),
        updatedAt: new Date().toISOString(),
      });
      return manifest;
    });
  }

  private async verifyFiles(
    directory: string,
    manifest: RecoveryManifest
  ): Promise<void> {
    await RecoveryStore.checkDirectory(directory);
    const slots = new Set<number>();
    for (const file of manifest.files) {
      if (slots.has(file.slot)) throw new Error("Duplicate recovery file slot");
      slots.add(file.slot);
      const actual = await hashFile(path.join(directory, String(file.slot)));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) {
        throw new Error("Recovery file integrity check failed");
      }
    }
  }

  async verify(id: string): Promise<RecoveryManifest> {
    const transaction = await this.read(id);
    if (!transaction.manifestSha256)
      throw new Error("Recovery point has not been sealed");
    const directory = this.location("points", id);
    await RecoveryStore.checkDirectory(directory);
    const bytes = await readPrivate(path.join(directory, "manifest.json"));
    if (digest(bytes) !== transaction.manifestSha256)
      throw new Error("Recovery manifest integrity check failed");
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      manifest.transactionId !== id ||
      manifest.instanceId !== transaction.instanceId ||
      manifest.previous.sha256 !== transaction.previous.sha256 ||
      manifest.previous.version !== transaction.previous.version ||
      manifest.target.sha256 !== transaction.target.sha256 ||
      manifest.target.version !== transaction.target.version
    ) {
      throw new Error("Recovery point identity mismatch");
    }
    await this.verifyFiles(directory, manifest);
    return manifest;
  }

  /** Compare-and-set phase under a disk lock; committed data cannot auto-rewind. */
  async transition(
    id: string,
    expected: RecoveryPhase,
    next: RecoveryPhase,
    failureCode?: string
  ): Promise<RecoveryTransaction> {
    return this.locked(id, async () => {
      const record = await this.read(id);
      if (
        record.phase !== expected ||
        !transitions[expected]?.includes(next) ||
        next === "backed-up"
      ) {
        throw new Error("Invalid recovery phase transition");
      }
      if (
        [
          "activating",
          "probation",
          "committed",
          "restoring",
          "rolled-back",
        ].includes(next)
      )
        await this.verify(id);
      const updated = transactionSchema.parse({
        ...record,
        phase: next,
        updatedAt: new Date().toISOString(),
        ...(failureCode !== undefined ? { failureCode } : {}),
      });
      await this.save(updated);
      return updated;
    });
  }
}
