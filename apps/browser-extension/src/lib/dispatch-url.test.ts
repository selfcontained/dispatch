import { describe, expect, it } from "vitest";
import { normalizeDispatchBaseUrl, usesInsecureHttp } from "./dispatch-url";

describe("normalizeDispatchBaseUrl", () => {
  it("allows HTTP for a Tailscale address", () => {
    expect(normalizeDispatchBaseUrl("http://100.97.168.63:6767/settings")).toBe(
      "http://100.97.168.63:6767"
    );
  });

  it("allows HTTPS for public instances", () => {
    expect(normalizeDispatchBaseUrl("https://dispatch.example.com/path")).toBe(
      "https://dispatch.example.com"
    );
  });

  it("allows HTTP for public instances", () => {
    expect(normalizeDispatchBaseUrl("http://dispatch.example.com/path")).toBe(
      "http://dispatch.example.com"
    );
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      normalizeDispatchBaseUrl("https://user:pass@example.com")
    ).toThrow("cannot include credentials");
  });
});

describe("usesInsecureHttp", () => {
  it("identifies HTTP connections", () => {
    expect(usesInsecureHttp("http://dispatch.local:6767")).toBe(true);
    expect(usesInsecureHttp("https://dispatch.example.com")).toBe(false);
  });
});
