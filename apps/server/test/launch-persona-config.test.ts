import { personaCatalog } from "../src/personas/catalog.js";
import { randomUUID } from "node:crypto";
import type { AgentManager } from "../src/agents/manager.js";
import { JobStore } from "../src/jobs/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";
import { TemplateService } from "../src/templates/service.js";
import { JobService } from "../src/jobs/service.js";
import { upsertPersona } from "../src/personas/authoring.js";

let pool: Pool;
let directory: string;
const manager = {
  createAgent: vi.fn<AgentManager["createAgent"]>(async (_input, options) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO agents (id, name, type, status, cwd, agent_args, full_access) VALUES ($1, $1, 'claude', 'running', $2, '[]'::jsonb, false)",
      [id, directory]
    );
    await options?.beforeLaunch?.(id);
    return { id } as Awaited<ReturnType<AgentManager["createAgent"]>>;
  }),
  getAgent: vi.fn(async () => ({ status: "running" })),
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let templates: TemplateService;
let jobs: JobService;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  directory = await mkdtemp(path.join(os.tmpdir(), "dispatch-persona-config-"));
  await upsertPersona({
    root: directory,
    slug: "builder",
    type: "task",
    name: "Builder",
    description: "Build tasks",
    instructions: "Implement and verify the requested task.",
  });
  templates = new TemplateService(pool, manager as never, logger as never);
  jobs = new JobService(
    pool,
    manager as never,
    logger as never,
    { agentRuntime: "inert" } as never
  );
});
afterAll(async () => {
  await jobs?.shutdown();
  await teardownTestDb();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("saved launch personas", () => {
  it("validates job/template creation and updates against the catalog, not local-only personas", async () => {
    const catalog = vi.spyOn(personaCatalog, "get").mockResolvedValue({
      personas: [
        {
          slug: "remote-builder",
          name: "Remote Builder",
          type: "task",
          description: "",
          body: "Remote instructions",
        },
      ],
      warnings: [],
      refreshing: false,
      updatedAt: Date.now(),
    });
    try {
      // builder.md exists locally, but has not been merged into the catalog.
      await expect(
        templates.addTemplate({
          name: "Local only",
          directory,
          persona: "builder",
        })
      ).rejects.toThrow('Persona "builder" not found');
      const template = await templates.addTemplate({
        name: "Remote template",
        directory,
        persona: "remote-builder",
      });
      await expect(
        templates.updateTemplate(template.id, { persona: "builder" })
      ).rejects.toThrow('Persona "builder" not found');
      expect((await templates.getTemplate(template.id))?.persona).toBe(
        "remote-builder"
      );
      await expect(
        jobs.addJob({
          name: "local-only-job",
          directory,
          prompt: "Build",
          persona: "builder",
          enabled: false,
        })
      ).rejects.toThrow('Persona "builder" not found');
      const job = await jobs.addJob({
        name: "remote-catalog-job",
        directory,
        prompt: "Build",
        persona: "remote-builder",
        enabled: false,
      });
      await expect(
        jobs.updateJob({ jobId: job.id, persona: "builder" })
      ).rejects.toThrow('Persona "builder" not found');
      expect(
        (await jobs.listJobs()).find((j) => j.id === job.id)?.persona
      ).toBe("remote-builder");
    } finally {
      catalog.mockRestore();
    }
  });

  it("persists, applies, preserves on unrelated edits, and clears a template persona", async () => {
    const template = await templates.addTemplate({
      name: "Build",
      directory,
      prompt: "Build it",
      persona: "builder",
    });
    expect((await templates.getTemplate(template.id))?.persona).toBe("builder");
    await templates.updateTemplate(template.id, {
      description: "New description",
    });
    await templates.launchTemplate({ templateId: template.id });
    expect(manager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ persona: "builder", initialPrompt: "Build it" })
    );
    await templates.updateTemplate(template.id, { persona: null });
    expect((await templates.getTemplate(template.id))?.persona).toBeNull();
    await expect(
      templates.updateTemplate(template.id, { persona: "code-review" })
    ).rejects.toThrow("not available");
  });

  it("keeps job and backing template selections in sync, including clearing", async () => {
    const job = await jobs.addJob({
      name: "Maintain",
      directory,
      prompt: "Maintain it",
      persona: "builder",
      enabled: false,
    });
    expect((await jobs.listJobs()).find((j) => j.id === job.id)?.persona).toBe(
      "builder"
    );
    expect((await templates.getTemplate(job.templateId!))?.persona).toBe(
      "builder"
    );
    await jobs.updateJob({ jobId: job.id, prompt: "New task" });
    expect((await templates.getTemplate(job.templateId!))?.persona).toBe(
      "builder"
    );
    const run = await jobs.runJob({ jobId: job.id, wait: false });
    expect(manager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: "builder" }),
      expect.any(Object)
    );
    await jobs.completeRunForAgent(run.agentId!, {
      status: "completed",
      summary: "Done",
      tasks: [],
    });
    const updated = await jobs.updateJob({ jobId: job.id, persona: null });
    expect(updated.persona).toBeNull();
    const clearedRun = await jobs.runJob({ jobId: job.id, wait: false });
    expect(manager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: undefined }),
      expect.any(Object)
    );
    await jobs.completeRunForAgent(clearedRun.agentId!, {
      status: "completed",
      summary: "Done",
      tasks: [],
    });
    expect((await templates.getTemplate(job.templateId!))?.persona).toBeNull();
    await expect(
      jobs.updateJob({ jobId: job.id, persona: "code-review" })
    ).rejects.toThrow("not available");
  });
  it.each([false, true])(
    "passes the saved persona to continuations (legacy job: %s)",
    async (legacy) => {
      const job = await jobs.addJob({
        name: `Continue-${legacy}`,
        directory,
        prompt: "Continue work",
        persona: "builder",
        enabled: true,
        continuationEnabled: true,
      });
      if (legacy) {
        await pool.query("UPDATE jobs SET template_id = NULL WHERE id = $1", [
          job.id,
        ]);
      }
      const run = await jobs.runJob({ jobId: job.id, wait: false });
      expect(manager.createAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({ persona: "builder" }),
        expect.any(Object)
      );
      await new JobStore(pool).completeRunForAgent(run.agentId!, {
        status: "completed",
        summary: "Next slice",
        tasks: [],
        continuation: {
          action: "continue",
          summary: "Continue",
          nextIntent: "Finish the next slice.",
        },
      });
      const next = await jobs.launchPendingContinuation(run.runId);
      expect(next).not.toBeNull();
      expect(manager.createAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({ persona: "builder" }),
        expect.any(Object)
      );
      await jobs.completeRunForAgent(next!.agentId!, {
        status: "completed",
        summary: "Done",
        tasks: [],
        continuation: { action: "finish", summary: "Finished" },
      });
    }
  );
  it("allows unrelated edits retaining an unavailable persona", async () => {
    const template = await templates.addTemplate({
      name: "Stale template",
      directory,
      prompt: "Task",
    });
    const job = await jobs.addJob({
      name: "Stale job",
      directory,
      prompt: "Task",
      enabled: true,
      schedule: "0 * * * *",
    });
    await pool.query(
      "UPDATE templates SET persona = 'deleted-persona' WHERE id = ANY($1::text[])",
      [[template.id, job.templateId]]
    );
    await pool.query(
      "UPDATE jobs SET persona = 'deleted-persona' WHERE id = $1",
      [job.id]
    );
    await expect(
      templates.updateTemplate(template.id, {
        directory,
        persona: "deleted-persona",
        description: "Still editable",
      })
    ).resolves.toMatchObject({
      persona: "deleted-persona",
      description: "Still editable",
    });
    await expect(
      jobs.updateJob({
        jobId: job.id,
        persona: "deleted-persona",
        enabled: false,
      })
    ).resolves.toMatchObject({ persona: "deleted-persona", enabled: false });
    await expect(
      templates.updateTemplate(template.id, { persona: "another-missing" })
    ).rejects.toThrow("not found");
    await expect(
      jobs.updateJob({ jobId: job.id, persona: "another-missing" })
    ).rejects.toThrow("not found");
  });
});

describe("job relocation persona resolution", () => {
  it("validates the selected persona in the effective new directory", async () => {
    const destination = await mkdtemp(
      path.join(os.tmpdir(), "dispatch-relocated-persona-")
    );
    const catalog = vi
      .spyOn(personaCatalog, "get")
      .mockImplementation(async (root) => ({
        personas:
          root === destination
            ? [
                {
                  slug: "destination-builder",
                  type: "task",
                  name: "Destination builder",
                  description: "Destination only",
                  body: "Build in destination.",
                },
              ]
            : [],
        warnings: [],
        refreshing: false,
        updatedAt: Date.now(),
      }));
    try {
      await upsertPersona({
        root: destination,
        slug: "destination-builder",
        type: "task",
        name: "Destination builder",
        description: "Destination only",
        instructions: "Build in destination.",
      });
      const job = await jobs.addJob({
        name: "persona-relocation-job",
        directory,
        prompt: "Work",
      });
      await expect(
        jobs.updateJob({
          jobId: job.id,
          directory: destination,
          persona: "destination-builder",
        })
      ).resolves.toMatchObject({
        directory: destination,
        persona: "destination-builder",
      });
    } finally {
      catalog.mockRestore();
      await rm(destination, { recursive: true, force: true });
    }
  });
});
