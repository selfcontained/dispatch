// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { getSafariExternalHref } from "./external-links";

describe("getSafariExternalHref", () => {
  it("wraps https URLs with the x-safari- scheme", () => {
    expect(getSafariExternalHref("https://example.com/docs")).toBe(
      "x-safari-https://example.com/docs"
    );
  });

  it("returns null for http URLs (x-safari-http is not a valid iOS scheme)", () => {
    expect(getSafariExternalHref("http://localhost:5173")).toBeNull();
    expect(getSafariExternalHref("http://127.0.0.1:5173/foo")).toBeNull();
  });

  it("returns null for non-http(s) schemes", () => {
    expect(getSafariExternalHref("mailto:hi@example.com")).toBeNull();
    expect(getSafariExternalHref("javascript:void(0)")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(getSafariExternalHref("not a url")).toBeNull();
    expect(getSafariExternalHref("")).toBeNull();
  });
});
