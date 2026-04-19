import { describe, expect, it } from "vitest";

import { extractHostname, rewritePinUrl } from "./rewrite-pin-url";

describe("rewritePinUrl", () => {
  const target = "dispatch.example.com";

  it.each([
    ["http://localhost:5173", "http://dispatch.example.com:5173/"],
    ["http://127.0.0.1:5173", "http://dispatch.example.com:5173/"],
    ["http://0.0.0.0:8080", "http://dispatch.example.com:8080/"],
    ["http://[::1]:5173", "http://dispatch.example.com:5173/"],
  ])("rewrites loopback host %s", (input, expected) => {
    expect(rewritePinUrl(input, target)).toBe(expected);
  });

  it("preserves path, query, and fragment", () => {
    expect(
      rewritePinUrl("http://localhost:5173/foo/bar?x=1&y=2#section", target)
    ).toBe("http://dispatch.example.com:5173/foo/bar?x=1&y=2#section");
  });

  it("preserves https scheme and default port", () => {
    expect(rewritePinUrl("https://localhost/dashboard", target)).toBe(
      "https://dispatch.example.com/dashboard"
    );
  });

  it("leaves non-loopback hosts alone", () => {
    expect(rewritePinUrl("http://example.com:5173", target)).toBe(
      "http://example.com:5173"
    );
  });

  it("returns malformed input unchanged", () => {
    expect(rewritePinUrl("not a url", target)).toBe("not a url");
    expect(rewritePinUrl("", target)).toBe("");
  });

  it("accepts a targetHost with port and strips it", () => {
    // Only the hostname portion should be used; pin's own port wins.
    expect(
      rewritePinUrl("http://localhost:5173", "dispatch.example.com:3000")
    ).toBe("http://dispatch.example.com:5173/");
  });
});

describe("extractHostname", () => {
  it("returns bare hostname when port is absent", () => {
    expect(extractHostname("example.com")).toBe("example.com");
  });

  it("strips the port from host:port", () => {
    expect(extractHostname("example.com:8080")).toBe("example.com");
  });

  it("unwraps IPv6 bracket notation", () => {
    expect(extractHostname("[::1]:8080")).toBe("[::1]");
  });

  it("passes unparseable input through", () => {
    expect(extractHostname("")).toBe("");
  });
});
