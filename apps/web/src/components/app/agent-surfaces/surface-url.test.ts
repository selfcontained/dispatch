import { describe, expect, it } from "vitest";

import { isAllowedSurfaceUrl } from "./surface-url";

describe("isAllowedSurfaceUrl", () => {
  it("allows http URLs", () => {
    expect(isAllowedSurfaceUrl("http://example.com")).toBe(true);
  });

  it("allows https URLs", () => {
    expect(isAllowedSurfaceUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("allows mailto URLs", () => {
    expect(isAllowedSurfaceUrl("mailto:agent@example.com")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isAllowedSurfaceUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isAllowedSurfaceUrl("data:text/html,<script>1</script>")).toBe(
      false
    );
  });

  it("rejects file: URLs", () => {
    expect(isAllowedSurfaceUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects strings that aren't valid URLs", () => {
    expect(isAllowedSurfaceUrl("not a url")).toBe(false);
  });
});
