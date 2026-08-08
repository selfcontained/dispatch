import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseGhJson,
  compareSemver,
  defaultServiceRestartCommand,
  getGitHubRepo,
  createCheckIsAdmin,
  fetchReleaseMetadata,
  resolveAuthoringRepoDir,
  createAuthoringRemoteRefresher,
} from "../src/server/release-helpers.js";

describe("createAuthoringRemoteRefresher", () => {
  const okResult = { stdout: "", stderr: "", exitCode: 0 };

  it("coalesces concurrent refreshes into one git fetch", async () => {
    let resolveFetch!: (value: typeof okResult) => void;
    const runCommand = vi.fn(
      () =>
        new Promise<typeof okResult>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const refresher = createAuthoringRemoteRefresher(runCommand);
    const first = refresher.refresh("/srv/authoring");
    const second = refresher.refresh("/srv/authoring");
    resolveFetch(okResult);
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("reuses the last result within the TTL and refetches after it", async () => {
    const runCommand = vi.fn().mockResolvedValue(okResult);
    const refresher = createAuthoringRemoteRefresher(runCommand, { ttlMs: 20 });
    await refresher.refresh("/srv/authoring");
    await refresher.refresh("/srv/authoring");
    expect(runCommand).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await refresher.refresh("/srv/authoring");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("shares a failure within the TTL instead of hammering the remote", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const refresher = createAuthoringRemoteRefresher(runCommand, {
      ttlMs: 60_000,
    });
    const first = await refresher.refresh("/srv/authoring");
    const second = await refresher.refresh("/srv/authoring");
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("tracks checkouts independently and clears on reset", async () => {
    const runCommand = vi.fn().mockResolvedValue(okResult);
    const refresher = createAuthoringRemoteRefresher(runCommand, {
      ttlMs: 60_000,
    });
    await refresher.refresh("/a");
    await refresher.refresh("/b");
    expect(runCommand).toHaveBeenCalledTimes(2);
    refresher.reset();
    await refresher.refresh("/a");
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});

describe("resolveAuthoringRepoDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers DISPATCH_RELEASE_AUTHORING_REPO_DIR when set", () => {
    vi.stubEnv("DISPATCH_RELEASE_AUTHORING_REPO_DIR", "/srv/authoring");
    expect(resolveAuthoringRepoDir("/srv/runtime")).toBe("/srv/authoring");
  });

  it("falls back to serverDir when unset", () => {
    vi.stubEnv("DISPATCH_RELEASE_AUTHORING_REPO_DIR", "");
    expect(resolveAuthoringRepoDir("/srv/runtime")).toBe("/srv/runtime");
  });

  it("falls back to serverDir when whitespace-only", () => {
    vi.stubEnv("DISPATCH_RELEASE_AUTHORING_REPO_DIR", "   ");
    expect(resolveAuthoringRepoDir("/srv/runtime")).toBe("/srv/runtime");
  });
});

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

  it("strips prerelease suffixes instead of producing NaN", () => {
    expect(compareSemver("v1.2.3-rc1", "v1.2.3")).toBe(0);
    expect(compareSemver("v1.2.4-rc1", "v1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.3-rc1", "v1.2.4")).toBeLessThan(0);
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
    const repo = await getGitHubRepo();
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("extracts owner/repo from SSH remote URL", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "git@github.com:selfcontained/dispatch.git\n",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo();
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("uses the configured/default repository without probing git", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://github.com/owner/repo",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo();
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("falls back to selfcontained/dispatch when git fails", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("not a repo"));
    const repo = await getGitHubRepo();
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("falls back to selfcontained/dispatch when URL has no match", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://gitlab.com/some/other",
      stderr: "",
      exitCode: 0,
    });
    const repo = await getGitHubRepo();
    expect(repo).toBe("selfcontained/dispatch");
  });

  it("does not invoke git to discover the repository", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "https://github.com/a/b.git",
      stderr: "",
      exitCode: 0,
    });
    await getGitHubRepo();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("createCheckIsAdmin", () => {
  beforeEach(() => {
    process.env.DISPATCH_RELEASE_AUTHORING = "1";
  });

  it("returns true when viewerPermission is ADMIN", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 }) // gh --version
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
      .mockRejectedValueOnce(new Error("auth required"));
    const checkIsAdmin = createCheckIsAdmin(runCommand, "/srv");
    expect(await checkIsAdmin()).toBe(false);
  });
});

describe("fetchReleaseMetadata", () => {
  it("returns release metadata on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tag_name: "v1.0.0",
              published_at: "2026-01-01T00:00:00Z",
              html_url:
                "https://github.com/selfcontained/dispatch/releases/tag/v1.0.0",
              body: "  Release notes  ",
            })
          )
      )
    );
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
    const result = await fetchReleaseMetadata("v1.0.0");
    expect(result).toEqual({
      tag: "v1.0.0",
      publishedAt: "2026-01-01T00:00:00Z",
      url: "https://github.com/selfcontained/dispatch/releases/tag/v1.0.0",
      body: "Release notes",
    });
  });

  it("trims whitespace from body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tag_name: "v1.0.0",
              published_at: "2026-01-01T00:00:00Z",
              html_url: "https://example.com",
              body: "\n  notes\n  ",
            })
          )
      )
    );
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
    const result = await fetchReleaseMetadata("v1.0.0");
    expect(result?.body).toBe("notes");
  });

  it("returns null body when body is not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tag_name: "v1.0.0",
              published_at: "2026-01-01T00:00:00Z",
              html_url: "https://example.com",
              body: null,
            })
          )
      )
    );
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
    const result = await fetchReleaseMetadata("v1.0.0");
    expect(result?.body).toBeNull();
  });

  it("returns null only when the requested release does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 404 }))
    );
    const result = await fetchReleaseMetadata("v1.0.0");
    expect(result).toBeNull();
  });

  it("preserves GitHub failures other than not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 }))
    );
    await expect(fetchReleaseMetadata("v1.0.0")).rejects.toThrow("503");
  });

  it("requests the correct tag from GitHub Releases", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "v2.5.0",
            published_at: "2026-06-01T00:00:00Z",
            html_url: "https://example.com",
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);
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
    await fetchReleaseMetadata("v2.5.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/selfcontained/dispatch/releases/tags/v2.5.0",
      expect.any(Object)
    );
  });
});
