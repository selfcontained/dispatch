import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WRAPPER = path.join(REPO_ROOT, "bin", "dispatch-launchd-wrapper");
const roots: string[] = [];

function makeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy launchd compatibility wrapper", () => {
  it("starts the exact checked-out tag binary, never the newest-mtime match", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-wrapper-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const dist = path.join(root, "dist", "bun");
    const fakePath = path.join(root, "fake-path");
    const home = path.join(root, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    mkdirSync(fakePath, { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(WRAPPER, path.join(bin, "dispatch-launchd-wrapper"));
    chmodSync(path.join(bin, "dispatch-launchd-wrapper"), 0o755);

    makeExecutable(
      path.join(dist, "dispatch-1.2.3-bun-darwin-arm64"),
      "#!/bin/sh\nprintf exact-tag\n"
    );
    // This is deliberately a different matching name. The former wrapper
    // chose it if its tar timestamp happened to be newer.
    makeExecutable(
      path.join(dist, "dispatch-9.9.9-bun-darwin-arm64"),
      "#!/bin/sh\nprintf wrong-mtime\n"
    );
    makeExecutable(
      path.join(root, "not-yet-migrated"),
      "#!/bin/sh\nprintf wrong-fixed-runtime\n"
    );
    makeExecutable(
      path.join(fakePath, "uname"),
      '#!/bin/sh\nif [ "$1" = "-m" ]; then echo arm64; else echo Darwin; fi\n'
    );

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Dispatch test"], {
      cwd: root,
    });
    writeFileSync(path.join(root, "release-marker"), "v1.2.3\n");
    execFileSync("git", ["add", "release-marker"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "release"], { cwd: root });
    execFileSync("git", ["tag", "v1.2.3"], { cwd: root });

    const output = execFileSync(
      "zsh",
      [path.join(bin, "dispatch-launchd-wrapper")],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakePath}:${process.env.PATH}`,
          DISPATCH_RUNTIME_PATH: path.join(root, "not-yet-migrated"),
        },
        encoding: "utf8",
      }
    );
    expect(output).toBe("exact-tag");
  });
});
