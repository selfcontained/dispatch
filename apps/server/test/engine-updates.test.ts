import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  chmod,
  rm,
  realpath,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectInstallation,
  LatestVersions,
  updateEngine,
} from "../src/agents/engine-updates.js";
import {
  engineVersion,
  type EngineStatus,
} from "../src/agents/engine-availability.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(extra = "prefix") {
  const home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "engine-update-"))
  );
  dirs.push(home);
  const prefix = path.join(home, extra);
  const file = async (name: string, data: string) => {
    const at = path.join(prefix, name);
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, data, { mode: 0o755 });
    return at;
  };
  await file(
    "lib/node_modules/@openai/codex/package.json",
    JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } })
  );
  const real = await file(
    "lib/node_modules/@openai/codex/bin/codex.js",
    "#!/bin/sh\necho 'codex-cli 1.2.3'\n"
  );
  await file(
    "lib/node_modules/npm/package.json",
    JSON.stringify({ name: "npm" })
  );
  const npm = await file("lib/node_modules/npm/bin/npm-cli.js", "npm");
  await file("bin/node", "node");
  const bin = path.join(prefix, "bin/codex");
  await symlink(real, bin);
  await symlink(npm, path.join(prefix, "bin/npm"));
  const status: EngineStatus = {
    id: "codex",
    label: "Codex",
    installed: true,
    path: bin,
    version: "1.2.3",
    install: "npm i -g @openai/codex",
  };
  return { home, prefix, file, real, bin, status };
}
describe("selected installation", () => {
  it("follows symlinks and verifies package identity and adjacent npm", async () => {
    const f = await fixture();
    const result = await inspectInstallation(f.status, f.home);
    expect(result.source).toBe("npm");
    expect(result.realPath).toBe(f.real);
    expect(result.canUpdate).toBe(true);
    expect(result.run).toMatchObject({
      executable: path.join(f.prefix, "bin/node"),
      args: [
        path.join(f.prefix, "lib/node_modules/npm/bin/npm-cli.js"),
        "install",
        "--global",
        "--prefix",
        f.prefix,
        "@openai/codex@latest",
      ],
    });
  });
  it("leaves version managers, protected prefixes and unwritable targets manual", async () => {
    const f = await fixture(".nvm/versions/node/v22");
    expect((await inspectInstallation(f.status, f.home)).canUpdate).toBe(false);
    const g = await fixture();
    expect(
      (await inspectInstallation(g.status, path.join(g.home, "other-home")))
        .canUpdate
    ).toBe(false);
    await chmod(path.join(g.prefix, "lib/node_modules"), 0o555);
    expect((await inspectInstallation(g.status, g.home)).canUpdate).toBe(false);
    await chmod(path.join(g.prefix, "lib/node_modules"), 0o755);
  });
  it("rejects misleading package prefixes and bin mappings", async () => {
    const f = await fixture();
    await f.file(
      "lib/node_modules/@openai/codex/package.json",
      JSON.stringify({ name: "fake", bin: "bin/codex.js" })
    );
    expect((await inspectInstallation(f.status, f.home)).source).toBe(
      "unknown"
    );
    await f.file(
      "lib/node_modules/@openai/codex/package.json",
      JSON.stringify({ name: "@openai/codex", bin: "other.js" })
    );
    expect((await inspectInstallation(f.status, f.home)).canUpdate).toBe(false);
  });
  it("rejects foreign ownership and world-writable mutation roots", async () => {
    const f = await fixture();
    await chmod(f.prefix, 0o777);
    expect((await inspectInstallation(f.status, f.home)).canUpdate).toBe(false);
    await chmod(f.prefix, 0o755);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect((await inspectInstallation(f.status, f.home)).canUpdate).toBe(false);
  });
  it("does not use an arbitrary PATH npm", async () => {
    const f = await fixture();
    await rm(path.join(f.prefix, "bin/npm"));
    expect((await inspectInstallation(f.status, f.home)).canUpdate).toBe(false);
  });
  it("detects native Claude and Homebrew source without trusting a prefix substring", async () => {
    const f = await fixture();
    const native = path.join(f.home, ".local/share/claude/versions/2.0.0");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "claude", { mode: 0o755 });
    const launcher = path.join(f.home, ".local/bin/claude");
    await mkdir(path.dirname(launcher), { recursive: true });
    await symlink(native, launcher);
    expect(
      await inspectInstallation(
        { ...f.status, id: "claude", path: launcher },
        f.home
      )
    ).toMatchObject({ source: "native", canUpdate: true });
    const brew = await f.file("Caskroom/codex/1.2.3/codex", "codex");
    await rm(f.bin);
    await symlink(brew, f.bin);
    expect(
      await inspectInstallation({ ...f.status, path: f.bin }, f.home)
    ).toMatchObject({
      source: "homebrew-cask",
      latestKey: "unknown:",
      canUpdate: false,
    });
    await f.file("bin/brew", "brew");
    await f.file(
      "Caskroom/codex/.metadata/INSTALL_RECEIPT.json",
      JSON.stringify({
        source: {
          path: "/tap/Casks/codex.json",
          tap: "homebrew/cask",
          version: "1.2.3",
        },
      })
    );
    expect(
      await inspectInstallation({ ...f.status, path: f.bin }, f.home)
    ).toMatchObject({
      source: "homebrew-cask",
      latestKey: "cask:codex",
      canUpdate: true,
      run: { args: ["upgrade", "--cask", "codex"] },
    });
    const formula = await f.file("Cellar/codex/1.2.3/bin/codex", "codex");
    await rm(f.bin);
    await symlink(formula, f.bin);
    await f.file("bin/brew", "brew");
    await f.file(
      "Cellar/codex/1.2.3/INSTALL_RECEIPT.json",
      JSON.stringify({
        source: { path: "/tap/Formula/codex.rb", tap: "homebrew/core" },
      })
    );
    expect(
      await inspectInstallation({ ...f.status, path: f.bin }, f.home)
    ).toMatchObject({
      source: "homebrew-formula",
      latestKey: "formula:codex",
      canUpdate: true,
    });
  });
  it("refreshes stale Homebrew metadata before an explicit upgrade", async () => {
    const f = await fixture();
    vi.spyOn(os, "homedir").mockReturnValue(f.home);
    await f.file("bin/brew", "brew");
    const binary = await f.file(
      "Cellar/codex/1.0.0/bin/codex",
      "#!/bin/sh\necho 'codex-cli 1.0.0'\n"
    );
    await f.file(
      "Cellar/codex/1.0.0/INSTALL_RECEIPT.json",
      JSON.stringify({
        source: { path: "/tap/Formula/codex.rb", tap: "homebrew/core" },
      })
    );
    await rm(f.bin);
    await symlink(binary, f.bin);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ versions: { stable: "2.0.0" } }))
      )
    );
    let refreshed = false;
    const runner = vi.fn(
      async (
        _command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        if (args[0] === "update") {
          expect(options?.env?.HOMEBREW_NO_AUTO_UPDATE).toBeUndefined();
          refreshed = true;
          return { exitCode: 0, stdout: "Metadata refreshed", stderr: "" };
        }
        expect(refreshed).toBe(true);
        await f.file(
          "Cellar/codex/1.0.0/bin/codex",
          "#!/bin/sh\necho 'codex-cli 2.0.0'\n"
        );
        return { exitCode: 0, stdout: "Upgraded Codex", stderr: "" };
      }
    );
    expect(
      await updateEngine(
        "codex",
        {
          codex: f.bin,
          claude: "/missing-claude",
          opencode: "/missing-opencode",
        },
        runner
      )
    ).toMatchObject({
      success: true,
      output: "Metadata refreshed\n\nUpgraded Codex",
      engine: { version: "2.0.0" },
    });
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["update"],
      ["upgrade", "--formula", "codex"],
    ]);
    const failed = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Refresh failed",
    }));
    expect(
      await updateEngine(
        "codex",
        {
          codex: f.bin,
          claude: "/missing-claude",
          opencode: "/missing-opencode",
        },
        failed
      )
    ).toMatchObject({ success: false, output: "Refresh failed" });
    expect(failed).toHaveBeenCalledOnce();
  });
  it("refreshes a replaced symlink even when the target mtime is unchanged", async () => {
    const f = await fixture();
    expect(await engineVersion(f.bin)).toBe("1.2.3");
    const old = await stat(f.real);
    const replacement = await f.file(
      "lib/node_modules/@openai/codex/bin/replacement.js",
      "#!/bin/sh\necho 'codex-cli 9.9.9'\n"
    );
    await utimes(replacement, old.atime, old.mtime);
    await rm(f.bin);
    await symlink(replacement, f.bin);
    expect(await engineVersion(f.bin)).toBe("9.9.9");
  });
  it("recognizes API-loaded cask receipts and qualified third-party formulae", async () => {
    const f = await fixture();
    await f.file("bin/brew", "brew");
    const cask = await f.file("Caskroom/codex/0.159.0/bin/codex", "codex");
    await rm(f.bin);
    await symlink(cask, f.bin);
    await f.file(
      "Caskroom/codex/.metadata/INSTALL_RECEIPT.json",
      JSON.stringify({
        loaded_from_api: true,
        loaded_from_internal_api: true,
        source: {
          tap: "homebrew/cask",
          version: "0.159.0",
          path: "/home/user/Library/Caches/Homebrew/api/internal/packages.arm64_tahoe.jws.json",
        },
        uninstall_artifacts: [{ binary: ["bin/codex"] }],
      })
    );
    expect(
      await inspectInstallation({ ...f.status, path: f.bin }, f.home)
    ).toMatchObject({
      canUpdate: true,
      source: "homebrew-cask",
      latestKey: "cask:codex",
      run: { args: ["upgrade", "--cask", "codex"] },
    });
    const formula = await f.file(
      "Cellar/opencode/1.18.32/bin/opencode",
      "opencode"
    );
    await f.file(
      "Cellar/opencode/1.18.32/INSTALL_RECEIPT.json",
      JSON.stringify({
        source: {
          tap: "anomalyco/tap",
          path: path.join(
            f.prefix,
            "Library/Taps/anomalyco/homebrew-tap/opencode.rb"
          ),
        },
      })
    );
    const opencodeBin = path.join(f.prefix, "bin/opencode");
    await symlink(formula, opencodeBin);
    const thirdParty = await inspectInstallation(
      { ...f.status, id: "opencode", path: opencodeBin },
      f.home
    );
    expect(thirdParty).toMatchObject({
      canUpdate: true,
      source: "homebrew-formula",
      run: { args: ["upgrade", "--formula", "anomalyco/tap/opencode"] },
    });
    await chmod(path.join(f.prefix, "bin"), 0o775);
    await chmod(formula, 0o555);
    expect(
      (
        await inspectInstallation(
          { ...f.status, id: "opencode", path: opencodeBin },
          f.home
        )
      ).canUpdate
    ).toBe(true);
    await chmod(path.dirname(path.dirname(formula)), 0o555);
    expect(
      (
        await inspectInstallation(
          { ...f.status, id: "opencode", path: opencodeBin },
          f.home
        )
      ).canUpdate
    ).toBe(false);
    await chmod(path.dirname(path.dirname(formula)), 0o755);
    expect(
      (
        await inspectInstallation(
          { ...f.status, id: "opencode", path: formula },
          f.home
        )
      ).canUpdate
    ).toBe(false);
    const pinned = path.join(f.home, "custom-opencode");
    await symlink(formula, pinned);
    expect(
      (
        await inspectInstallation(
          { ...f.status, id: "opencode", path: pinned },
          f.home
        )
      ).canUpdate
    ).toBe(false);
    expect(thirdParty.latestKey).toContain('"name":"anomalyco/tap/opencode"');
    // An API receipt cannot authenticate a different binary artifact.
    await f.file(
      "Caskroom/codex/.metadata/INSTALL_RECEIPT.json",
      JSON.stringify({
        loaded_from_api: true,
        source: {
          tap: "homebrew/cask",
          version: "0.159.0",
          path: "/cache/packages.jws.json",
        },
        uninstall_artifacts: [{ binary: ["other-bin"] }],
      })
    );
    expect(
      (await inspectInstallation({ ...f.status, path: f.bin }, f.home))
        .canUpdate
    ).toBe(false);
  });
  it("runs only the revalidated selected installation and refreshes launcher versions", async () => {
    const f = await fixture();
    vi.spyOn(os, "homedir").mockReturnValue(f.home);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = vi.fn(async () => {
      await waiting;
      await f.file(
        "lib/node_modules/@openai/codex/bin/codex.js",
        "#!/bin/sh\necho 'codex-cli 9.9.9'\n"
      );
      return { exitCode: 0, stdout: "Updated", stderr: "" };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "9.9.9" })))
    );
    const first = updateEngine(
      "codex",
      { codex: f.bin, claude: "/no-claude", opencode: "/no-opencode" },
      runner
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    await expect(
      updateEngine(
        "codex",
        { codex: f.bin, claude: "/no-claude", opencode: "/no-opencode" },
        runner
      )
    ).rejects.toThrow("already running");
    finish();
    expect(await first).toMatchObject({
      success: true,
      output: "Updated",
      engine: { version: "9.9.9" },
    });
    const failure = await updateEngine(
      "codex",
      { codex: f.bin, claude: "/no-claude", opencode: "/no-opencode" },
      async () => ({
        exitCode: 1,
        stdout: "failed",
        stderr: "Denied",
      })
    );
    expect(failure).toMatchObject({ success: false, output: "failed\nDenied" });
  });
});
describe("latest metadata", () => {
  it("returns immediately, deduplicates in flight and caches npm/formula/cask versions", async () => {
    let resolve!: (value: Response) => void;
    let now = 0;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        })
    );
    const cache = new LatestVersions(fetcher, () => now);
    expect(cache.get("npm:@openai/codex")).toEqual({
      latestVersion: null,
      latestPending: true,
    });
    cache.get("npm:@openai/codex");
    expect(fetcher).toHaveBeenCalledOnce();
    resolve(new Response(JSON.stringify({ version: "3.0.0" })));
    await vi.waitFor(() =>
      expect(cache.get("npm:@openai/codex").latestVersion).toBe("3.0.0")
    );
    expect(fetcher).toHaveBeenCalledOnce();
    now = 4 * 60 * 60_000;
    cache.get("npm:@openai/codex");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const brewFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ version: "4.0.0", versions: { stable: "5.0.0" } })
        )
    );
    const brew = new LatestVersions(brewFetch);
    brew.get("formula:codex");
    brew.get("cask:codex");
    await vi.waitFor(() => {
      expect(brew.get("formula:codex").latestVersion).toBe("5.0.0");
      expect(brew.get("cask:codex").latestVersion).toBe("4.0.0");
    });
  });
  it("uses bounded asynchronous brew info for third-party formula metadata", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Must not query core registry");
    });
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        formulae: [
          {
            full_name: "anomalyco/tap/opencode",
            versions: { stable: "1.18.32" },
          },
        ],
      }),
      stderr: "",
    }));
    const cache = new LatestVersions(fetcher, Date.now, runner);
    const key = `brew:${JSON.stringify({ executable: "/brew/bin/brew", name: "anomalyco/tap/opencode" })}`;
    expect(cache.get(key)).toEqual({
      latestVersion: null,
      latestPending: true,
    });
    cache.get(key);
    await vi.waitFor(() =>
      expect(cache.get(key).latestVersion).toBe("1.18.32")
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "/brew/bin/brew",
      ["info", "--json=v2", "--formula", "anomalyco/tap/opencode"],
      expect.objectContaining({ timeoutMs: 8000 })
    );
    expect(fetcher).not.toHaveBeenCalled();
    const failed = new LatestVersions(fetcher, Date.now, async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Failed",
    }));
    failed.get(key);
    await vi.waitFor(() =>
      expect(failed.get(key)).toEqual({
        latestVersion: null,
        latestPending: false,
      })
    );
  });
  it("returns unknown on failed lookup without retry storms", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Offline");
    });
    const cache = new LatestVersions(fetcher);
    cache.get("npm:opencode-ai");
    await vi.waitFor(() =>
      expect(cache.get("npm:opencode-ai")).toEqual({
        latestVersion: null,
        latestPending: false,
      })
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
