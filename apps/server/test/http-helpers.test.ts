import { describe, expect, it } from "vitest";

import { getBearerToken } from "../src/server/http-helpers.js";

describe("getBearerToken", () => {
  it("extracts token from a valid Bearer header", () => {
    expect(
      getBearerToken({ headers: { authorization: "Bearer abc123" } })
    ).toBe("abc123");
  });

  it("returns null when no authorization header exists", () => {
    expect(getBearerToken({ headers: {} })).toBeNull();
  });

  it("returns null when authorization is not a string", () => {
    expect(getBearerToken({ headers: { authorization: 42 } })).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(
      getBearerToken({ headers: { authorization: "Basic dXNlcjpwYXNz" } })
    ).toBeNull();
  });

  it("handles tokens with special characters", () => {
    expect(
      getBearerToken({
        headers: { authorization: "Bearer eyJ0eXAiOi.eyJzdWIiOi.sig" },
      })
    ).toBe("eyJ0eXAiOi.eyJzdWIiOi.sig");
  });

  it("returns empty string for 'Bearer ' with no token", () => {
    expect(getBearerToken({ headers: { authorization: "Bearer " } })).toBe("");
  });

  it("is case-sensitive for the Bearer prefix", () => {
    expect(
      getBearerToken({ headers: { authorization: "bearer abc123" } })
    ).toBeNull();
  });
});
