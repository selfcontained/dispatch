import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const mediaRoot = path.join(os.tmpdir(), `media-routes-test-${process.pid}`);

afterAll(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
});

const ctx = useInjectApp({
  env: { MEDIA_ROOT: mediaRoot },
});

async function authedInject(
  method: string,
  url: string,
  opts?: { payload?: unknown; headers?: Record<string, string> }
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie, ...opts?.headers };
  if (opts?.payload !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST",
    url,
    headers,
    ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

async function createAgent(
  name = "media-test"
): Promise<{ id: string; mediaDir: string | null }> {
  const res = await authedInject("POST", "/api/v1/agents", {
    payload: { cwd: "/tmp", useWorktree: false, name },
  });
  expect(res.statusCode).toBe(201);
  const agent = res.json().agent;
  return { id: agent.id, mediaDir: agent.mediaDir ?? null };
}

function buildMultipartPayload(
  fields: Record<string, string>,
  file?: { fieldname: string; filename: string; content: Buffer }
): { body: string; boundary: string } {
  const boundary = "----dispatch-media-test-boundary";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="${name}"`,
      "",
      value
    );
  }
  if (file) {
    parts.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"`,
      "Content-Type: application/octet-stream",
      "",
      file.content.toString("binary")
    );
  }
  parts.push(`--${boundary}--`, "");
  return { body: parts.join("\r\n"), boundary };
}

let agentId: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM media_seen");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  const agent = await createAgent();
  agentId = agent.id;
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/media (list)
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/media (list)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/media"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns empty files array for agent with no media", async () => {
    const res = await authedInject("GET", `/api/v1/agents/${agentId}/media`);
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([]);
  });

  it("returns media files with metadata after seeding", async () => {
    await ctx.pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
       VALUES ($1, 'screenshot-001.png', 'screenshot', 1024, 'a test image')`,
      [agentId]
    );

    const res = await authedInject("GET", `/api/v1/agents/${agentId}/media`);
    expect(res.statusCode).toBe(200);
    const { files } = res.json();
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("screenshot-001.png");
    expect(files[0].source).toBe("screenshot");
    expect(files[0].size).toBe(1024);
    expect(files[0].description).toBe("a test image");
    expect(files[0].url).toContain(agentId);
    expect(files[0].seen).toBe(false);
  });

  it("reflects seen status after marking keys", async () => {
    await ctx.pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
       VALUES ($1, 'img.png', 'screenshot', 100, '2026-01-01T00:00:00Z')`,
      [agentId]
    );

    const listBefore = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media`
    );
    const fileBefore = listBefore.json().files[0];
    const mediaKey = `${fileBefore.name}:${fileBefore.updatedAt}`;

    await ctx.pool.query(
      `INSERT INTO media_seen (agent_id, media_key) VALUES ($1, $2)`,
      [agentId, mediaKey]
    );

    const listAfter = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media`
    );
    expect(listAfter.json().files[0].seen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/media/:file (serve)
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/media/:file (serve)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/media/test.png"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid file name characters", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media/..%2F..%2Fetc%2Fpasswd`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid");
  });

  it("returns 404 for file that does not exist on disk", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media/no-such-file.png`
    );
    expect(res.statusCode).toBe(404);
  });

  it("serves an existing file with correct mime type", async () => {
    const agentMediaDir = path.join(mediaRoot, agentId);
    await mkdir(agentMediaDir, { recursive: true });
    const content = Buffer.from("fake-png-data");
    await writeFile(path.join(agentMediaDir, "test-image.png"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media/test-image.png`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.rawPayload.length).toBe(content.length);
  });

  it("serves a JSON file with application/json mime type", async () => {
    const agentMediaDir = path.join(mediaRoot, agentId);
    await mkdir(agentMediaDir, { recursive: true });
    const content = Buffer.from('{"hello":"world"}');
    await writeFile(path.join(agentMediaDir, "data.json"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/media/data.json`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/media (upload)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/media (upload)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "test.png",
        content: Buffer.from("fake-png"),
      }
    );
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/media",
      {
        payload: body,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
      }
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for unsupported file type", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "malware.exe",
        content: Buffer.from("evil"),
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/media`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unsupported file type");
  });

  it("uploads an image and returns metadata", async () => {
    const { body, boundary } = buildMultipartPayload(
      { source: "screenshot", description: "test upload" },
      {
        fieldname: "file",
        filename: "capture.png",
        content: Buffer.from("fake-png-bytes"),
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/media`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    const { media } = res.json();
    expect(media.fileName).toMatch(/^capture-.*\.png$/);
    expect(media.source).toBe("screenshot");
    expect(media.sizeBytes).toBe(Buffer.from("fake-png-bytes").length);
    expect(media.url).toContain(agentId);
  });

  it("defaults source to text for text files", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "notes.md",
        content: Buffer.from("# Hello"),
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/media`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().media.source).toBe("text");
  });

  it("falls back to screenshot for invalid source on image", async () => {
    const { body, boundary } = buildMultipartPayload(
      { source: "bogus" },
      {
        fieldname: "file",
        filename: "img.png",
        content: Buffer.from("fake"),
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/media`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().media.source).toBe("screenshot");
  });

  it("creates a DB record visible in list endpoint", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "trace.png",
        content: Buffer.from("data"),
      }
    );
    await authedInject("POST", `/api/v1/agents/${agentId}/media`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });

    const list = await authedInject("GET", `/api/v1/agents/${agentId}/media`);
    expect(list.json().files).toHaveLength(1);
    expect(list.json().files[0].name).toMatch(/^trace-.*\.png$/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/media/seen (mark seen)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/media/seen (mark seen)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/media/seen",
      { payload: { keys: ["k1"] } }
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when keys is not an array", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: "not-an-array" } }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("keys must be an array");
  });

  it("returns 400 when keys contains non-strings", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: [123, null] } }
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns ok with 0 updated when all keys are invalid", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: [""] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 0 });
  });

  it("marks keys as seen and reflects in list endpoint", async () => {
    await ctx.pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
       VALUES ($1, 'photo.png', 'screenshot', 50, '2026-02-01T00:00:00Z')`,
      [agentId]
    );

    const list1 = await authedInject("GET", `/api/v1/agents/${agentId}/media`);
    const file = list1.json().files[0];
    const key = `${file.name}:${file.updatedAt}`;

    const markRes = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: [key] } }
    );
    expect(markRes.statusCode).toBe(200);
    expect(markRes.json()).toEqual({ ok: true, updated: 1 });

    const list2 = await authedInject("GET", `/api/v1/agents/${agentId}/media`);
    expect(list2.json().files[0].seen).toBe(true);
  });

  it("deduplicates keys", async () => {
    const key = "file.png:2026-01-01T00:00:00.000Z";
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: [key, key, key] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
  });

  it("filters out invalid media keys", async () => {
    const validKey = "file.png:2026-01-01T00:00:00.000Z";
    const invalidKey = "has\x00null";
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/media/seen`,
      { payload: { keys: [validKey, invalidKey] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
  });
});
