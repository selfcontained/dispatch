import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  engineStatuses,
  findEngineBin,
  missingEngineMessage,
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
    const statuses = await engineStatuses(
      {},
      { PATH: dir, HOME: home },
      [path.join(home, ".local", "bin")]
    );
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
