import path from "node:path";
import * as z from "zod/v4";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
const absolutePath = z
  .string()
  .max(4096)
  .refine(path.isAbsolute)
  .refine((value) => path.resolve(value) === value);

export const RuntimeIdentitySchema = z.strictObject({
  agentId: id,
  sessionId: id,
  modelId: id,
  cwd: absolutePath,
  branch: id,
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  dirtyHash: hash,
  permissionsHash: hash,
  budgetProfileHash: hash,
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const BudgetSnapshotSchema = z.strictObject({
  version: z.literal(1),
  identity: RuntimeIdentitySchema,
  boundary: z.number().int().nonnegative(),
  observedAt: z.iso.datetime({ offset: true }),
  source: z.enum(["exact-render", "unknown"]),
  phase: z.enum(["before-compaction", "after-compaction"]),
  contextTokens: z.number().int().positive(),
  inputLimitTokens: z.number().int().positive().nullable(),
  renderedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().positive(),
  toolReserveTokens: z.number().int().nonnegative(),
  handoffReserveTokens: z.number().int().nonnegative(),
  // Cache reads are a subset of rendered input, never additional input.
  cachedInputTokens: z.number().int().nonnegative(),
  tokenizerHash: hash,
  templateHash: hash,
  counted: z.strictObject({
    system: z.boolean(),
    schemas: z.boolean(),
    history: z.boolean(),
    tools: z.boolean(),
    images: z.boolean(),
  }),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;

export const HandoffSchema = z.strictObject({
  version: z.literal(1),
  uri: absolutePath,
  sha256: hash,
  objectiveHash: hash,
  authorizationRefs: z.array(id).min(1).max(20),
  pendingPermissionsHash: hash,
  identity: RuntimeIdentitySchema,
  artifacts: z
    .array(z.strictObject({ uri: absolutePath, sha256: hash }))
    .max(50),
});
export const TransferRequestSchema = z.strictObject({
  version: z.literal(1),
  chainId: id,
  budget: BudgetSnapshotSchema,
  handoff: HandoffSchema,
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;
export type TransferState =
  | "prepared"
  | "launch_reserved"
  | "receipt_recorded"
  | "pickup_verified"
  | "cancelled"
  | "failed";
export interface TransferRecord {
  transferId: string;
  request: TransferRequest;
  requestHash: string;
  state: TransferState;
  revision: number;
  launchKey: string;
  successorAgentId: string | null;
  failureReason: string | null;
}

export class TransferConflict extends Error {}
