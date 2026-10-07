import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export const RECOVERY_PROTOCOL = "dispatch-recovery-v1";
export const RECOVERY_ROUTE_PREFIX = "/api/v1/system/update-recovery/";
export const RECOVERY_EXIT_CODE = 75;

export const MAX_LEASE_MS = 600_000;

export const uuid = z.string().uuid();
export const hexToken = z.string().regex(/^[a-f0-9]{32,128}$/);
// Helpers mint either a random UUID or 16+ random bytes as hex.
export const nonceSchema = z.union([uuid, hexToken]);
export const probationSchema = z
  .object({
    formatVersion: z.literal(1),
    transactionId: uuid,
    nonce: nonceSchema,
    instanceId: z.string().min(1).max(200),
    // Optional: when present, a different binary refuses to start at all.
    expectedVersion: z.string().min(1).max(100).optional(),
  })
  .strict();
export type ProbationConfig = Omit<
  z.infer<typeof probationSchema>,
  "formatVersion"
>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * HMAC the helper recomputes. `secret` fields (the nonce) are bound into the
 * MAC but never sent back.
 */
export function recoveryProof(
  key: Buffer,
  route: string,
  challenge: string,
  body: Record<string, unknown>,
  secret: Record<string, string> = {}
): string {
  return createHmac("sha256", key)
    .update(
      `${RECOVERY_PROTOCOL}\n${route}\n${challenge}\n${canonicalJson(body)}\n${canonicalJson(secret)}`
    )
    .digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export const challengeSchema = hexToken;
export const fenceBody = z
  .object({
    transactionId: uuid,
    challenge: challengeSchema,
    leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
  })
  .strict();
export const abortBody = z
  .object({ transactionId: uuid, challenge: challengeSchema })
  .strict();
export const readinessBody = z
  .object({
    transactionId: uuid,
    nonce: nonceSchema,
    instanceId: z.string().min(1).max(200),
    expectedVersion: z.string().min(1).max(100),
    challenge: challengeSchema,
  })
  .strict();
