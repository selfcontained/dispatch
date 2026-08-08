import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_OPTIONS,
  validateAgentModel,
} from "../src/shared/agent-models.js";
import type { AgentType } from "../src/shared/agent-types.js";

describe("validateAgentModel", () => {
  it("accepts every ID in the configured catalog", () => {
    for (const [agentType, options] of Object.entries(AGENT_MODEL_OPTIONS)) {
      for (const { id } of options ?? []) {
        expect(validateAgentModel(agentType as AgentType, ` ${id} `)).toBe(id);
      }
    }
  });

  it("omits an empty model and rejects IDs outside the catalog", () => {
    expect(validateAgentModel("claude", "   ")).toBeUndefined();
    expect(() => validateAgentModel("claude", "not-a-real-model")).toThrow(
      "not supported for claude"
    );
  });
});
