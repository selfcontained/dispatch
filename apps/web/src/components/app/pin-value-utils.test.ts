import { describe, it, expect } from "vitest";

import {
  formatPrDisplay,
  normalizeExternalHref,
  resolveDisplayValue,
  shouldRenderMarkdownAsPlainText,
  trimFilenameForDisplay,
} from "./pin-value-utils";

describe("formatPrDisplay", () => {
  it("turns a GitHub PR URL into owner/repo#number", () => {
    expect(
      formatPrDisplay("https://github.com/dispatch-run/dispatch/pull/1046")
    ).toBe("dispatch-run/dispatch#1046");
  });

  it("matches http as well as https", () => {
    expect(formatPrDisplay("http://github.com/foo/bar/pull/7")).toBe(
      "foo/bar#7"
    );
  });

  it("falls back to the raw value when it isn't a GitHub PR URL", () => {
    expect(formatPrDisplay("https://example.com/not/a/pr")).toBe(
      "https://example.com/not/a/pr"
    );
  });

  it("falls back to the raw value for a GitLab-style merge-request URL", () => {
    expect(formatPrDisplay("https://gitlab.com/foo/bar/pull/7")).toBe(
      "https://gitlab.com/foo/bar/pull/7"
    );
  });
});

describe("trimFilenameForDisplay", () => {
  it("passes the value through unchanged when there is no workspace root", () => {
    expect(trimFilenameForDisplay("/repo/src/index.ts", null)).toEqual({
      display: "/repo/src/index.ts",
      tooltip: "/repo/src/index.ts",
    });
  });

  it("strips the workspace-root prefix from a path inside it", () => {
    expect(trimFilenameForDisplay("/repo/src/index.ts", "/repo")).toEqual({
      display: "src/index.ts",
      tooltip: "/repo/src/index.ts",
    });
  });

  it("normalizes a trailing slash on the workspace root before stripping", () => {
    expect(trimFilenameForDisplay("/repo/src/index.ts", "/repo/")).toEqual({
      display: "src/index.ts",
      tooltip: "/repo/src/index.ts",
    });
  });

  it("renders './' when the value is exactly the workspace root", () => {
    expect(trimFilenameForDisplay("/repo", "/repo")).toEqual({
      display: "./",
      tooltip: "/repo",
    });
  });

  it("leaves the value unchanged when it isn't inside the workspace root", () => {
    expect(trimFilenameForDisplay("/other/file.ts", "/repo")).toEqual({
      display: "/other/file.ts",
      tooltip: "/other/file.ts",
    });
  });

  it("leaves the value unchanged when the root normalizes to empty (root '/')", () => {
    expect(trimFilenameForDisplay("/etc/hosts", "/")).toEqual({
      display: "/etc/hosts",
      tooltip: "/etc/hosts",
    });
  });

  it("does not strip a path that merely shares the root as a substring prefix", () => {
    // "/repo-other/file.ts" starts with "/repo" but not with "/repo/", so it
    // must not be treated as being inside the workspace root.
    expect(trimFilenameForDisplay("/repo-other/file.ts", "/repo")).toEqual({
      display: "/repo-other/file.ts",
      tooltip: "/repo-other/file.ts",
    });
  });
});

describe("shouldRenderMarkdownAsPlainText", () => {
  it("returns false for plain text with no markdown syntax", () => {
    expect(shouldRenderMarkdownAsPlainText("just a plain sentence")).toBe(
      false
    );
  });

  it("returns true for an inline link", () => {
    expect(
      shouldRenderMarkdownAsPlainText("see [docs](https://example.com)")
    ).toBe(true);
  });

  it("returns true for an image", () => {
    // Empty alt text so the image pattern is the only one that can match —
    // "![alt](...)" would also match the plain-link pattern (which strips
    // the leading "!"), so it can't distinguish the two.
    expect(
      shouldRenderMarkdownAsPlainText("![](https://example.com/a.png)")
    ).toBe(true);
  });

  it("returns true for a reference-style link", () => {
    expect(shouldRenderMarkdownAsPlainText("[a link][ref]")).toBe(true);
  });

  it("returns true for a link reference definition", () => {
    expect(shouldRenderMarkdownAsPlainText("[ref]: https://example.com")).toBe(
      true
    );
  });

  it("returns true for an ATX heading", () => {
    expect(shouldRenderMarkdownAsPlainText("## Heading")).toBe(true);
  });

  it("returns true for a blockquote", () => {
    expect(shouldRenderMarkdownAsPlainText("> quoted")).toBe(true);
  });

  it("returns true for an ordered list item", () => {
    expect(shouldRenderMarkdownAsPlainText("1. first step")).toBe(true);
  });

  it("returns true for embedded HTML", () => {
    expect(shouldRenderMarkdownAsPlainText("plain <b>bold</b> text")).toBe(
      true
    );
  });

  it("ignores markdown syntax that appears only inside a fenced code block", () => {
    const value = "```\n[not a link](inside a fence)\n```";
    expect(shouldRenderMarkdownAsPlainText(value)).toBe(false);
  });

  it("still detects markdown syntax outside the fence", () => {
    const value = "[a link](https://example.com)\n```\ncode\n```";
    expect(shouldRenderMarkdownAsPlainText(value)).toBe(true);
  });
});

describe("normalizeExternalHref", () => {
  it("returns null for a type that isn't url or pr", () => {
    expect(normalizeExternalHref("string", "https://example.com")).toBeNull();
  });

  it("returns null for an empty (or whitespace-only) value", () => {
    expect(normalizeExternalHref("url", "   ")).toBeNull();
  });

  it("adds an http:// scheme to a bare host for type 'url'", () => {
    expect(normalizeExternalHref("url", "example.com")).toBe(
      "http://example.com/"
    );
  });

  it("does not add a scheme to a bare host for type 'pr'", () => {
    // Unlike 'url', a schemeless value for 'pr' is passed to URL() as-is,
    // which throws, so the result is null rather than an auto-prefixed href.
    expect(normalizeExternalHref("pr", "github.com/foo/bar/pull/1")).toBeNull();
  });

  it("accepts an already-schemed https URL for type 'pr'", () => {
    expect(
      normalizeExternalHref("pr", "https://github.com/foo/bar/pull/1")
    ).toBe("https://github.com/foo/bar/pull/1");
  });

  it("rejects a non-http(s) protocol", () => {
    // Use type 'pr' so the scheme is passed through as-is (type 'url' would
    // prepend "http://" to a value SAFE_URL_RE doesn't already match).
    expect(normalizeExternalHref("pr", "ftp://example.com/file")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeExternalHref("url", "  https://example.com  ")).toBe(
      "https://example.com/"
    );
  });
});

describe("resolveDisplayValue", () => {
  it("formats a valid PR URL with the pr icon and no badge", () => {
    const result = resolveDisplayValue(
      "pr",
      "https://github.com/dispatch-run/dispatch/pull/1046"
    );
    expect(result).toEqual({
      display: "dispatch-run/dispatch#1046",
      tooltip: "https://github.com/dispatch-run/dispatch/pull/1046",
      href: "https://github.com/dispatch-run/dispatch/pull/1046",
      badge: false,
      icon: "pr",
    });
  });

  it("falls back to the raw value for a pr type with no valid href", () => {
    const result = resolveDisplayValue("pr", "not a url");
    expect(result).toEqual({
      display: "not a url",
      tooltip: "not a url",
      href: null,
      badge: false,
      icon: "pr",
    });
  });

  it("resolves a valid url type with an href and no icon", () => {
    const result = resolveDisplayValue("url", "example.com");
    expect(result).toEqual({
      display: "example.com",
      tooltip: "example.com",
      href: "http://example.com/",
      badge: false,
      icon: null,
    });
  });

  it("falls back to the raw value for a url type with no valid href", () => {
    const result = resolveDisplayValue("url", "   ");
    expect(result).toEqual({
      display: "   ",
      tooltip: "   ",
      href: null,
      badge: false,
      icon: null,
    });
  });

  it("renders a filename type as a badge with the file icon", () => {
    const result = resolveDisplayValue("filename", "src/index.ts");
    expect(result).toEqual({
      display: "src/index.ts",
      tooltip: "src/index.ts",
      href: null,
      badge: true,
      icon: "file",
    });
  });

  it("renders port and code types as a badge with no icon", () => {
    expect(resolveDisplayValue("port", "3000")).toEqual({
      display: "3000",
      tooltip: "3000",
      href: null,
      badge: true,
      icon: null,
    });
    expect(resolveDisplayValue("code", "abc123")).toEqual({
      display: "abc123",
      tooltip: "abc123",
      href: null,
      badge: true,
      icon: null,
    });
  });

  it("renders any other type (e.g. string) with no badge and no icon", () => {
    const result = resolveDisplayValue("string", "hello");
    expect(result).toEqual({
      display: "hello",
      tooltip: "hello",
      href: null,
      badge: false,
      icon: null,
    });
  });
});
