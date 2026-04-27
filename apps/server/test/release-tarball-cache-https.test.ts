import { describe, expect, it } from "vitest";
import { isAllowedRedirectHost } from "../src/release-tarball-cache.js";

describe("isAllowedRedirectHost", () => {
  it("accepts the bare github.com host", () => {
    expect(isAllowedRedirectHost("github.com")).toBe(true);
  });

  it("accepts subdomains of githubusercontent.com (the signed-asset CDN)", () => {
    expect(isAllowedRedirectHost("objects.githubusercontent.com")).toBe(true);
    expect(isAllowedRedirectHost("release-assets.githubusercontent.com")).toBe(
      true
    );
  });

  it("accepts subdomains of github.com", () => {
    expect(isAllowedRedirectHost("api.github.com")).toBe(true);
    expect(isAllowedRedirectHost("codeload.github.com")).toBe(true);
  });

  it("rejects bare githubusercontent.com without a subdomain", () => {
    // The pattern is `\.githubusercontent\.com$` — requires the leading
    // dot — so the bare apex domain is NOT in the allowlist. (GitHub
    // never serves release assets directly from the apex, so this is the
    // safe default.)
    expect(isAllowedRedirectHost("githubusercontent.com")).toBe(false);
  });

  it("rejects suffix-attack hosts", () => {
    // The classic attack: register `evil-github.com` or
    // `github.com.attacker.com` and hope the allowlist matches by
    // substring. The trailing $ anchor closes that off.
    expect(isAllowedRedirectHost("evil-github.com")).toBe(false);
    expect(isAllowedRedirectHost("github.com.attacker.com")).toBe(false);
    expect(isAllowedRedirectHost("notgithub.com")).toBe(false);
    expect(isAllowedRedirectHost("githubusercontent.com.evil.example")).toBe(
      false
    );
  });

  it("rejects unrelated hostnames", () => {
    expect(isAllowedRedirectHost("example.com")).toBe(false);
    expect(isAllowedRedirectHost("attacker.host")).toBe(false);
    expect(isAllowedRedirectHost("localhost")).toBe(false);
  });
});
