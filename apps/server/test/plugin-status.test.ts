import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPluginUpdate,
  checkPluginStatus,
  createPluginStatusChecker,
} from "../src/shared/plugin-status.js";
import type { RunCommandResult } from "../src/shared/lib/run-command.js";

type Call = { command: string; args: string[] };

/**
 * Builds a fake CommandRunner from an ordered queue of canned results,
 * recording every call. `fail(...)` throws (rejects), matching the real
 * `runCommand`'s behavior: it rejects on any exit code outside its default
 * `allowedExitCodes: [0]` rather than resolving with a non-zero `exitCode` —
 * a fake that resolved instead would validate a code path production never
 * takes.
 */
function fakeRunner(
  responses: Array<
    | RunCommandResult
    | Error
    | ((call: Call) => RunCommandResult)
    | ((call: Call) => Promise<RunCommandResult>)
  >
) {
  const calls: Call[] = [];
  let i = 0;
  const runner = async (
    command: string,
    args: string[]
  ): Promise<RunCommandResult> => {
    calls.push({ command, args });
    const next = responses[i++];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return await next({ command, args });
    if (!next) throw new Error(`fakeRunner: no response queued for call ${i}`);
    return next;
  };
  return { runner, calls };
}

const ok = (stdout: string): RunCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const fail = (stderr = "boom"): Error =>
  new Error(`Command failed, exitCode=1, stderr=${stderr}`);

async function writeManifest(
  root: string,
  manifestSubdir: ".claude-plugin" | ".codex-plugin",
  version: string
): Promise<void> {
  const dir = path.join(root, "plugins", "dispatch", manifestSubdir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "dispatch", version })
  );
}

describe("plugin-status", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-status-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("checkPluginStatus — claude", () => {
    it("reports not installed when the plugin is absent from `plugin list`", async () => {
      const { runner } = fakeRunner([ok(JSON.stringify([]))]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status).toEqual({
        agentType: "claude",
        installed: false,
        enabled: false,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
      });
    });

    it("detects an available update after refreshing the marketplace snapshot", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: true },
          ])
        ),
        ok(""), // marketplace update
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status).toEqual({
        agentType: "claude",
        installed: true,
        enabled: true,
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        updateAvailable: true,
      });
      // Refresh must run before the marketplace clone is read — this is the
      // ordering the whole feature exists to get right.
      expect(calls[1].args).toEqual([
        "plugin",
        "marketplace",
        "update",
        "dispatch",
      ]);
    });

    it("reports no update when current and latest match", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner } = fakeRunner([
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.2.0", enabled: true },
          ])
        ),
        ok(""),
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status.updateAvailable).toBe(false);
    });

    it("does not nag about an update for a plugin the user disabled", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner } = fakeRunner([
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: false },
          ])
        ),
        ok(""),
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status.enabled).toBe(false);
      expect(status.updateAvailable).toBe(false);
    });

    it("fails open (not installed / no update) if `plugin list` rejects", async () => {
      const { runner } = fakeRunner([fail()]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status.installed).toBe(false);
      expect(status.updateAvailable).toBe(false);
    });

    it("fails open if `plugin list` returns unparseable JSON", async () => {
      const { runner } = fakeRunner([ok("not json")]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status.installed).toBe(false);
      expect(status.updateAvailable).toBe(false);
    });

    it("still reports installed+current when the marketplace refresh fails (best-effort)", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.1.0");
      const { runner } = fakeRunner([
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: true },
          ])
        ),
        fail(), // marketplace update fails
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      const status = await checkPluginStatus("claude", "claude", runner);
      expect(status.installed).toBe(true);
      expect(status.currentVersion).toBe("0.1.0");
      // Refresh failed, but whatever was already on disk is still readable.
      expect(status.latestVersion).toBe("0.1.0");
      expect(status.updateAvailable).toBe(false);
    });
  });

  describe("checkPluginStatus — codex", () => {
    it("reports not installed when absent from `plugin list --json`", async () => {
      const { runner } = fakeRunner([ok(JSON.stringify({ installed: [] }))]);
      const status = await checkPluginStatus("codex", "codex", runner);
      expect(status.installed).toBe(false);
    });

    it("detects an available update via the codex command shapes", async () => {
      await writeManifest(tmpRoot, ".codex-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(
          JSON.stringify({
            installed: [
              {
                pluginId: "dispatch@dispatch",
                version: "0.1.0",
                enabled: true,
              },
            ],
          })
        ),
        ok(JSON.stringify({ upgradedRoots: [tmpRoot] })), // marketplace upgrade --json
        ok(
          JSON.stringify({
            marketplaces: [{ name: "dispatch", root: tmpRoot }],
          })
        ),
      ]);
      const status = await checkPluginStatus("codex", "codex", runner);
      expect(status).toEqual({
        agentType: "codex",
        installed: true,
        enabled: true,
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        updateAvailable: true,
      });
      expect(calls[1].args).toEqual([
        "plugin",
        "marketplace",
        "upgrade",
        "dispatch",
        "--json",
      ]);
    });
  });

  describe("applyPluginUpdate", () => {
    it("runs claude's ordered commands (marketplace update THEN plugin update), skips the re-check's own refresh, and re-checks", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(""), // marketplace update
        ok(""), // plugin update -y
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.2.0", enabled: true },
          ])
        ), // re-check: plugin list
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])), // re-check: marketplace list (no refresh call in between)
      ]);
      const result = await applyPluginUpdate("claude", "claude", runner);
      expect(result.error).toBeNull();
      expect(result.status.currentVersion).toBe("0.2.0");
      expect(result.status.updateAvailable).toBe(false);
      expect(calls).toHaveLength(4);
      expect(calls[0].args).toEqual([
        "plugin",
        "marketplace",
        "update",
        "dispatch",
      ]);
      expect(calls[1].args).toEqual([
        "plugin",
        "update",
        "dispatch@dispatch",
        "-y",
      ]);
      // The re-check's third call is `marketplace list`, not another
      // `marketplace update` — the refresh from call 0 is not repeated.
      expect(calls[3].args).toEqual([
        "plugin",
        "marketplace",
        "list",
        "--json",
      ]);
    });

    it("runs codex's ordered commands (marketplace upgrade THEN plugin add) — never add-only", async () => {
      await writeManifest(tmpRoot, ".codex-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(JSON.stringify({ upgradedRoots: [tmpRoot] })), // marketplace upgrade --json
        ok(""), // plugin add
        ok(
          JSON.stringify({
            installed: [
              {
                pluginId: "dispatch@dispatch",
                version: "0.2.0",
                enabled: true,
              },
            ],
          })
        ), // re-check: plugin list
        ok(
          JSON.stringify({
            marketplaces: [{ name: "dispatch", root: tmpRoot }],
          })
        ), // re-check: marketplace list
      ]);
      const result = await applyPluginUpdate("codex", "codex", runner);
      expect(result.error).toBeNull();
      expect(calls[0].args).toEqual([
        "plugin",
        "marketplace",
        "upgrade",
        "dispatch",
        "--json",
      ]);
      // The ordering trap this feature exists to avoid: `plugin add` must
      // never run without the marketplace upgrade immediately before it.
      expect(calls[1].args).toEqual(["plugin", "add", "dispatch@dispatch"]);
    });

    it("surfaces a curated friendly error (not raw CLI stderr) when the marketplace refresh rejects", async () => {
      const { runner } = fakeRunner([
        fail("network unreachable"), // marketplace update rejects
        ok(JSON.stringify([])), // re-check: plugin list — genuinely not found
      ]);
      const result = await applyPluginUpdate("claude", "claude", runner);
      expect(result.error).toBe("Failed to refresh the dispatch marketplace.");
      expect(result.status.installed).toBe(false);
    });

    it("surfaces a curated friendly error when the install/update step itself rejects", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.1.0");
      const { runner } = fakeRunner([
        ok(""), // marketplace update succeeds
        fail("plugin not found"), // plugin update rejects
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: true },
          ])
        ), // re-check: plugin list
        ok(""), // re-check: marketplace update (refreshed again since the failure happened before the "both steps succeeded" point)
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])), // re-check: marketplace list
      ]);
      const result = await applyPluginUpdate("claude", "claude", runner);
      expect(result.error).toBe("Failed to update the plugin.");
      expect(result.status.currentVersion).toBe("0.1.0");
    });
  });

  describe("createPluginStatusChecker", () => {
    it("caches a successful check and does not re-run the CLI within the TTL", async () => {
      const { runner, calls } = fakeRunner([
        ok(JSON.stringify([])), // claude: not installed
      ]);
      let now = 1_000;
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: runner,
        now: () => now,
      });

      await checker.getStatus("claude");
      now += 60 * 1000; // well within the 1h success TTL
      await checker.getStatus("claude");

      expect(calls).toHaveLength(1);
    });

    it("does not cache a probe failure at the full TTL — a later call retries", async () => {
      const { runner, calls } = fakeRunner([
        fail(), // plugin list rejects — a probe failure, not a real "not installed"
        ok(JSON.stringify([])), // second call succeeds: genuinely not installed
      ]);
      let now = 1_000;
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: runner,
        now: () => now,
      });

      const first = await checker.getStatus("claude");
      expect(first.installed).toBe(false);

      // Well past the short failure TTL, well within the 1h success TTL —
      // this only re-runs if the failure wasn't cached at the full TTL.
      now += 5 * 60 * 1000;
      await checker.getStatus("claude");

      expect(calls).toHaveLength(2);
    });

    it("does not cache 'no update' at the full TTL when resolving the latest version itself failed", async () => {
      // The plugin IS confirmed installed (first call succeeds) — only
      // resolving *which* version is latest fails. That must still count as
      // a probe failure, not a confident "no update", or a transient
      // marketplace-list blip silently hides a real update for an hour.
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: true },
          ])
        ),
        ok(""), // marketplace update (refresh, best-effort)
        fail(), // marketplace list itself fails
        // Queued for the second getStatus() call, once time advances — this
        // time the marketplace list succeeds, so the test can also assert
        // the retry actually recovers a real answer.
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.1.0", enabled: true },
          ])
        ),
        ok(""),
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      let now = 1_000;
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: runner,
        now: () => now,
      });

      const first = await checker.getStatus("claude");
      expect(first.installed).toBe(true);
      expect(first.updateAvailable).toBe(false);

      now += 5 * 60 * 1000; // past the short failure TTL, well within 1h
      const second = await checker.getStatus("claude");

      // Not served from a stale cache — the retry ran (6 calls, not 3) and
      // recovered the real answer.
      expect(calls).toHaveLength(6);
      expect(second.updateAvailable).toBe(true);
    });

    it("does not pin a failed post-update re-check at the full success TTL", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(""), // marketplace update
        ok(""), // plugin update -y
        fail(), // re-check: plugin list fails — the probe most likely to hiccup right after an install
        // Queued for the getStatus() re-probe below, once time advances:
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.2.0", enabled: true },
          ])
        ),
        ok(""),
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])),
      ]);
      let now = 1_000;
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: runner,
        now: () => now,
      });

      const updateResult = await checker.update("claude");
      // Re-check failed → fails open to "not installed", which is exactly
      // the wrong answer this test exists to make sure doesn't get pinned.
      expect(updateResult.status.installed).toBe(false);

      now += 5 * 60 * 1000; // past the 1-minute failure TTL, well within the 1h success TTL
      const status = await checker.getStatus("claude");

      // If the failed re-check had cached at the full success TTL, this call
      // would return the stale "not installed" answer with zero further CLI
      // calls instead of re-probing.
      expect(calls).toHaveLength(6);
      expect(status.installed).toBe(true);
    });

    it("forceRefresh bypasses the cache even within the TTL", async () => {
      const { runner, calls } = fakeRunner([
        ok(JSON.stringify([])),
        ok(JSON.stringify([])),
      ]);
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: runner,
      });

      await checker.getStatus("claude");
      await checker.getStatus("claude", { forceRefresh: true });

      expect(calls).toHaveLength(2);
    });

    it("serializes getStatus and update for the same agentType — never runs CLI commands concurrently", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const trackedRunner = async (
        _command: string,
        _args: string[]
      ): Promise<RunCommandResult> => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return { exitCode: 0, stdout: JSON.stringify([]), stderr: "" };
      };
      const checker = createPluginStatusChecker({
        binFor: () => "claude",
        commandRunner: trackedRunner,
      });

      // A status check and an update fired at the same instant for the same
      // agent type — both do multiple sequential CLI calls internally.
      await Promise.all([
        checker.getStatus("claude", { forceRefresh: true }),
        checker.update("claude"),
      ]);

      expect(maxConcurrent).toBe(1);
    });

    it("does not serialize across different agent types", async () => {
      let claudeRunning = false;
      let codexSawClaudeRunning = false;
      const trackedRunner = async (
        command: string
      ): Promise<RunCommandResult> => {
        if (command === "claude") {
          claudeRunning = true;
          await new Promise((resolve) => setTimeout(resolve, 10));
          claudeRunning = false;
        } else {
          codexSawClaudeRunning = claudeRunning;
        }
        return { exitCode: 0, stdout: JSON.stringify([]), stderr: "" };
      };
      const checker = createPluginStatusChecker({
        binFor: (agentType) => agentType,
        commandRunner: trackedRunner,
      });

      await Promise.all([
        checker.getStatus("claude"),
        checker.getStatus("codex"),
      ]);

      expect(codexSawClaudeRunning).toBe(true);
    });
  });
});
