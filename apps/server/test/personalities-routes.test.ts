import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerPersonalityRoutes } from "../src/routes/personalities.js";
import * as personalityQueries from "../src/db/personalities.js";

vi.mock("../src/db/personalities.js", () => ({
  activatePersonality: vi.fn(),
  listPersonalities: vi.fn(),
  getPersonality: vi.fn(),
  createPersonality: vi.fn(),
  updatePersonality: vi.fn(),
  deletePersonality: vi.fn(),
  getActivePersonalityId: vi.fn(),
  setActivePersonalityId: vi.fn(),
}));

const mockPersonality = {
  id: "p-1",
  name: "Friendly",
  prompt: "Be friendly and helpful.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let app: FastifyInstance;
const pool = {} as never;

beforeAll(async () => {
  app = Fastify();
  await registerPersonalityRoutes(app, { pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(personalityQueries.listPersonalities).mockResolvedValue([
    mockPersonality,
  ] as never);
  vi.mocked(personalityQueries.getActivePersonalityId).mockResolvedValue("p-1");
  vi.mocked(personalityQueries.getPersonality).mockResolvedValue(
    mockPersonality as never
  );
  vi.mocked(personalityQueries.createPersonality).mockResolvedValue(
    mockPersonality as never
  );
  vi.mocked(personalityQueries.updatePersonality).mockResolvedValue(
    mockPersonality as never
  );
  vi.mocked(personalityQueries.deletePersonality).mockResolvedValue(true);
  vi.mocked(personalityQueries.setActivePersonalityId).mockResolvedValue(
    undefined
  );
  vi.mocked(personalityQueries.activatePersonality).mockResolvedValue(true);
});

// ── GET /api/v1/personalities ──────────────────────────────────────────

describe("GET /api/v1/personalities", () => {
  it("returns personalities and activeId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personalities",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      personalities: [mockPersonality],
      activeId: "p-1",
    });
  });

  it("returns null activeId when none is set", async () => {
    vi.mocked(personalityQueries.getActivePersonalityId).mockResolvedValue(
      null
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personalities",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeId).toBeNull();
  });
});

// ── POST /api/v1/personalities ─────────────────────────────────────────

describe("POST /api/v1/personalities", () => {
  it("creates a personality", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Friendly", prompt: "Be friendly." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ personality: mockPersonality });
    expect(personalityQueries.createPersonality).toHaveBeenCalledWith(pool, {
      name: "Friendly",
      prompt: "Be friendly.",
    });
  });

  it("trims whitespace from name", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "  Spaced  ", prompt: "ok" },
    });
    expect(personalityQueries.createPersonality).toHaveBeenCalledWith(pool, {
      name: "Spaced",
      prompt: "ok",
    });
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { prompt: "ok" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name");
  });

  it("returns 400 when name is not a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: 123, prompt: "ok" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name");
  });

  it("returns 400 when name is whitespace-only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "   ", prompt: "ok" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name");
  });

  it("returns 400 when name exceeds 80 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "x".repeat(81), prompt: "ok" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("80");
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt");
  });

  it("returns 400 when prompt is not a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Test", prompt: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt");
  });

  it("returns 400 when prompt is whitespace-only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Test", prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt");
  });

  it("returns 400 when prompt exceeds 1000 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Test", prompt: "x".repeat(1001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("1000");
  });

  it("returns 409 on duplicate name", async () => {
    vi.mocked(personalityQueries.createPersonality).mockRejectedValue(
      new Error(
        "duplicate key value violates unique constraint personalities_name_key"
      )
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Friendly", prompt: "Be nice." },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already exists");
  });

  it("re-throws non-duplicate errors", async () => {
    vi.mocked(personalityQueries.createPersonality).mockRejectedValue(
      new Error("connection refused")
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: { name: "Valid", prompt: "Valid prompt" },
    });
    expect(res.statusCode).toBe(500);
  });
});

// ── PATCH /api/v1/personalities/:id ────────────────────────────────────

describe("PATCH /api/v1/personalities/:id", () => {
  it("updates a personality", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "Updated", prompt: "New prompt." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ personality: mockPersonality });
    expect(personalityQueries.updatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1",
      { name: "Updated", prompt: "New prompt." }
    );
  });

  it("passes through empty body as a no-op update", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(personalityQueries.updatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1",
      { name: undefined, prompt: undefined }
    );
  });

  it("allows partial update with only name", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "Only Name" },
    });
    expect(personalityQueries.updatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1",
      { name: "Only Name", prompt: undefined }
    );
  });

  it("allows partial update with only prompt", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { prompt: "Only prompt" },
    });
    expect(personalityQueries.updatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1",
      { name: undefined, prompt: "Only prompt" }
    );
  });

  it("trims whitespace from name", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "  Trimmed  " },
    });
    expect(personalityQueries.updatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1",
      { name: "Trimmed", prompt: undefined }
    );
  });

  it("returns 404 when personality does not exist", async () => {
    vi.mocked(personalityQueries.getPersonality).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-missing",
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 when name is not a string", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name must be a string");
  });

  it("returns 400 when name is empty after trimming", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cannot be empty");
  });

  it("returns 400 when name exceeds 80 characters", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "x".repeat(81) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("80");
  });

  it("returns 400 when prompt is not a string", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { prompt: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt must be a string");
  });

  it("returns 400 when prompt is whitespace-only", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cannot be empty");
  });

  it("returns 400 when prompt exceeds 1000 characters", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { prompt: "x".repeat(1001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("1000");
  });

  it("returns 409 on duplicate name during update", async () => {
    vi.mocked(personalityQueries.updatePersonality).mockRejectedValue(
      new Error(
        "duplicate key value violates unique constraint personalities_name_key"
      )
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "Taken" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already exists");
  });

  it("returns 404 when updatePersonality returns null", async () => {
    vi.mocked(personalityQueries.updatePersonality).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/p-1",
      payload: { name: "Race" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });
});

// ── DELETE /api/v1/personalities/:id ───────────────────────────────────

describe("DELETE /api/v1/personalities/:id", () => {
  it("deletes a personality", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/personalities/p-1",
    });
    expect(res.statusCode).toBe(204);
    expect(personalityQueries.deletePersonality).toHaveBeenCalledWith(
      pool,
      "p-1"
    );
  });

  it("returns 404 when personality does not exist", async () => {
    vi.mocked(personalityQueries.deletePersonality).mockResolvedValue(false);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/personalities/p-missing",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });
});

// ── POST /api/v1/personalities/active ──────────────────────────────────

describe("POST /api/v1/personalities/active", () => {
  it("sets active personality id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: { id: "p-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ activeId: "p-1" });
    expect(personalityQueries.activatePersonality).toHaveBeenCalledWith(
      pool,
      "p-1"
    );
  });

  it("clears active personality with null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: { id: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ activeId: null });
    expect(personalityQueries.setActivePersonalityId).toHaveBeenCalledWith(
      pool,
      null
    );
  });

  it("clears active personality when id is omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ activeId: null });
    expect(personalityQueries.setActivePersonalityId).toHaveBeenCalledWith(
      pool,
      null
    );
  });

  it("returns 400 when id is not a string or null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: { id: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("string or null");
  });

  it("returns 404 for empty string id", async () => {
    vi.mocked(personalityQueries.activatePersonality).mockResolvedValue(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: { id: "" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 404 when personality does not exist", async () => {
    vi.mocked(personalityQueries.activatePersonality).mockResolvedValue(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/personalities/active",
      payload: { id: "p-missing" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });
});
