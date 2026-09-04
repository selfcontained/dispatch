import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  payload?: unknown
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createTemplate(
  name: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await authedInject("POST", "/api/v1/templates", {
    name,
    directory: "/tmp",
    ...overrides,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM templates");
});

describe("POST /api/v1/templates (create)", () => {
  it("creates a template with required fields", async () => {
    const body = await createTemplate("basic-tmpl");
    expect(body.name).toBe("basic-tmpl");
    expect(body.directory).toBe("/tmp");
    expect(body.id).toBeTruthy();
    expect(body.agentType).toBe("claude");
    expect(body.useWorktree).toBe(false);
    expect(body.fullAccess).toBe(false);
    expect(body.callable).toBe(true);
    expect(body.allowMedia).toBe(true);
  });

  it("creates a template with all optional fields", async () => {
    const body = await createTemplate("full-tmpl", {
      description: "A test template",
      prompt: "Do something",
      agentType: "codex",
      useWorktree: true,
      baseBranch: "develop",
      branchName: "feature-x",
      fullAccess: true,
      callable: false,
      allowMedia: false,
    });
    expect(body.description).toBe("A test template");
    expect(body.prompt).toBe("Do something");
    expect(body.agentType).toBe("codex");
    expect(body.useWorktree).toBe(true);
    expect(body.baseBranch).toBe("develop");
    expect(body.branchName).toBe("feature-x");
    expect(body.fullAccess).toBe(true);
    expect(body.callable).toBe(false);
    expect(body.allowMedia).toBe(false);
  });

  it("rejects missing name", async () => {
    const res = await authedInject("POST", "/api/v1/templates", {
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing directory", async () => {
    const res = await authedInject("POST", "/api/v1/templates", {
      name: "no-dir",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects duplicate name in same directory", async () => {
    await createTemplate("dup-name");
    const res = await authedInject("POST", "/api/v1/templates", {
      name: "dup-name",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already exists");
  });
});

describe("GET /api/v1/templates (list)", () => {
  it("returns empty array when no templates exist", async () => {
    const res = await authedInject("GET", "/api/v1/templates");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns created templates", async () => {
    await createTemplate("tmpl-a");
    await createTemplate("tmpl-b");
    const res = await authedInject("GET", "/api/v1/templates");
    expect(res.statusCode).toBe(200);
    const templates = res.json();
    expect(templates).toHaveLength(2);
  });

  it("excludes job-backed templates", async () => {
    await createTemplate("standalone-tmpl");
    await authedInject("POST", "/api/v1/jobs", {
      name: "test-job",
      directory: "/tmp",
      prompt: "job prompt",
    });
    const jobRow = await ctx.pool.query(
      `SELECT template_id FROM jobs WHERE name = 'test-job'`
    );
    const jobTemplateId = jobRow.rows[0].template_id;

    const res = await authedInject("GET", "/api/v1/templates");
    const templates = res.json() as Array<{ id: string }>;
    const hasJobTemplate = templates.some((t) => t.id === jobTemplateId);
    expect(hasJobTemplate).toBe(false);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("standalone-tmpl");
  });
});

describe("GET /api/v1/templates/:id (get)", () => {
  it("returns a template by id with parsed args", async () => {
    const created = await createTemplate("get-tmpl", {
      prompt: "Hello {{D:name}}, deploy to {{D:env}}",
    });
    const res = await authedInject(
      "GET",
      `/api/v1/templates/${(created as { id: string }).id}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("get-tmpl");
    expect(body.args).toBeInstanceOf(Array);
    expect(body.args.length).toBe(2);
  });

  it("returns empty args for a template without prompt", async () => {
    const created = await createTemplate("no-prompt-tmpl");
    const res = await authedInject(
      "GET",
      `/api/v1/templates/${(created as { id: string }).id}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().args).toEqual([]);
  });

  it("returns 404 for non-existent template", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/templates/00000000-0000-0000-0000-000000000000"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });
});

describe("PATCH /api/v1/templates/:id (update)", () => {
  it("updates template fields", async () => {
    const created = await createTemplate("patch-tmpl", {
      prompt: "original prompt",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("PATCH", `/api/v1/templates/${id}`, {
      name: "patched-name",
      prompt: "updated prompt",
      fullAccess: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("patched-name");
    expect(body.prompt).toBe("updated prompt");
    expect(body.fullAccess).toBe(true);
  });

  it("clears nullable fields with explicit null", async () => {
    const created = await createTemplate("clear-tmpl", {
      description: "has desc",
      prompt: "has prompt",
      baseBranch: "main",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("PATCH", `/api/v1/templates/${id}`, {
      description: null,
      prompt: null,
      baseBranch: null,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.description).toBeNull();
    expect(body.prompt).toBeNull();
    expect(body.baseBranch).toBeNull();
  });

  it("returns 404 for non-existent template", async () => {
    const res = await authedInject(
      "PATCH",
      "/api/v1/templates/00000000-0000-0000-0000-000000000000",
      { name: "nope" }
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("rejects rename to existing name in same directory", async () => {
    await createTemplate("existing-name");
    const created = await createTemplate("rename-src");
    const id = (created as { id: string }).id;
    const res = await authedInject("PATCH", `/api/v1/templates/${id}`, {
      name: "existing-name",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already exists");
  });
});

describe("DELETE /api/v1/templates/:id", () => {
  it("deletes an existing template", async () => {
    const created = await createTemplate("delete-tmpl");
    const id = (created as { id: string }).id;
    const res = await authedInject("DELETE", `/api/v1/templates/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("delete-tmpl");

    const listRes = await authedInject("GET", "/api/v1/templates");
    expect(listRes.json()).toHaveLength(0);
  });

  it("returns 404 for non-existent template", async () => {
    const res = await authedInject(
      "DELETE",
      "/api/v1/templates/00000000-0000-0000-0000-000000000000"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("rejects deletion of a template referenced by a job", async () => {
    await authedInject("POST", "/api/v1/jobs", {
      name: "ref-job",
      directory: "/tmp",
      prompt: "job prompt",
    });
    const jobRow = await ctx.pool.query(
      `SELECT template_id FROM jobs WHERE name = 'ref-job'`
    );
    const templateId = jobRow.rows[0].template_id;

    const res = await authedInject("DELETE", `/api/v1/templates/${templateId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("referenced by");
  });
});

describe("POST /api/v1/templates/:id/launch", () => {
  it("launches a template and returns agent", async () => {
    const created = await createTemplate("launch-tmpl", {
      prompt: "Hello world",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject(
      "POST",
      `/api/v1/templates/${id}/launch`,
      {}
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent).toBeDefined();
    expect(body.agent.id).toBeTruthy();
  });

  it("records startup links as link attachments on the launch post, not as duplicate url pins", async () => {
    const created = await createTemplate("links-tmpl", {
      prompt: "Read the spec",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      startupLinks: ["https://example.com/spec"],
    });
    expect(res.statusCode).toBe(200);
    const agent = res.json().agent;
    // The route still turns the link into a url pin for the sidebar...
    expect(agent.pins).toEqual([
      expect.objectContaining({
        type: "url",
        value: "https://example.com/spec",
      }),
    ]);
    // ...but the launch post shows the URL once, as a link attachment, while
    // template runtime instructions stay out of Chat.
    const posts = await ctx.pool.query(
      `SELECT text, origin, attachments FROM agent_chat_messages
         WHERE agent_id = $1`,
      [agent.id]
    );
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0]).toMatchObject({
      text: "",
      origin: "launch",
      attachments: [{ type: "link", url: "https://example.com/spec" }],
    });
  });

  it("launches with args and links agent to template", async () => {
    const created = await createTemplate("args-tmpl", {
      prompt: "Deploy {{D:app}} to {{D:env}}",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      args: { app: "myapp", env: "staging" },
    });
    expect(res.statusCode).toBe(200);
    const agent = res.json().agent;
    expect(agent).toBeDefined();
    expect(agent.templateId).toBe(id);
    expect(agent.name).toBe("args-tmpl");
  });

  it("launches with directory override", async () => {
    const created = await createTemplate("dir-tmpl", {
      prompt: "Run in dir",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      directory: "/var/tmp",
    });
    expect(res.statusCode).toBe(200);
    const agent = res.json().agent;
    expect(agent).toBeDefined();
    expect(agent.cwd).toBe("/var/tmp");
  });

  it("launches with a model override", async () => {
    const created = await createTemplate("model-tmpl", {
      prompt: "Run it",
      agentType: "claude",
      model: "sonnet",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      model: "opus",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.model).toBe("opus");
  });

  it("treats an empty model field as the CLI default", async () => {
    const created = await createTemplate("model-default-tmpl", {
      prompt: "Run it",
      agentType: "claude",
      model: "sonnet",
    });
    const id = (created as { id: string }).id;
    // Multipart launches serialize "use the default" as an empty string.
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      model: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.model).toBeNull();
  });

  it("rejects a model the launched agent type cannot run", async () => {
    const created = await createTemplate("model-mismatch-tmpl", {
      prompt: "Run it",
      agentType: "claude",
    });
    const id = (created as { id: string }).id;
    const res = await authedInject("POST", `/api/v1/templates/${id}/launch`, {
      agentType: "codex",
      model: "sonnet",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not supported for codex");
  });

  it("returns error for non-existent template", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/templates/00000000-0000-0000-0000-000000000000/launch",
      {}
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns error when non-terminal template has no prompt", async () => {
    const created = await createTemplate("no-prompt-launch");
    const id = (created as { id: string }).id;
    const res = await authedInject(
      "POST",
      `/api/v1/templates/${id}/launch`,
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no prompt");
  });
});
