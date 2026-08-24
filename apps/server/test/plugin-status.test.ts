import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPluginUpdate,
  checkPluginStatus,
} from "../src/shared/plugin-status.js";
import type { RunCommandResult } from "../src/shared/lib/run-command.js";

type Call = { command: string; args: string[] };

/** Builds a fake CommandRunner from an ordered queue of canned results, recording every call. */
function fakeRunner(
  responses: Array<
    | RunCommandResult
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
const fail = (stderr = "boom"): RunCommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

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

    it("fails open (not installed / no update) if `plugin list` exits non-zero", async () => {
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
    it("runs claude's ordered commands (marketplace update THEN plugin update) and re-checks", async () => {
      await writeManifest(tmpRoot, ".claude-plugin", "0.2.0");
      const { runner, calls } = fakeRunner([
        ok(""), // marketplace update
        ok(""), // plugin update -y
        ok(
          JSON.stringify([
            { id: "dispatch@dispatch", version: "0.2.0", enabled: true },
          ])
        ), // re-check: plugin list
        ok(""), // re-check: marketplace update
        ok(JSON.stringify([{ name: "dispatch", installLocation: tmpRoot }])), // re-check: marketplace list
      ]);
      const result = await applyPluginUpdate("claude", "claude", runner);
      expect(result.error).toBeNull();
      expect(result.status.currentVersion).toBe("0.2.0");
      expect(result.status.updateAvailable).toBe(false);
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
        ok(JSON.stringify({ upgradedRoots: [] })), // re-check: marketplace upgrade
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
      const addIndex = calls.findIndex((c) => c.args[1] === "add");
      const upgradeIndex = calls.findIndex(
        (c) => c.args.includes("upgrade") && c === calls[0]
      );
      expect(upgradeIndex).toBeLessThan(addIndex);
    });

    it("surfaces the error and still returns a re-checked status when the marketplace refresh fails", async () => {
      const { runner } = fakeRunner([
        fail("network unreachable"), // marketplace update fails
        fail(), // re-check: plugin list (unrelated failure — fails open)
      ]);
      const result = await applyPluginUpdate("claude", "claude", runner);
      expect(result.error).toBe("network unreachable");
      expect(result.status.installed).toBe(false);
    });
  });
});
