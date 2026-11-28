import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";

import {
  readPrivate,
  syncDirectory,
  writeAtomic,
} from "../../update-recovery/files.js";

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * One private JSON file of Dispatch's runner update state, replaced
 * atomically. A file that cannot be trusted or parsed is set aside for
 * inspection and reads as absent.
 */
export function privateStateFile<Schema extends z.ZodTypeAny>(options: {
  file: string;
  schema: Schema;
  unreadable: string;
  recoverRejected?: (value: z.infer<Schema>) => boolean;
  logger?: Pick<FastifyBaseLogger, "warn">;
}) {
  const { file, schema } = options;
  const directory = path.dirname(file);
  const parse = async (name: string): Promise<z.infer<Schema>> =>
    schema.parse(JSON.parse(await readPrivate(name, { maxBytes: MAX_BYTES })));

  async function recover() {
    if (!options.recoverRejected) return undefined;
    const prefix = `${path.basename(file)}.rejected-`;
    const newest = (await readdir(directory).catch(() => []))
      .filter(
        (name) =>
          name.startsWith(prefix) && /^\d{13}$/.test(name.slice(prefix.length))
      )
      .sort()
      .at(-1);
    if (!newest) return undefined;
    const rejected = path.join(directory, newest);
    try {
      const value = await parse(rejected);
      if (options.recoverRejected(value)) {
        // Move, rather than copy, so later boots see only the canonical file.
        await rename(rejected, file);
        await syncDirectory(directory);
        options.logger?.warn(
          { file, rejected },
          "Recovered runner update state"
        );
        return value;
      }
    } catch {
      // Its format is unknown, or its integrity cannot be established.
    }
    options.logger?.warn(
      { file, rejected },
      "Runner update receipts unavailable; normal agent reconciliation applies"
    );
    return undefined;
  }

  return {
    async read(): Promise<z.infer<Schema> | undefined> {
      try {
        return await parse(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return recover();
        options.logger?.warn({ err: error, file }, options.unreadable);
        await rename(file, `${file}.rejected-${Date.now()}`).catch(() => null);
        await syncDirectory(path.dirname(file)).catch(() => null);
        return undefined;
      }
    },
    async write(value: z.infer<Schema>): Promise<void> {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeAtomic(file, JSON.stringify(schema.parse(value)));
    },
  };
}
