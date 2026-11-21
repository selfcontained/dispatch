import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRunnerRepositorySearch } from "../src/routes/runner-repositories.js";

describe("runner repository selection", () => {
  it("returns the contributor's repo and branch for a fork PR", async () => {
    const app = Fastify();
    const lookup = vi.fn().mockResolvedValue({
      url: "https://github.com/contributor/fork.git",
      branch: "fix",
    });
    const search = vi.fn().mockRejectedValue(new Error("secret from upstream"));
    registerRunnerRepositorySearch(app, {
      listGitHubBranches: vi.fn(),
      lookupGitHubPullRequestHead: lookup,
      searchGitHubRepositories: search,
    });
    try {
      const r = await app.inject({
        url: "/api/v1/runners/rnr_fixture/pull-request-head",
        query: { url: "https://github.com/org/base/pull/12" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        url: "https://github.com/contributor/fork.git",
        branch: "fix",
      });
      expect(lookup).toHaveBeenCalledWith("rnr_fixture", "org", "base", 12);
      const bad = await app.inject({
        url: "/api/v1/runners/rnr_fixture/pull-request-head",
        query: { url: "https://example.com/org/base/pull/12" },
      });
      expect(bad.statusCode).toBe(400);
      expect(lookup).toHaveBeenCalledTimes(1);
      const unavailable = await app.inject({
        url: "/api/v1/runners/rnr_other/repository-search",
        query: { q: "org/base" },
      });
      expect(search).toHaveBeenCalledWith("rnr_other", "org/base");
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.body).not.toContain("secret from upstream");
      expect(
        (await app.inject("/api/v1/runners/repository-search?q=org/base"))
          .statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
