import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRunnerRepositorySearch } from "../src/routes/runner-repositories.js";
import { installRunnerCommand } from "../src/routes/runner-installer.js";

describe("runner repository selection", () => {
  it("returns the contributor's repo and branch for a fork PR", async () => {
    const app = Fastify();
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://github.com/contributor/fork.git",
        branch: "fix",
      }),
      stderr: "",
      exitCode: 0,
    });
    registerRunnerRepositorySearch(app, run);
    try {
      const r = await app.inject({
        url: "/api/v1/runners/pull-request-head",
        query: { url: "https://github.com/org/base/pull/12" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        url: "https://github.com/contributor/fork.git",
        branch: "fix",
      });
      expect(run.mock.calls[0]?.[1]).toContain("repos/org/base/pulls/12");
      const bad = await app.inject({
        url: "/api/v1/runners/pull-request-head",
        query: { url: "https://example.com/org/base/pull/12" },
      });
      expect(bad.statusCode).toBe(400);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("only builds install instructions for release tags", () => {
    expect(() => installRunnerCommand("main")).toThrow();
    const command = installRunnerCommand("v1.2.3");
    expect(command).toContain("tag=v1.2.3");
    expect(command.indexOf("gh attestation verify")).toBeLessThan(
      command.indexOf("sudo bash")
    );
  });
});
