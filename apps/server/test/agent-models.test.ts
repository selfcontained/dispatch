import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_OPTIONS,
  describeAgentModelCatalog,
  validateAgentModel,
} from "../src/shared/agent-models.js";
import { CLI_AGENT_TYPES, type AgentType } from "../src/shared/agent-types.js";

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

describe("describeAgentModelCatalog", () => {
  it("lists every catalog ID grouped by its agent type", () => {
    const description = describeAgentModelCatalog();

    for (const agentType of CLI_AGENT_TYPES) {
      const options = AGENT_MODEL_OPTIONS[agentType] ?? [];
      if (options.length === 0) continue;
      expect(description).toContain(`${agentType}:`);
      for (const { id } of options) {
        expect(description).toContain(id);
      }
    }
  });

  it("calls out agent types that take no model override", () => {
    const description = describeAgentModelCatalog();
    const withoutModels = CLI_AGENT_TYPES.filter(
      (agentType) => (AGENT_MODEL_OPTIONS[agentType] ?? []).length === 0
    );

    for (const agentType of withoutModels) {
      expect(description).toContain(agentType);
    }
    expect(description).toContain("no model override");
  });
});
