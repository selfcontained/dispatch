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

import { registerQuickPhraseRoutes } from "../src/routes/quick-phrases.js";
import * as quickPhraseQueries from "../src/db/quick-phrases.js";

vi.mock("../src/db/quick-phrases.js", () => ({
  listQuickPhrases: vi.fn(),
  createQuickPhrase: vi.fn(),
  updateQuickPhrase: vi.fn(),
  deleteQuickPhrase: vi.fn(),
}));

const mockPhrase = {
  id: "qp-1",
  label: "Greet",
  text: "Hello, {{D:name}}!",
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockPhraseNoArgs = {
  id: "qp-2",
  label: null,
  text: "Ship it",
  sortOrder: 1,
  createdAt: "2026-01-02T00:00:00.000Z",
};

let app: FastifyInstance;
const pool = {} as never;

beforeAll(async () => {
  app = Fastify();
  await registerQuickPhraseRoutes(app, { pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quickPhraseQueries.listQuickPhrases).mockResolvedValue([
    mockPhrase,
    mockPhraseNoArgs,
  ] as never);
  vi.mocked(quickPhraseQueries.createQuickPhrase).mockResolvedValue(
    mockPhrase as never
  );
  vi.mocked(quickPhraseQueries.updateQuickPhrase).mockResolvedValue(
    mockPhrase as never
  );
  vi.mocked(quickPhraseQueries.deleteQuickPhrase).mockResolvedValue(
    true as never
  );
});

// ---------------------------------------------------------------------------
// GET /api/v1/quick-phrases
// ---------------------------------------------------------------------------
describe("GET /api/v1/quick-phrases", () => {
  it("returns phrases with parsed args", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quick-phrases",
    });
    expect(res.statusCode).toBe(200);
    const { phrases } = res.json();
    expect(phrases).toHaveLength(2);
    expect(phrases[0].id).toBe("qp-1");
    expect(phrases[0].args).toBeDefined();
    expect(phrases[0].args.length).toBeGreaterThan(0);
    expect(phrases[0].args[0].name).toBe("name");
    expect(phrases[1].args).toEqual([]);
  });

  it("returns empty array when no phrases exist", async () => {
    vi.mocked(quickPhraseQueries.listQuickPhrases).mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quick-phrases",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phrases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/quick-phrases
// ---------------------------------------------------------------------------
describe("POST /api/v1/quick-phrases", () => {
  it("creates a phrase with text and label", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "Hello world", label: "Greet" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().phrase.id).toBe("qp-1");
    expect(res.json().phrase.args).toBeDefined();
    expect(quickPhraseQueries.createQuickPhrase).toHaveBeenCalledWith(pool, {
      text: "Hello world",
      label: "Greet",
    });
  });

  it("creates a phrase with text only (no label)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "Ship it" },
    });
    expect(res.statusCode).toBe(201);
    expect(quickPhraseQueries.createQuickPhrase).toHaveBeenCalledWith(pool, {
      text: "Ship it",
      label: null,
    });
  });

  it("returns 400 when text is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { label: "No text" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text is required/i);
  });

  it("returns 400 when text is empty string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text is required/i);
  });

  it("returns 400 when text exceeds maximum length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "x".repeat(1001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1000 characters/i);
  });

  it("returns 400 when label exceeds maximum length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "Valid text", label: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/200 characters/i);
  });

  it("trims whitespace from text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "  hello  " },
    });
    expect(res.statusCode).toBe(201);
    expect(quickPhraseQueries.createQuickPhrase).toHaveBeenCalledWith(pool, {
      text: "hello",
      label: null,
    });
  });

  it("stores whitespace-only label as null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "Hello", label: "   " },
    });
    expect(res.statusCode).toBe(201);
    expect(quickPhraseQueries.createQuickPhrase).toHaveBeenCalledWith(pool, {
      text: "Hello",
      label: null,
    });
  });

  it("accepts text at exactly maximum length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quick-phrases",
      payload: { text: "x".repeat(1000) },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/quick-phrases/:id
// ---------------------------------------------------------------------------
describe("PATCH /api/v1/quick-phrases/:id", () => {
  it("updates text only", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { text: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(quickPhraseQueries.updateQuickPhrase).toHaveBeenCalledWith(
      pool,
      "qp-1",
      { text: "Updated" }
    );
  });

  it("updates label only", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { label: "New Label" },
    });
    expect(res.statusCode).toBe(200);
    expect(quickPhraseQueries.updateQuickPhrase).toHaveBeenCalledWith(
      pool,
      "qp-1",
      { label: "New Label" }
    );
  });

  it("updates both text and label", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { text: "New text", label: "New label" },
    });
    expect(res.statusCode).toBe(200);
    expect(quickPhraseQueries.updateQuickPhrase).toHaveBeenCalledWith(
      pool,
      "qp-1",
      { text: "New text", label: "New label" }
    );
  });

  it("clears label when set to null", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { label: null },
    });
    expect(res.statusCode).toBe(200);
    expect(quickPhraseQueries.updateQuickPhrase).toHaveBeenCalledWith(
      pool,
      "qp-1",
      { label: null }
    );
  });

  it("returns 400 when text is empty", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text must not be empty/i);
  });

  it("returns 400 when text exceeds maximum length", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { text: "x".repeat(1001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1000 characters/i);
  });

  it("returns 400 when label exceeds maximum length", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { label: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/200 characters/i);
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one field/i);
  });

  it("returns 404 when phrase does not exist", async () => {
    vi.mocked(quickPhraseQueries.updateQuickPhrase).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/nonexistent",
      payload: { text: "Updated" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("response includes parsed args", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/quick-phrases/qp-1",
      payload: { text: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phrase.args).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/quick-phrases/:id
// ---------------------------------------------------------------------------
describe("DELETE /api/v1/quick-phrases/:id", () => {
  it("deletes an existing phrase", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/quick-phrases/qp-1",
    });
    expect(res.statusCode).toBe(204);
    expect(quickPhraseQueries.deleteQuickPhrase).toHaveBeenCalledWith(
      pool,
      "qp-1"
    );
  });

  it("returns 404 when phrase does not exist", async () => {
    vi.mocked(quickPhraseQueries.deleteQuickPhrase).mockResolvedValue(false);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/quick-phrases/nonexistent",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });
});
