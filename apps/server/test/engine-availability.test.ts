import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  engineStatuses,
  engineVersion,
  findEngineBin,
  missingEngineMessage,
  withEngineVersions,
} from "../src/agents/engine-availability.js";

let dir: string;
let home: string;

const put = (at: string, name: string, mode: number): string => {
  const file = path.join(at, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return file;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-engines-"));
  home = mkdtempSync(path.join(os.tmpdir(), "dispatch-engines-home-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("findEngineBin", () => {
  it("finds an executable on PATH and ignores one that is not executable", async () => {
    const claude = put(dir, "claude", 0o755);
    put(dir, "codex", 0o644);
    const env = { PATH: dir, HOME: home };
    expect(await findEngineBin("claude", env, [])).toBe(claude);
    expect(await findEngineBin("codex", env, [])).toBeNull();
  });

  it("falls back to the usual install locations when PATH has nothing", async () => {
    const local = path.join(home, ".local", "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(local, { recursive: true });
    const codex = put(local, "codex", 0o755);
    expect(
      await findEngineBin("codex", { PATH: "", HOME: home }, [local])
    ).toBe(codex);
  });

  it("passes over a package's node_modules/.bin, which a package manager puts first on PATH", async () => {
    const { mkdirSync } = await import("node:fs");
    // The shape `pnpm run` gives a dev server: the repo's bin dir, where
    // codex-acp's own @openai/codex lands, ahead of the real install.
    const shimDir = path.join(dir, "repo", "node_modules", ".bin");
    const realDir = path.join(dir, "real-bin");
    mkdirSync(shimDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    put(shimDir, "codex", 0o755);
    const real = put(realDir, "codex", 0o755);
    const env = {
      PATH: [shimDir + "/", shimDir, realDir].join(path.delimiter),
      HOME: home,
    };
    expect(await findEngineBin("codex", env, [])).toBe(real);
    // Nothing but the shim: not installed, rather than the dependency.
    expect(
      await findEngineBin("codex", { PATH: shimDir, HOME: home }, [])
    ).toBeNull();
    // Configured by absolute path, it is still honoured.
    const shim = path.join(shimDir, "codex");
    expect(await findEngineBin(shim, { PATH: "", HOME: home }, [])).toBe(shim);
  });

  it("takes the newest release when several install locations have the CLI", async () => {
    const { mkdirSync } = await import("node:fs");
    const brew = path.join(dir, "brew-bin");
    const nvmOld = path.join(dir, "nvm", "v20", "bin");
    const nvmNew = path.join(dir, "nvm", "v22", "bin");
    for (const d of [brew, nvmOld, nvmNew]) mkdirSync(d, { recursive: true });
    const versions: Record<string, string> = {
      [path.join(brew, "codex")]: "0.154.0",
      [path.join(nvmOld, "codex")]: "0.150.2",
      [path.join(nvmNew, "codex")]: "0.155.1",
    };
    for (const file of Object.keys(versions))
      put(path.dirname(file), "codex", 0o755);
    const version = async (bin: string) => versions[bin] ?? null;
    const env = { PATH: "", HOME: home };
    expect(
      await findEngineBin("codex", env, [brew, nvmOld, nvmNew], version)
    ).toBe(path.join(nvmNew, "codex"));
    // A CLI that will not say its version loses to one that does; equal
    // versions keep the list's order.
    expect(
      await findEngineBin("codex", env, [nvmNew, brew], async (bin) =>
        bin.startsWith(nvmNew) ? null : "0.1.0"
      )
    ).toBe(path.join(brew, "codex"));
    expect(
      await findEngineBin("codex", env, [brew, nvmNew], async () => "1.0.0")
    ).toBe(path.join(brew, "codex"));
  });

  it("never returns a relative path", async () => {
    // A relative PATH entry or configured path resolves against whatever
    // cwd the adapter runs in; the adapter needs an absolute one.
    const env = { PATH: `.${path.delimiter}bin`, HOME: home };
    expect(await findEngineBin("claude", env, [])).toBeNull();
    expect(await findEngineBin("./claude", env, [])).toBeNull();
  });

  it("takes an absolute path as given", async () => {
    const claude = path.join(dir, "claude");
    expect(await findEngineBin(claude, { PATH: "", HOME: home }, [])).toBe(
      claude
    );
    expect(
      await findEngineBin("/nope/not/here", { PATH: "", HOME: home }, [])
    ).toBeNull();
  });
});

describe("engineStatuses", () => {
  it("reports each engine, where it is, and how to install a missing one", async () => {
    const statuses = await engineStatuses({}, { PATH: dir, HOME: home }, [
      path.join(home, ".local", "bin"),
    ]);
    expect(statuses.map((s) => s.id)).toEqual(["claude", "codex"]);
    const claude = statuses.find((s) => s.id === "claude")!;
    expect(claude).toMatchObject({
      label: "Claude Code",
      installed: true,
      path: path.join(dir, "claude"),
    });
    // Not executable on PATH, and the home fallback has it.
    const codex = statuses.find((s) => s.id === "codex")!;
    expect(codex.installed).toBe(true);
  });

  it("says what is missing and how to get it", async () => {
    const statuses = await engineStatuses(
      {},
      { PATH: "/nowhere", HOME: "/nowhere" },
      []
    );
    expect(statuses.every((s) => !s.installed)).toBe(true);
    expect(missingEngineMessage(statuses[0]!)).toBe(
      "Claude Code is not installed on this machine. Install it with `npm i -g @anthropic-ai/claude-code` and sign in, then try again."
    );
  });
});

describe("engineVersion", () => {
  const cli = (name: string, output: string, code = 0): string => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho '${output}'\nexit ${code}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("reads the number out of each CLI's own --version line", async () => {
    expect(await engineVersion(cli("v-codex", "codex-cli 0.155.1"))).toBe(
      "0.155.1"
    );
    expect(await engineVersion(cli("v-claude", "2.1.280 (Claude Code)"))).toBe(
      "2.1.280"
    );
  });

  it("is null when the CLI fails or is not there", async () => {
    expect(await engineVersion(cli("v-broken", "boom", 1))).toBeNull();
    expect(await engineVersion(path.join(dir, "nope"))).toBeNull();
  });

  it("asks only the engines that were found", async () => {
    const asked: string[] = [];
    const statuses = await withEngineVersions(
      [
        {
          id: "claude",
          label: "Claude Code",
          installed: true,
          path: "/x/claude",
          version: null,
          install: "",
        },
        {
          id: "codex",
          label: "Codex",
          installed: false,
          path: null,
          version: null,
          install: "",
        },
      ],
      async (bin) => {
        asked.push(bin);
        return "1.2.3";
      }
    );
    expect(asked).toEqual(["/x/claude"]);
    expect(statuses.map((s) => s.version)).toEqual(["1.2.3", null]);
  });
});
