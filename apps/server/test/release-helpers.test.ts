import { describe, expect, it, vi } from "vitest";

import {
  parseGhJson,
  compareSemver,
  currentReleaseBinaryGlob,
  defaultServiceRestartCommand,
  getGitHubRepo,
  createCheckIsAdmin,
  fetchReleaseMetadata,
} from "../src/server/release-helpers.js";

describe("parseGhJson", () => {
  it("parses valid JSON", () => {
    expect(parseGhJson('{"tag":"v1.0.0"}')).toEqual({ tag: "v1.0.0" });
  });

  it("trims whitespace before parsing", () => {
    expect(parseGhJson('  {"ok":true}\n')).toEqual({ ok: true });
  });

  it("throws on empty string", () => {
    expect(() => parseGhJson("")).toThrow("GitHub CLI returned empty output");
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseGhJson("   \n  ")).toThrow(
      "GitHub CLI returned empty output"
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseGhJson("not-json")).toThrow(
      "Failed to parse GitHub CLI output"
    );
  });

  it("parses arrays", () => {
    expect(parseGhJson<string[]>('["a","b"]')).toEqual(["a", "b"]);
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns positive when a > b (major)", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  it("returns negative when a < b (major)", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("compares minor versions", () => {
    expect(compareSemver("1.3.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.3.0")).toBeLessThan(0);
  });

  it("compares patch versions", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("strips leading v prefix", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
    expect(compareSemver("v2.0.0", "v1.0.0")).toBeGreaterThan(0);
  });

  it("handles versions with different segment counts", () => {
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("1.2.1", "1.2")).toBeGreaterThan(0);
  });
});

describe("currentReleaseBinaryGlob", () => {
  it("returns a glob matching the current platform and arch", () => {
    const glob = currentReleaseBinaryGlob();
    expect(glob).toMatch(
      /^dist\/bun\/dispatch-\*-bun-(darwin|linux)-(arm64|x64)$/
    );
  });
});

describe("defaultServiceRestartCommand", () => {
  it("returns a platform-specific restart command", () => {
    const cmd = defaultServiceRestartCommand();
    if (process.platform === "linux") {
      expect(cmd).toBe("systemctl --user restart dispatch");
    } else {
      expect(cmd).toContain("launchctl kickstart");
    }
  });
});

describe("getGitHubRepo", () => {
  it("extracts owner/repo from HTTPS remote URL", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://github.com/selfcontained/dispatch.git\n",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo(runCommand, "/srv");
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("extracts owner/repo from SSH remote URL", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "git@github.com:selfcontained/dispatch.git\n",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo(runCommand, "/srv");
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("handles HTTPS URL without .git suffix", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://github.com/owner/repo",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo(runCommand, "/srv");
    expect(repo).toBe("owner/repo");
  });

  it("falls back to selfcontained/dispatch when git fails", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("not a repo"));
    const repo = await getGitHubRepo(runCommand, "/srv");
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("falls back to selfcontained/dispatch when URL has no match", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://gitlab.com/some/other",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo(runCommand, "/srv");
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("passes the correct cwd to git command", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://github.com/a/b.git",
      stderr: "",
      exitCode: 0,
    });
    await getGitHubRepo(runCommand, "/my/server");
    expect(runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/my/server",
      "remote",
      "get-url",
      "origin",
    ]);
  });
});

describe("createCheckIsAdmin", () => {
  it("returns true when viewerPermission is ADMIN", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 }) // gh --version
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      }) // git remote
      .mockResolvedValueOnce({
        stdout: "ADMIN\n",
        exitCode: 0,
      }); // gh repo view
    const checkIsAdmin = createCheckIsAdmin(runCommand, "/srv");
    expect(await checkIsAdmin()).toBe(true);
  });

  it("returns false when viewerPermission is not ADMIN", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: "WRITE\n", exitCode: 0 });
    const checkIsAdmin = createCheckIsAdmin(runCommand, "/srv");
    expect(await checkIsAdmin()).toBe(false);
  });

  it("returns false when gh CLI is not available", async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValue(new Error("command not found"));
    const checkIsAdmin = createCheckIsAdmin(runCommand, "/srv");
    expect(await checkIsAdmin()).toBe(false);
  });

  it("returns false when repo view fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockRejectedValueOnce(new Error("auth required"));
    const checkIsAdmin = createCheckIsAdmin(runCommand, "/srv");
    expect(await checkIsAdmin()).toBe(false);
  });
});

describe("fetchReleaseMetadata", () => {
  it("returns release metadata on success", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tagName: "v1.0.0",
          publishedAt: "2026-01-01T00:00:00Z",
          url: "https://github.com/selfcontained/dispatch/releases/tag/v1.0.0",
          body: "  Release notes  ",
        }),
        exitCode: 0,
      });
    const result = await fetchReleaseMetadata(runCommand, "/srv", "v1.0.0");
    expect(result).toEqual({
      tag: "v1.0.0",
      publishedAt: "2026-01-01T00:00:00Z",
      url: "https://github.com/selfcontained/dispatch/releases/tag/v1.0.0",
      body: "Release notes",
    });
  });

  it("trims whitespace from body", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tagName: "v1.0.0",
          publishedAt: "2026-01-01T00:00:00Z",
          url: "https://example.com",
          body: "\n  notes\n  ",
        }),
        exitCode: 0,
      });
    const result = await fetchReleaseMetadata(runCommand, "/srv", "v1.0.0");
    expect(result?.body).toBe("notes");
  });

  it("returns null body when body is not a string", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tagName: "v1.0.0",
          publishedAt: "2026-01-01T00:00:00Z",
          url: "https://example.com",
          body: null,
        }),
        exitCode: 0,
      });
    const result = await fetchReleaseMetadata(runCommand, "/srv", "v1.0.0");
    expect(result?.body).toBeNull();
  });

  it("returns null when gh command fails", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await fetchReleaseMetadata(runCommand, "/srv", "v1.0.0");
    expect(result).toBeNull();
  });

  it("passes the correct tag to gh release view", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "https://github.com/selfcontained/dispatch.git\n",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tagName: "v2.5.0",
          publishedAt: "2026-06-01T00:00:00Z",
          url: "https://example.com",
        }),
        exitCode: 0,
      });
    await fetchReleaseMetadata(runCommand, "/srv", "v2.5.0");
    expect(runCommand).toHaveBeenCalledWith("gh", [
      "release",
      "view",
      "v2.5.0",
      "--repo",
      "selfcontained/dispatch",
      "--json",
      "tagName,publishedAt,url,body",
    ]);
  });
});
