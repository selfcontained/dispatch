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

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM quick_phrases");
});

describe("GET /api/v1/quick-phrases", () => {
  it("returns empty list when no phrases exist", async () => {
    const res = await authedInject("GET", "/api/v1/quick-phrases");
    expect(res.statusCode).toBe(200);
    expect(res.json().phrases).toEqual([]);
  });

  it("returns created phrases in order", async () => {
    await authedInject("POST", "/api/v1/quick-phrases", { text: "yes" });
    await authedInject("POST", "/api/v1/quick-phrases", { text: "continue" });
    const res = await authedInject("GET", "/api/v1/quick-phrases");
    expect(res.statusCode).toBe(200);
    const { phrases } = res.json();
    expect(phrases).toHaveLength(2);
    expect(phrases[0].text).toBe("yes");
    expect(phrases[1].text).toBe("continue");
  });
});

describe("POST /api/v1/quick-phrases", () => {
  it("creates a phrase and returns it", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "looks good",
    });
    expect(res.statusCode).toBe(201);
    const { phrase } = res.json();
    expect(phrase.text).toBe("looks good");
    expect(phrase.label).toBeNull();
    expect(phrase.id).toBeDefined();
    expect(phrase.sortOrder).toBe(0);
    expect(phrase.createdAt).toBeDefined();
  });

  it("creates a phrase with a label", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "please continue with the implementation",
      label: "Continue",
    });
    expect(res.statusCode).toBe(201);
    const { phrase } = res.json();
    expect(phrase.text).toBe("please continue with the implementation");
    expect(phrase.label).toBe("Continue");
  });

  it("trims label whitespace and normalizes empty to null", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "hello",
      label: "   ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().phrase.label).toBeNull();
  });

  it("rejects empty text", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects text over 1000 characters", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "x".repeat(1001),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects label over 200 characters", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "hello",
      label: "x".repeat(201),
    });
    expect(res.statusCode).toBe(400);
  });

  it("trims whitespace", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "  hello  ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().phrase.text).toBe("hello");
  });
});

describe("PATCH /api/v1/quick-phrases/:id", () => {
  it("updates text only", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "original",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("PATCH", `/api/v1/quick-phrases/${id}`, {
      text: "updated",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phrase.text).toBe("updated");
    expect(res.json().phrase.label).toBeNull();
  });

  it("updates label only", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "some text",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("PATCH", `/api/v1/quick-phrases/${id}`, {
      label: "My Label",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phrase.label).toBe("My Label");
    expect(res.json().phrase.text).toBe("some text");
  });

  it("clears label by sending null", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "text",
      label: "Label",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("PATCH", `/api/v1/quick-phrases/${id}`, {
      label: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phrase.label).toBeNull();
  });

  it("rejects empty text", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "original",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("PATCH", `/api/v1/quick-phrases/${id}`, {
      text: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects empty body", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "original",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("PATCH", `/api/v1/quick-phrases/${id}`, {});
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for non-existent phrase", async () => {
    const res = await authedInject(
      "PATCH",
      "/api/v1/quick-phrases/00000000-0000-0000-0000-000000000000",
      { text: "nope" }
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/v1/quick-phrases/:id", () => {
  it("deletes an existing phrase", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "delete me",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("DELETE", `/api/v1/quick-phrases/${id}`);
    expect(res.statusCode).toBe(204);

    const listRes = await authedInject("GET", "/api/v1/quick-phrases");
    expect(listRes.json().phrases).toHaveLength(0);
  });

  it("returns 404 for non-existent phrase", async () => {
    const res = await authedInject(
      "DELETE",
      "/api/v1/quick-phrases/00000000-0000-0000-0000-000000000000"
    );
    expect(res.statusCode).toBe(404);
  });
});
