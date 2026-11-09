import { budgetProfileHash } from "../../src/agents/context-transfer/budget.js";
import type { TransferRequest } from "../../src/agents/context-transfer/types.js";

export const now = Date.parse("2026-01-01T00:00:00Z");
export function transferFixture(): TransferRequest {
  const identity = {
    agentId: "predecessor",
    sessionId: "native-session",
    modelId: "test-model",
    cwd: "/synthetic/worktree",
    branch: "work/task",
    head: "a".repeat(40),
    dirtyHash: "b".repeat(64),
    permissionsHash: "c".repeat(64),
    budgetProfileHash: "0".repeat(64),
  };
  const request: TransferRequest = {
    version: 1,
    chainId: "task-chain",
    budget: {
      version: 1,
      identity,
      boundary: 7,
      observedAt: new Date(now).toISOString(),
      source: "exact-render",
      phase: "after-compaction",
      contextTokens: 32768,
      inputLimitTokens: null,
      renderedInputTokens: 24577,
      outputTokens: 4096,
      toolReserveTokens: 2048,
      handoffReserveTokens: 2048,
      cachedInputTokens: 24000,
      tokenizerHash: "d".repeat(64),
      templateHash: "e".repeat(64),
      counted: {
        system: true,
        schemas: true,
        history: true,
        tools: true,
        images: true,
      },
    },
    handoff: {
      version: 1,
      uri: "/private/synthetic-handoff.json",
      sha256: "f".repeat(64),
      objectiveHash: "1".repeat(64),
      authorizationRefs: ["original-user-message"],
      pendingPermissionsHash: "2".repeat(64),
      identity,
      artifacts: [
        { uri: "/private/synthetic-tests.json", sha256: "3".repeat(64) },
      ],
    },
  };
  identity.budgetProfileHash = budgetProfileHash(request.budget);
  return request;
}
