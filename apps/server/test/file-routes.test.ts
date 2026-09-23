import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { BINARY_BYTES, PNG_BYTES } from "./helpers/file-bytes.js";
import { useInjectApp } from "./helpers/inject-app.js";

const filesRoot = path.join(os.tmpdir(), `file-routes-test-${process.pid}`);

afterAll(async () => {
  await rm(filesRoot, { recursive: true, force: true });
});

const ctx = useInjectApp({
  env: { DISPATCH_FILES_ROOT: filesRoot },
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
  name = "files-test"
): Promise<{ id: string; filesDir: string | null }> {
  const res = await authedInject("POST", "/api/v1/agents", {
    payload: { cwd: "/tmp", useWorktree: false, name },
  });
  expect(res.statusCode).toBe(201);
  const agent = res.json().agent;
  return { id: agent.id, filesDir: agent.filesDir ?? null };
}

function buildMultipartPayload(
  fields: Record<string, string>,
  file?: { fieldname: string; filename: string; content: Buffer }
): { body: Buffer; boundary: string } {
  const boundary = "----dispatch-files-test-boundary";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="${name}"`,
      "",
      value
    );
  }
  const chunks: Buffer[] = [Buffer.from(parts.map((p) => p + "\r\n").join(""))];
  if (file) {
    chunks.push(
      Buffer.from(
        [
          `--${boundary}`,
          `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"`,
          "Content-Type: application/octet-stream",
          "",
          "",
        ].join("\r\n")
      ),
      file.content,
      Buffer.from("\r\n")
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

let agentId: string;

/** A file on disk and its row, typed as the upload path would type it. */
async function storeFile(
  fileName: string,
  content: Buffer | string,
  mimeType: string
): Promise<void> {
  const agentFilesDir = path.join(filesRoot, agentId);
  await mkdir(agentFilesDir, { recursive: true });
  await writeFile(path.join(agentFilesDir, fileName), content);
  await ctx.pool.query(
    `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
     VALUES ($1, $2, 'screenshot', $3, $4)`,
    [agentId, fileName, Buffer.byteLength(content), mimeType]
  );
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM files_seen");
  await ctx.pool.query("DELETE FROM files");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  const agent = await createAgent();
  agentId = agent.id;
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/files (list)
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/files (list)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/files"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns empty files array for agent with no files", async () => {
    const res = await authedInject("GET", `/api/v1/agents/${agentId}/files`);
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([]);
  });

  it("returns files with metadata after seeding", async () => {
    const inserted = await ctx.pool.query<{ id: number }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, description, mime_type)
       VALUES ($1, 'screenshot-001.png', 'screenshot', 1024, 'a test image', 'image/png')
       RETURNING id`,
      [agentId]
    );

    const res = await authedInject("GET", `/api/v1/agents/${agentId}/files`);
    expect(res.statusCode).toBe(200);
    const { files } = res.json();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(inserted.rows[0].id);
    expect(files[0].name).toBe("screenshot-001.png");
    expect(files[0].source).toBe("screenshot");
    expect(files[0].size).toBe(1024);
    expect(files[0].description).toBe("a test image");
    expect(files[0].url).toContain(agentId);
    expect(files[0].seen).toBe(false);
  });

  it("reflects seen status after marking keys", async () => {
    await ctx.pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, created_at, mime_type)
       VALUES ($1, 'img.png', 'screenshot', 100, '2026-01-01T00:00:00Z', 'image/png')`,
      [agentId]
    );

    const listBefore = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files`
    );
    const fileBefore = listBefore.json().files[0];
    const fileKey = `${fileBefore.name}:${fileBefore.updatedAt}`;

    await ctx.pool.query(
      `INSERT INTO files_seen (agent_id, file_key) VALUES ($1, $2)`,
      [agentId, fileKey]
    );

    const listAfter = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files`
    );
    expect(listAfter.json().files[0].seen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/files/:fileId (metadata)
// ---------------------------------------------------------------------------
describe("GET /api/v1/files/:fileId (metadata)", () => {
  it("resolves metadata and content URL by ID without an owner", async () => {
    const inserted = await ctx.pool.query<{ id: number }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, description, mime_type)
       VALUES ($1, 'by-id.png', 'screenshot', 512, 'resolved by id', 'image/png')
       RETURNING id`,
      [agentId]
    );

    const fileId = inserted.rows[0].id;
    const res = await authedInject("GET", `/api/v1/files/${fileId}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({
      id: fileId,
      ownerAgentId: agentId,
      name: "by-id.png",
      size: 512,
      description: "resolved by id",
      url: `/api/v1/agents/${agentId}/files/by-id.png`,
    });
  });

  it("rejects invalid IDs and returns 404 for missing rows", async () => {
    expect((await authedInject("GET", "/api/v1/files/nope")).statusCode).toBe(
      400
    );
    expect((await authedInject("GET", "/api/v1/files/999999")).statusCode).toBe(
      404
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/files/:file (serve)
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/files/:file (serve)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/files/test.png"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid file name characters", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/..%2F..%2Fetc%2Fpasswd`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid");
  });

  it("returns 404 for file that does not exist on disk", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/no-such-file.png`
    );
    expect(res.statusCode).toBe(404);
  });

  it("serves an existing file with its stored mime type", async () => {
    const content = PNG_BYTES;
    await storeFile("test-image.png", content, "image/png");

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/test-image.png`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.rawPayload.length).toBe(content.length);
  });

  it("serves a JSON file with application/json mime type", async () => {
    await storeFile("data.json", '{"hello":"world"}', "application/json");

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/data.json`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("serves HTML sandboxed so it cannot run same-origin", async () => {
    await storeFile("report.html", "<h1>hello</h1>", "text/html");

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/report.html`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-popups"
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sandboxes XML too — browsers render it actively (XHTML/XSLT)", async () => {
    await storeFile(
      "evil.xml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><script>fetch("/api")</script></html>',
      "application/xml"
    );

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/evil.xml`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-popups"
    );
  });

  it("omits the CSP sandbox header for passive types", async () => {
    await storeFile("shot.png", PNG_BYTES, "image/png");

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/shot.png`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves by the stored type, not the name, and sandboxes bytes with no row", async () => {
    // Named like an image, stored as text: the row wins.
    await storeFile("looks.png", "plain words", "text/plain");
    const typed = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/looks.png`
    );
    expect(typed.headers["content-type"]).toContain("text/plain");

    const agentFilesDir = path.join(filesRoot, agentId);
    await writeFile(path.join(agentFilesDir, "stray.png"), PNG_BYTES);
    const stray = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/stray.png`
    );
    expect(stray.statusCode).toBe(200);
    expect(stray.headers["content-type"]).toContain("application/octet-stream");
    expect(stray.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-popups"
    );
  });

  it("advertises Accept-Ranges and Content-Length on a plain 200", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(content.length));
  });

  it("returns 206 with Content-Range for a mid-file byte range", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "bytes=2-4" } }
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-4/${content.length}`);
    expect(res.headers["content-length"]).toBe("3");
    expect(res.rawPayload.toString()).toBe("234");
    // Security headers still land on a partial response.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("resolves an open-ended range to end of file", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "bytes=7-" } }
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 7-9/${content.length}`);
    expect(res.rawPayload.toString()).toBe("789");
  });

  it("resolves a suffix range to the last N bytes", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "bytes=-3" } }
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 7-9/${content.length}`);
    expect(res.rawPayload.toString()).toBe("789");
  });

  it("returns 416 with Content-Range */size for an unsatisfiable range", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "bytes=100-200" } }
    );
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${content.length}`);
  });

  it("ignores a malformed Range header and serves the whole file (RFC 9110 §14.2)", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "not-a-range" } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(content.length);
  });

  it("ignores a multi-range request and serves the whole file", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "bytes=0-1,4-6" } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(content.length);
  });

  it("ignores an unrecognized Range unit and serves the whole file", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    const content = Buffer.from("0123456789");
    await writeFile(path.join(agentFilesDir, "clip.mp4"), content);

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/clip.mp4`,
      { headers: { range: "items=0-1" } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(content.length);
  });

  it("serves a 0-byte file as an empty 200 rather than crashing", async () => {
    const agentFilesDir = path.join(filesRoot, agentId);
    await mkdir(agentFilesDir, { recursive: true });
    await writeFile(path.join(agentFilesDir, "empty.png"), Buffer.alloc(0));

    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/files/empty.png`
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("0");
    expect(res.rawPayload.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/files (upload)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/files (upload)", () => {
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
      "/api/v1/agents/agt_nonexistent/files",
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
        content: BINARY_BYTES,
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unsupported file type");
  });

  it("returns 400 for a name that promises a type its contents are not", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "capture.png",
        content: Buffer.from("not an image"),
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("named as image/png");
  });

  it("uploads an image and returns metadata", async () => {
    const { body, boundary } = buildMultipartPayload(
      { source: "screenshot", description: "test upload" },
      {
        fieldname: "file",
        filename: "capture.png",
        content: PNG_BYTES,
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    const { file } = res.json();
    expect(file.fileName).toMatch(/^capture-.*\.png$/);
    expect(file.source).toBe("screenshot");
    expect(file.sizeBytes).toBe(PNG_BYTES.length);
    expect(file.mimeType).toBe("image/png");
    expect(file.media).toBe("image");
    expect(file.url).toContain(agentId);
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
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.source).toBe("text");
  });

  it("falls back to screenshot for invalid source on image", async () => {
    const { body, boundary } = buildMultipartPayload(
      { source: "bogus" },
      {
        fieldname: "file",
        filename: "img.png",
        content: PNG_BYTES,
      }
    );
    const res = await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.source).toBe("screenshot");
  });

  it("creates a DB record visible in list endpoint", async () => {
    const { body, boundary } = buildMultipartPayload(
      {},
      {
        fieldname: "file",
        filename: "trace.png",
        content: PNG_BYTES,
      }
    );
    await authedInject("POST", `/api/v1/agents/${agentId}/files`, {
      payload: body,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });

    const list = await authedInject("GET", `/api/v1/agents/${agentId}/files`);
    expect(list.json().files).toHaveLength(1);
    expect(list.json().files[0].name).toMatch(/^trace-.*\.png$/);
    expect(list.json().files[0].mimeType).toBe("image/png");
    expect(list.json().files[0].media).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/files/seen (mark seen)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/files/seen (mark seen)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/files/seen",
      { payload: { keys: ["k1"] } }
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when keys is not an array", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: "not-an-array" } }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("keys must be an array");
  });

  it("returns 400 when keys contains non-strings", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: [123, null] } }
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns ok with 0 updated when all keys are invalid", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: [""] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 0 });
  });

  it("marks keys as seen and reflects in list endpoint", async () => {
    await ctx.pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, created_at, mime_type)
       VALUES ($1, 'photo.png', 'screenshot', 50, '2026-02-01T00:00:00Z', 'image/png')`,
      [agentId]
    );

    const list1 = await authedInject("GET", `/api/v1/agents/${agentId}/files`);
    const file = list1.json().files[0];
    const key = `${file.name}:${file.updatedAt}`;

    const markRes = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: [key] } }
    );
    expect(markRes.statusCode).toBe(200);
    expect(markRes.json()).toEqual({ ok: true, updated: 1 });

    const list2 = await authedInject("GET", `/api/v1/agents/${agentId}/files`);
    expect(list2.json().files[0].seen).toBe(true);
  });

  it("deduplicates keys", async () => {
    const key = "file.png:2026-01-01T00:00:00.000Z";
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: [key, key, key] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
  });

  it("filters out invalid file keys", async () => {
    const validKey = "file.png:2026-01-01T00:00:00.000Z";
    const invalidKey = "has\x00null";
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/files/seen`,
      { payload: { keys: [validKey, invalidKey] } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
  });
});
