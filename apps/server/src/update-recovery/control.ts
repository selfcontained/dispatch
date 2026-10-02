import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  probationSchema,
  safeEqual,
  type ProbationConfig,
} from "./protocol.js";
import { readPrivate } from "./files.js";
const readPrivateFile = (file: string) =>
  readPrivate(file, { maxBytes: 64 * 1024 });
/** Real path of the nearest existing ancestor, with the missing tail appended. */
async function resolveExisting(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveStatePaths(paths: string[]): Promise<string[]> {
  const resolved = new Set<string>();
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate))
      throw new Error("state path must be absolute");
    resolved.add(await resolveExisting(candidate));
  }
  const sorted = [...resolved].sort();
  return sorted.filter(
    (entry) =>
      !sorted.some(
        (other) => other !== entry && entry.startsWith(other + path.sep)
      )
  );
}

/** The enrollment key, or null when absent or unsafe. Read per request. */
export async function readRecoveryKey(file: string): Promise<Buffer | null> {
  try {
    const value = (await readPrivateFile(file)).trim();
    return /^[a-f0-9]{64,256}$/.test(value) ? Buffer.from(value, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Probation comes from env (`DISPATCH_RECOVERY_*`) or a private control file
 * (needed where the supervisor's environment is fixed, and so a crash restart
 * stays in probation). Anything partial, malformed or contradictory throws:
 * the caller must not touch the database.
 */
export async function loadProbationConfig(input: {
  env: NodeJS.ProcessEnv;
  controlFile: string;
  version: string;
}): Promise<ProbationConfig | null> {
  const { env } = input;
  const set = (key: string) => (env[key] ? env[key] : undefined);
  const keys = [
    "DISPATCH_RECOVERY_PROBATION",
    "DISPATCH_RECOVERY_TRANSACTION_ID",
    "DISPATCH_RECOVERY_TRANSACTION",
    "DISPATCH_RECOVERY_NONCE",
    "DISPATCH_RECOVERY_INSTANCE_ID",
    "DISPATCH_RECOVERY_EXPECTED_VERSION",
  ];
  let fromEnv: ProbationConfig | null = null;
  // Empty values mean "not in probation" (a rewritten EnvironmentFile).
  if (keys.some((key) => set(key) !== undefined)) {
    if (env.DISPATCH_RECOVERY_PROBATION !== "1")
      throw new Error("Recovery probation environment is incomplete");
    const transactionId =
      set("DISPATCH_RECOVERY_TRANSACTION_ID") ??
      set("DISPATCH_RECOVERY_TRANSACTION");
    if (
      set("DISPATCH_RECOVERY_TRANSACTION_ID") &&
      set("DISPATCH_RECOVERY_TRANSACTION") &&
      set("DISPATCH_RECOVERY_TRANSACTION_ID") !==
        set("DISPATCH_RECOVERY_TRANSACTION")
    )
      throw new Error("Recovery probation environment is invalid");
    const parsed = probationSchema.safeParse({
      formatVersion: 1,
      transactionId,
      nonce: set("DISPATCH_RECOVERY_NONCE"),
      instanceId:
        set("DISPATCH_RECOVERY_INSTANCE_ID") ??
        set("DISPATCH_INSTANCE_ID") ??
        set("DISPATCH_MAC_INSTANCE_ID"),
      expectedVersion: set("DISPATCH_RECOVERY_EXPECTED_VERSION"),
    });
    if (!parsed.success)
      throw new Error("Recovery probation environment is invalid");
    fromEnv = withoutFormat(parsed.data);
  }

  let fromFile: ProbationConfig | null = null;
  let raw: string | null = null;
  try {
    raw = await readPrivateFile(input.controlFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Recovery probation control file is unsafe");
  }
  if (raw !== null) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("Recovery probation control file is invalid");
    }
    const parsed = probationSchema.safeParse(json);
    if (!parsed.success)
      throw new Error("Recovery probation control file is invalid");
    fromFile = withoutFormat(parsed.data);
  }

  if (fromEnv && fromFile && !sameProbation(fromEnv, fromFile))
    throw new Error("Recovery probation environment and control file differ");
  const config = fromEnv ?? fromFile;
  if (!config) return null;
  if (
    config.expectedVersion !== undefined &&
    !sameVersion(config.expectedVersion, input.version)
  )
    throw new Error("Recovery probation expects a different version");
  const macId = env.DISPATCH_MAC_INSTANCE_ID;
  if (macId && config.instanceId !== macId)
    throw new Error("Recovery probation expects a different instance");
  return config;
}

function withoutFormat(
  value: z.infer<typeof probationSchema>
): ProbationConfig {
  const { formatVersion: _, ...rest } = value;
  return rest;
}

/** Release tags carry a leading "v"; package versions do not. */
export function sameVersion(a: string, b: string): boolean {
  return a.replace(/^v/, "") === b.replace(/^v/, "");
}

function sameProbation(a: ProbationConfig, b: ProbationConfig): boolean {
  return (
    a.transactionId === b.transactionId &&
    safeEqual(a.nonce, b.nonce) &&
    a.instanceId === b.instanceId &&
    a.expectedVersion === b.expectedVersion
  );
}
