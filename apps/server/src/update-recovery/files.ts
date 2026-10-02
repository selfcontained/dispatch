import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RecoveryManifest } from "./store.js";

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeAtomic(
  file: string,
  content: string
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
export async function readPrivate(
  file: string,
  options: { maxBytes?: number } = {}
): Promise<string> {
  if (!path.isAbsolute(file))
    throw new Error("Recovery control path must be absolute");
  const before = await lstat(file);
  if (!before.isFile())
    throw new Error("Recovery control must be a regular file");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Recovery control must be private and user-owned");
    if (stat.size > (options.maxBytes ?? 16 * 1024 * 1024))
      throw new Error("Recovery control exceeds size limit");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function hashRegular(file: string): Promise<string> {
  if (!(await lstat(file)).isFile())
    throw new Error("Recovery artifact must be regular");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Recovery artifact must be regular");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

const inventorySchema = z
  .object({
    version: z.literal(1),
    roots: z
      .array(
        z
          .object({
            path: z.string().refine(path.isAbsolute),
            present: z.boolean(),
            directories: z.array(
              z.object({
                relative: z.string(),
                mode: z.number().int().min(0).max(0o777),
              })
            ),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
export type StateInventory = z.infer<typeof inventorySchema>;

/** Called only after every Dispatch writer and host has stopped. Explicit roots
 * prevent traversing repositories, recovery storage, or unowned linked data. */
export async function inventoryState(
  roots: string[],
  excluded: string[] = []
): Promise<{
  inventory: StateInventory;
  files: Array<{ role: "state"; source: string }>;
}> {
  const files: Array<{ role: "state"; source: string }> = [];
  const inventory: StateInventory = { version: 1, roots: [] };
  const normalized = roots.map((root) => path.resolve(root));
  if (
    normalized.some((root, i) =>
      normalized.some(
        (other, j) =>
          i !== j && (root === other || root.startsWith(`${other}${path.sep}`))
      )
    )
  )
    throw new Error("Recovery state roots must not overlap");
  const excludedSet = new Set(excluded.map((file) => path.resolve(file)));
  for (const root of normalized) {
    const parent = await realpath(path.dirname(root));
    if (parent !== path.dirname(root))
      throw new Error("Recovery state parent must not be linked");
    const entry: StateInventory["roots"][number] = {
      path: root,
      present: false,
      directories: [],
    };
    inventory.roots.push(entry);
    const stat = await lstat(root).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    entry.present = true;
    async function walk(directory: string): Promise<void> {
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error(
          "Recovery state must be an owned directory without links"
        );
      entry.directories.push({
        relative: path.relative(root, directory),
        mode: stat.mode & 0o777,
      });
      for (const name of (await readdir(directory)).sort()) {
        const source = path.join(directory, name);
        if (excludedSet.has(source)) continue;
        const stat = await lstat(source);
        if (stat.isDirectory()) await walk(source);
        else if (
          stat.isFile() &&
          (!process.getuid || stat.uid === process.getuid())
        )
          files.push({ role: "state", source });
        else throw new Error("Recovery state contains linked or special files");
      }
    }
    await walk(root);
  }
  return { inventory, files };
}

/** Restore via separately built directories; retry markers are durable renames.
 * The first failed tree is preserved and never replaced by a subsequent retry. */
export async function restoreState(input: {
  inventory: StateInventory;
  manifest: RecoveryManifest;
  pointDirectory: string;
  transactionId: string;
}): Promise<void> {
  const inventory = inventorySchema.parse(input.inventory);
  if (!/^[a-f0-9-]{36}$/.test(input.transactionId))
    throw new Error("Invalid recovery identity");
  for (const root of inventory.roots) {
    if ((await realpath(path.dirname(root.path))) !== path.dirname(root.path))
      throw new Error("Recovery state parent must not be linked");
    const staging = `${root.path}.restore-${input.transactionId}-${randomUUID()}`;
    const failed = `${root.path}.failed-${input.transactionId}`;
    const completed = `${root.path}.restored-${input.transactionId}`;
    const marker = await lstat(completed).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (marker) {
      if (!marker.isFile()) throw new Error("Invalid restore marker");
      if (
        JSON.parse(await readPrivate(completed)).transactionId !==
        input.transactionId
      )
        throw new Error("Restore marker identity mismatch");
      continue;
    }
    await mkdir(staging, { mode: 0o700, recursive: false });
    if (!(await lstat(staging)).isDirectory())
      throw new Error("Invalid restore staging directory");
    for (const directory of root.directories) {
      const destination = path.resolve(staging, directory.relative);
      if (
        destination !== staging &&
        !destination.startsWith(`${staging}${path.sep}`)
      )
        throw new Error("Invalid recovery directory path");
      await mkdir(destination, { mode: 0o700, recursive: true });
    }
    for (const file of input.manifest.files.filter(
      (file) =>
        file.role === "state" &&
        file.source.startsWith(`${root.path}${path.sep}`)
    )) {
      const destination = path.join(
        staging,
        path.relative(root.path, file.source)
      );
      await copyFile(
        path.join(input.pointDirectory, String(file.slot)),
        destination
      );
      await chmod(destination, file.mode);
      const handle = await open(destination, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    // Apply directory modes last, after files are copied.
    for (const directory of [...root.directories].reverse()) {
      const destination = path.resolve(staging, directory.relative);
      await chmod(destination, directory.mode);
      await syncDirectory(destination);
    }
    if (
      !(await lstat(failed).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }))
    ) {
      await rename(root.path, failed).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await syncDirectory(path.dirname(root.path));
    }
    // A crash after install but before the marker leaves both failed and live.
    // Rename-over-nonempty must fail rather than destroy either copy. Detect
    // the installed snapshot by comparing each expected file before sealing.
    const live = await lstat(root.path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!live && root.present) await rename(staging, root.path);
    else if (live) {
      if (!live.isDirectory() || !root.present)
        throw new Error("Unexpected state during restore retry");
      for (const file of input.manifest.files.filter(
        (file) =>
          file.role === "state" &&
          file.source.startsWith(`${root.path}${path.sep}`)
      )) {
        if ((await hashRegular(file.source)) !== file.sha256)
          throw new Error("Restore retry found unexpected live data");
      }
    }
    await syncDirectory(path.dirname(root.path));
    await writeAtomic(
      completed,
      JSON.stringify({ transactionId: input.transactionId })
    );
  }
}
