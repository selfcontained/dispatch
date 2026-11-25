import * as z from "zod/v4";

import type {
  EngineCapabilityOperation,
  EngineCapabilityResult,
} from "@dispatch/runner-protocol/engine-management";

const label = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N} ._'():+&\[\]-]+$/u);
const id = z.string().regex(/^[\w./:@+\[\]-]{1,160}$/);
const version = z
  .string()
  .regex(/^\d[\w.+-]{0,39}$/)
  .nullable();
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const account = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const catalog = z.object({
  defaultModel: id.nullable(),
  models: z
    .array(
      z.object({
        id,
        label,
        effort: z
          .array(
            z.object({
              value: id,
              name: label,
              description: z.string().optional(),
            })
          )
          .max(32)
          .optional(),
      })
    )
    .max(256),
});

const usage = z.object({
  checkedAt: timestamp,
  codexResetAccount: account.optional(),
  providers: z
    .array(
      z.object({
        engine: z.enum(["claude", "codex"]),
        plan: label.nullable().catch(null),
        observedAt: timestamp.nullable(),
        source: z.enum(["live", "local"]).optional(),
        windows: z
          .array(
            z.object({
              id: label,
              label,
              usedPercent: z.number().min(0).max(100),
              resetsAt: timestamp.nullable().catch(null),
            })
          )
          .max(32),
        spend: z
          .object({
            used: z.number().nonnegative(),
            limit: z.number().nonnegative(),
            currency: z.string().regex(/^[A-Z]{3}$/),
            enabled: z.boolean().optional(),
          })
          .optional()
          .catch(undefined),
        credits: z
          .object({
            balance: z.number().nullable(),
            unlimited: z.boolean(),
          })
          .optional(),
        limitResets: z
          .object({ available: count, applicable: count })
          .optional(),
        limitReached: z.boolean().optional(),
        unavailableReason: z
          .string()
          .max(200)
          .regex(/^[\p{L}\p{N} .'’_-]+$/u)
          .optional()
          .catch(undefined),
      })
    )
    .max(2),
});

const resultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("model_catalog"), catalog }),
  z.object({ type: z.literal("provider_usage"), usage }),
  z.object({
    type: z.literal("codex_reset"),
    code: z.enum(["ok", "nothing_to_reset", "no_credit", "unknown"]),
    windowsReset: count,
  }),
  z.object({
    type: z.literal("plugin_status"),
    status: z.object({
      installed: z.boolean(),
      enabled: z.boolean(),
      currentVersion: version.catch(null),
      latestVersion: version.catch(null),
      updateAvailable: z.boolean(),
      actions: z.array(z.enum(["install", "update"])).max(2),
    }),
  }),
]);

/** Pick only the published fields before data leaves the workload or reaches Dispatch. */
export function parseEngineCapabilityResult(
  operation: EngineCapabilityOperation,
  input: unknown
): EngineCapabilityResult | null {
  const result = resultSchema.safeParse(input);
  const expected = operation.type.startsWith("plugin_")
    ? "plugin_status"
    : operation.type;
  return result.success && result.data.type === expected ? result.data : null;
}
