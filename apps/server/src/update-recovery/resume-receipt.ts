import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { uuid } from "./protocol.js";
import { readPrivate, writeAtomic, syncDirectory } from "./files.js";
const readPrivateFile = (file: string) =>
  readPrivate(file, { maxBytes: 64 * 1024 });
const resumeReceiptSchema = z
  .object({
    formatVersion: z.literal(1),
    transactionId: uuid,
    createdAt: z.string().datetime(),
    agents: z
      .array(
        z
          .object({
            id: z.string().regex(/^agt_[A-Za-z0-9_-]{1,64}$/),
            updatedAt: z.string().min(1).max(64),
          })
          .strict()
      )
      .max(10_000),
  })
  .strict();
export type ResumeReceipt = z.infer<typeof resumeReceiptSchema>;

export const RESUME_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Atomically replace the receipt: private temp file, fsync, rename, fsync dir. */
export async function writeResumeReceipt(
  file: string,
  receipt: ResumeReceipt
): Promise<void> {
  const body = JSON.stringify(resumeReceiptSchema.parse(receipt));
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(file, body);
}

export type TakenResumeReceipt =
  | { status: "none" }
  | { status: "rejected"; reason: "invalid" | "expired" | "unsafe" }
  | { status: "ok"; receipt: ResumeReceipt };

/**
 * Take the receipt at most once: it is removed (durably) before the caller
 * acts on it, so a crash mid-resume never resumes twice. Anything uncertain
 * is set aside as `<file>.rejected-<ms>` for inspection and resumes nothing.
 */
export async function takeResumeReceipt(
  file: string,
  options: { now?: number; maxAgeMs?: number } = {}
): Promise<TakenResumeReceipt> {
  const now = options.now ?? Date.now();
  let raw: string;
  try {
    raw = await readPrivateFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "none" };
    return setAside(file, now, "unsafe");
  }
  let parsed: ReturnType<typeof resumeReceiptSchema.safeParse>;
  try {
    parsed = resumeReceiptSchema.safeParse(JSON.parse(raw));
  } catch {
    return setAside(file, now, "invalid");
  }
  if (!parsed.success) return setAside(file, now, "invalid");
  const age = now - Date.parse(parsed.data.createdAt);
  if (!(age >= 0 && age <= (options.maxAgeMs ?? RESUME_RECEIPT_MAX_AGE_MS)))
    return setAside(file, now, "expired");
  await unlink(file);
  await syncDirectory(path.dirname(file));
  return { status: "ok", receipt: parsed.data };
}

async function setAside(
  file: string,
  now: number,
  reason: "invalid" | "expired" | "unsafe"
): Promise<TakenResumeReceipt> {
  // If even moving it fails, leave it; it keeps resuming nothing.
  await rename(file, `${file}.rejected-${now}`).catch(() => null);
  await syncDirectory(path.dirname(file)).catch(() => null);
  return { status: "rejected", reason };
}
