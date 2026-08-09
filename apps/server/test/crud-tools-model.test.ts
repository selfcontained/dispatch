import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

import {
  type CrudToolCallbacks,
  registerCrudTools,
} from "../src/shared/mcp/crud-tools.js";

type RegisteredCall = {
  name: string;
  config: {
    inputSchema: z.ZodRawShape & Record<string, { description?: string }>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

const MODEL_TOOLS = [
  "create_job",
  "update_job",
  "create_template",
  "update_template",
] as const;

function createMockServer() {
  const tools: RegisteredCall[] = [];
  return {
    registerTool: vi.fn(
      (
        name: string,
        config: RegisteredCall["config"],
        handler: RegisteredCall["handler"]
      ) => {
        tools.push({ name, config, handler });
      }
    ),
    tools,
  };
}

function registerAll() {
  const server = createMockServer();
  const callbacks = Object.fromEntries(
    [
      "listJobs",
      "getJobById",
      "getJobByName",
      "createJob",
      "updateJob",
      "deleteJob",
      "runJob",
      "listTemplates",
      "getTemplateById",
      "getTemplateByName",
      "createTemplate",
      "updateTemplate",
      "deleteTemplate",
    ].map((name) => [name, vi.fn(async () => ({ ok: true }))])
  ) as unknown as CrudToolCallbacks;

  registerCrudTools(server as never, new Set(MODEL_TOOLS), {
    defaultCwd: "/repo",
    callbacks,
  });

  return { server, callbacks };
}

describe("crud tools model parameter", () => {
  it("exposes model on job and template create/update tools", () => {
    const { server } = registerAll();

    for (const name of MODEL_TOOLS) {
      const tool = server.tools.find((t) => t.name === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      const description = tool!.config.inputSchema.model?.description;
      expect(description, `${name} should accept model`).toBeDefined();
      // The catalog itself, so agents can pick a valid id without a lookup.
      expect(description).toContain("opus");
      expect(description).toContain("gpt-5.5");
    }
  });

  it("names terminal as unsupported on template tools only", () => {
    const { server } = registerAll();
    const describeModel = (name: string) =>
      server.tools.find((t) => t.name === name)!.config.inputSchema.model
        ?.description ?? "";

    // Template tools accept agentType terminal, which has no catalog entry —
    // saying so in the schema beats a runtime "not supported" error.
    expect(describeModel("create_template")).toContain("terminal");
    expect(describeModel("update_template")).toContain("terminal");
    // Jobs cannot be terminal, so naming it there would only confuse.
    expect(describeModel("create_job")).not.toContain("terminal");
    expect(describeModel("update_job")).not.toContain("terminal");
  });

  it("documents null-clearing only on the update tools", () => {
    const { server } = registerAll();
    const describeModel = (name: string) =>
      server.tools.find((t) => t.name === name)!.config.inputSchema.model
        ?.description ?? "";

    expect(describeModel("update_job")).toContain("Pass null to clear");
    expect(describeModel("update_template")).toContain("Pass null to clear");
    expect(describeModel("create_job")).not.toContain("Pass null to clear");
    expect(describeModel("create_template")).not.toContain(
      "Pass null to clear"
    );
  });

  it("round-trips null as null and omits an unset model", () => {
    const { server } = registerAll();
    // Parse through the registered shape, not just the handler — the services
    // read null as "clear" and undefined as "leave alone", so a schema change
    // that collapsed omitted into null would silently wipe stored models.
    const parse = (name: string, args: Record<string, unknown>) =>
      z
        .object(server.tools.find((t) => t.name === name)!.config.inputSchema)
        .parse(args) as Record<string, unknown>;

    expect("model" in parse("update_job", { name: "nightly" })).toBe(false);
    expect(
      parse("update_job", { name: "nightly", model: null }).model
    ).toBeNull();
    expect("model" in parse("update_template", { templateId: "tpl_1" })).toBe(
      false
    );
    expect(
      parse("update_template", { templateId: "tpl_1", model: null }).model
    ).toBeNull();
    // agentType defaults before validation, so a bare codex id gets rejected
    // downstream rather than stored against claude.
    expect(
      parse("create_job", { name: "nightly", model: "gpt-5.5" })
    ).toMatchObject({ agentType: "claude", model: "gpt-5.5" });
  });

  it("passes model through to the job and template callbacks", async () => {
    const { server, callbacks } = registerAll();
    const call = (name: string, args: Record<string, unknown>) =>
      server.tools.find((t) => t.name === name)!.handler(args);

    await call("create_job", { name: "nightly", model: "opus" });
    expect(callbacks.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/repo", model: "opus" })
    );

    await call("update_job", { name: "nightly", model: null });
    expect(callbacks.updateJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: null })
    );

    await call("create_template", { name: "review", model: "sonnet" });
    expect(callbacks.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sonnet" })
    );

    await call("update_template", { templateId: "tpl_1", model: null });
    expect(callbacks.updateTemplate).toHaveBeenCalledWith(
      "tpl_1",
      expect.objectContaining({ model: null })
    );
  });
});
