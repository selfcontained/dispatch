import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { TemplateStore } from "../../src/templates/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";

let pool: Pool;
let store: TemplateStore;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new TemplateStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
});

describe("TemplateStore.listTemplates", () => {
  const callableTemplate = {
    name: "Callable Template",
    directory: "/tmp/test",
    description: null,
    prompt: "do stuff",
    agentType: "claude" as const,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowMedia: true,
  };

  const nonCallableTemplate = {
    ...callableTemplate,
    name: "Non-Callable Template",
    callable: false,
  };

  const jobBackedTemplate = {
    ...callableTemplate,
    name: "Job-Backed Template",
    callable: false,
  };

  let jobBackedId: string;

  beforeAll(async () => {
    const t1 = await store.createTemplate(callableTemplate);
    await store.createTemplate(nonCallableTemplate);
    const t3 = await store.createTemplate(jobBackedTemplate);
    jobBackedId = t3.id;

    // Create a job that references the job-backed template
    await pool.query(
      `INSERT INTO jobs (id, directory, name, schedule, timeout_ms, needs_input_timeout_ms,
        prompt, full_access, agent_type, use_worktree, auto_archive, callable, singleton, enabled, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        "test-job-1",
        "/tmp/test",
        "test job",
        "0 * * * *",
        60000,
        60000,
        null,
        false,
        "claude",
        false,
        true,
        false,
        true,
        true,
        jobBackedId,
      ]
    );
  });

  it("returns all templates with no filter", async () => {
    const templates = await store.listTemplates();
    expect(templates).toHaveLength(3);
  });

  it("filters by callable", async () => {
    const callable = await store.listTemplates({ callable: true });
    expect(callable).toHaveLength(1);
    expect(callable[0].name).toBe("Callable Template");

    const nonCallable = await store.listTemplates({ callable: false });
    expect(nonCallable).toHaveLength(2);
  });

  it("excludes job-backed templates", async () => {
    const templates = await store.listTemplates({ excludeJobBacked: true });
    expect(templates).toHaveLength(2);
    expect(templates.map((t) => t.name).sort()).toEqual([
      "Callable Template",
      "Non-Callable Template",
    ]);
  });

  it("combines callable and excludeJobBacked filters", async () => {
    const templates = await store.listTemplates({
      callable: true,
      excludeJobBacked: true,
    });
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Callable Template");
  });

  it("returns results sorted by name", async () => {
    const templates = await store.listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});
