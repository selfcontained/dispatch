import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

import {
  type CrudToolCallbacks,
  registerCrudTools,
} from "../src/shared/mcp/crud-tools.js";

type RegisteredTool = {
  name: string;
  config: { inputSchema: z.ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function registerJobTools() {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"]
    ) => tools.push({ name, config, handler }),
  };
  const callbacks = {
    createJob: vi.fn(async () => ({ ok: true })),
    updateJob: vi.fn(async () => ({ ok: true })),
    getJobByName: vi.fn(async () => ({
      id: "job_1",
      name: "project-loop",
      continuationEnabled: true,
      maxIterations: 12,
      completionCriteria: ["Scope is complete", "Tests pass"],
      recoveryInstructions: null,
    })),
  } as unknown as CrudToolCallbacks;

  registerCrudTools(
    server as never,
    new Set(["get_job", "create_job", "update_job"]),
    {
      defaultCwd: "/repo",
      callbacks,
    }
  );
  return { tools, callbacks };
}

describe("job CRUD loop schema", () => {
  it("exposes user-facing loop fields instead of continuation internals", () => {
    const { tools } = registerJobTools();

    for (const name of ["create_job", "update_job"]) {
      const shape = tools.find((tool) => tool.name === name)!.config
        .inputSchema;
      expect(shape).toHaveProperty("loopEnabled");
      expect(shape).toHaveProperty("maxRuns");
      expect(shape).toHaveProperty("doneWhen");
      expect(shape).toHaveProperty("recoverySteps");
      expect(shape).not.toHaveProperty("continuationEnabled");
      expect(shape).not.toHaveProperty("completionCriteria");
    }
  });

  it("normalizes create_job checklist arrays to stored bullet prompts", async () => {
    const { tools, callbacks } = registerJobTools();
    const tool = tools.find((candidate) => candidate.name === "create_job")!;
    const args = z.object(tool.config.inputSchema).parse({
      name: "project-loop",
      directory: "/repo",
      loopEnabled: true,
      maxRuns: 12,
      doneWhen: ["All planned work is shipped", "Tests pass"],
      recoverySteps: null,
    });

    await tool.handler(args);

    expect(callbacks.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationEnabled: true,
        maxIterations: 12,
        completionCriteria: ["All planned work is shipped", "Tests pass"],
        recoveryInstructions: null,
      })
    );
  });

  it("preserves omitted update_job loop fields", async () => {
    const { tools, callbacks } = registerJobTools();
    const tool = tools.find((candidate) => candidate.name === "update_job")!;
    const args = z.object(tool.config.inputSchema).parse({
      name: "project-loop",
      directory: "/repo",
      doneWhen: ["Scope is complete"],
    });

    await tool.handler(args);

    expect(callbacks.updateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationEnabled: undefined,
        maxIterations: undefined,
        completionCriteria: ["Scope is complete"],
        recoveryInstructions: undefined,
      })
    );
  });

  it("returns get_job records using the same loop schema", async () => {
    const { tools } = registerJobTools();
    const tool = tools.find((candidate) => candidate.name === "get_job")!;
    const args = z.object(tool.config.inputSchema).parse({
      name: "project-loop",
      directory: "/repo",
    });

    const result = (await tool.handler(args)) as {
      content: Array<{ text: string }>;
    };
    const job = JSON.parse(result.content[0]!.text);

    expect(job).toMatchObject({
      loopEnabled: true,
      maxRuns: 12,
      doneWhen: ["Scope is complete", "Tests pass"],
      recoverySteps: [],
    });
    expect(job).not.toHaveProperty("continuationEnabled");
    expect(job).not.toHaveProperty("completionCriteria");
  });
});
