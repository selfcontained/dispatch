import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const packageManager = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
).packageManager as string;
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function build(corepack: boolean, version: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-source-build-"));
  temporary.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  copyFileSync(
    path.join(root, "bin/dispatch-server"),
    path.join(bin, "dispatch-server")
  );
  const stub = (name: string, body: string) =>
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  stub("bun", `printf '%s\\n' '${packageManager}'`);
  stub(
    "pnpm",
    `if [ "$1" = --version ]; then printf '%s\\n' '${version}'; else printf '%s\\n' "pnpm $*" >> "$DISPATCH_BUILD_TEST_LOG"; fi`
  );
  if (corepack)
    stub(
      "corepack",
      'printf "%s\\n" "corepack $*" >> "$DISPATCH_BUILD_TEST_LOG"'
    );
  const log = path.join(dir, "commands.log");
  const result = spawnSync(
    "/bin/bash",
    [path.join(bin, "dispatch-server"), "build"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        DISPATCH_BUILD_TEST_LOG: log,
      },
    }
  );
  return {
    ...result,
    commands:
      result.status === 0 ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

describe("source build package-manager selection", () => {
  it("uses the package.json pin through Corepack even when PATH pnpm is newer", () => {
    const result = build(true, "11.13.0");
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      `corepack ${packageManager} install --frozen-lockfile`,
      `corepack ${packageManager} run build:bun`,
    ]);
  });

  it("allows an exact pinned pnpm when Corepack is absent", () => {
    const result = build(false, packageManager.slice("pnpm@".length));
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run build:bun",
    ]);
  });

  it("rejects another pnpm before installing when Corepack is absent", () => {
    const result = build(false, "11.13.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Source builds require ${packageManager}`);
    expect(result.commands).toEqual([]);
  });
});
