import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod/v4";
import { getSetting } from "../db/settings.js";
import { tokensEqual } from "../auth.js";

const credential = z.object({
  id: z.string().min(1).max(80),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectIds: z.array(z.string().min(1).max(100)).max(100),
  expiresAt: z.iso.datetime(),
  revoked: z.boolean(),
});
const credentials = z.array(credential).max(8);
export type PortfolioGrant = z.infer<typeof credential>;

export function isPortfolioAuthorization(header: string | undefined): boolean {
  return /^Bearer\s+dpr_/i.test(header ?? "");
}

/** No cache: removing/revoking a grant or narrowing its allowlist affects every page. */
export async function portfolioGrant(pool: Pool, header?: string) {
  if (!header || !/^Bearer dpr_[a-f0-9]{64}$/.test(header)) return null;
  const value = await getSetting(pool, "portfolio_readers_v1");
  let parsed;
  try {
    parsed = credentials.safeParse(JSON.parse(value ?? "null"));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const hash = createHash("sha256").update(header.slice(7)).digest("hex");
  return (
    parsed.data.find(
      (grant) =>
        tokensEqual(hash, grant.sha256) &&
        !grant.revoked &&
        Date.parse(grant.expiresAt) > Date.now()
    ) ?? null
  );
}
