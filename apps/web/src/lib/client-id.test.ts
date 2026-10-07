import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientId } from "./client-id";

afterEach(() => vi.unstubAllGlobals());

describe("createClientId", () => {
  it("creates unique v4 UUIDs without secure-context APIs", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(
      globalThis.crypto
    );
    // Plain HTTP exposes random bytes but no randomUUID or subtle.
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 1000 }, createClientId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
  });
});
