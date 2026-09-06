import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_OPTIONS,
  applyAgentConfigDefaults,
  describeAgentModelCatalog,
  resolveAgentModelForUpdate,
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

  it("carries a label's qualifier so risky ids are not shown as equals", () => {
    const description = describeAgentModelCatalog(["codex"]);

    for (const option of AGENT_MODEL_OPTIONS.codex ?? []) {
      const qualifier = /\(([^)]*)\)\s*$/.exec(option.label)?.[1];
      expect(description).toContain(
        qualifier ? `${option.id} (${qualifier})` : option.id
      );
    }
  });

  it("describes only the agent types the caller accepts", () => {
    // Template tools also accept terminal, which has no catalog entry.
    const description = describeAgentModelCatalog(["claude", "terminal"]);

    expect(description).toContain("claude: opus");
    expect(description).toContain(
      "terminal accepts no model override — omit model for that."
    );
    expect(description).not.toContain("codex");
  });

  it("returns only the unsupported clause when nothing has a catalog", () => {
    expect(describeAgentModelCatalog(["cursor", "opencode", "terminal"])).toBe(
      "cursor, opencode, and terminal accept no model override — omit model for those."
    );
  });
});

describe("applyAgentConfigDefaults", () => {
  it("falls back to claude and the stored flag defaults", () => {
    expect(applyAgentConfigDefaults({})).toEqual({
      agentType: "claude",
      model: null,
      useWorktree: false,
      baseBranch: null,
      branchName: null,
      fullAccess: false,
    });
  });

  it("keeps supplied values and validates the model against the agent type", () => {
    expect(
      applyAgentConfigDefaults({
        agentType: "codex",
        model: " gpt-5.5 ",
        useWorktree: true,
        baseBranch: "main",
        branchName: "feature",
        fullAccess: true,
      })
    ).toEqual({
      agentType: "codex",
      model: "gpt-5.5",
      useWorktree: true,
      baseBranch: "main",
      branchName: "feature",
      fullAccess: true,
    });
  });

  it("rejects a model the resolved agent type does not offer", () => {
    expect(() => applyAgentConfigDefaults({ model: "gpt-5.5" })).toThrow(
      /not supported for claude/
    );
  });
});

describe("resolveAgentModelForUpdate", () => {
  it("keeps the existing model when neither field is supplied", () => {
    expect(
      resolveAgentModelForUpdate({
        inputAgentType: undefined,
        inputModel: undefined,
        existingAgentType: "claude",
        existingModel: "opus",
      })
    ).toBe("opus");
  });

  it("validates an explicitly supplied model against the next agent type", () => {
    expect(
      resolveAgentModelForUpdate({
        inputAgentType: "codex",
        inputModel: "gpt-5.5",
        existingAgentType: "claude",
        existingModel: "opus",
      })
    ).toBe("gpt-5.5");
  });

  it("clears the model when the payload passes null", () => {
    expect(
      resolveAgentModelForUpdate({
        inputAgentType: undefined,
        inputModel: null,
        existingAgentType: "claude",
        existingModel: "opus",
      })
    ).toBeNull();
  });

  it("drops a stored model the new agent type no longer offers", () => {
    expect(
      resolveAgentModelForUpdate({
        inputAgentType: "codex",
        inputModel: undefined,
        existingAgentType: "claude",
        existingModel: "opus",
      })
    ).toBeNull();
  });

  it("keeps a stored model the new agent type still offers", () => {
    expect(
      resolveAgentModelForUpdate({
        inputAgentType: "claude",
        inputModel: undefined,
        existingAgentType: "claude",
        existingModel: "opus",
      })
    ).toBe("opus");
  });
});

describe("dispatch catalog", () => {
  it("lists provider-qualified ids for dispatch", () => {
    const ids = (AGENT_MODEL_OPTIONS.dispatch ?? []).map((o) => o.id);
    expect(ids).toContain("deepseek-official/deepseek-v4-flash");
    expect(ids).toContain("openai/gpt-5.6-sol");
    expect(ids).not.toContain("openai/gpt-5.2");
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });
});
