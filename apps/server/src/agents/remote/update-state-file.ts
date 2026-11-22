import { mkdir, rename } from "node:fs/promises";
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
  logger?: Pick<FastifyBaseLogger, "warn">;
}) {
  const { file, schema } = options;
  return {
    async read(): Promise<z.infer<Schema> | undefined> {
      try {
        const raw = await readPrivate(file, { maxBytes: MAX_BYTES });
        return schema.parse(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
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
