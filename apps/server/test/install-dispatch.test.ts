import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("install-dispatch systemd unit", () => {
  it("keeps tmux-backed agents alive when Dispatch restarts", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain("KillMode=process");
  });

  it("gives the macOS service longer than launchd's default to shut down", async () => {
    // The shutdown budget is archives 10 s, in-flight deliveries 5 s,
    // harness reconcile 2 s and the harness stop ladder 7 s: past launchd's
    // 20 s default, at which point it SIGKILLs the server mid-teardown and
    // the engine children survive as orphans.
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain("<key>ExitTimeOut</key><integer>30</integer>");
  });

  it("does not add a shell-environment marker to either service", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).not.toContain("DISPATCH_SHELL_ENV");
  });

  it("requires existing Linux services to adopt the safe kill mode before update", async () => {
    const migration = await readFile(
      path.join(
        REPO_ROOT,
        "update-migrations",
        "0011-agent-restart-safety.yaml"
      ),
      "utf8"
    );
    expect(migration).toContain("KillMode=process");
    expect(migration).toContain("Before invoking the managed update");
  });
});
