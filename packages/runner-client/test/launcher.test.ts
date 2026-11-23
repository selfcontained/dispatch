import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseServiceFrame } from "@dispatch/runner-protocol";
import { operations } from "@dispatch/runner-protocol/contract";
import {
  launchRunner,
  launcherSurface,
  LauncherError,
} from "../src/launcher/index.js";

describe("launcher channel (E8)", () => {
  it("launcher-surface.json is the committed launcher schema; regenerate with `pnpm --filter @dispatch/runner-client surface`", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../launcher-surface.json", import.meta.url), "utf8")
    );
    expect(launcherSurface()).toEqual(committed);
  });

  it("has exactly start/ready, freeze/thaw with their fence answer, import with its imported answer and the EOF lifeline", () => {
    const surface = launcherSurface();
    expect(Object.keys(surface.toRunner).sort()).toEqual([
      "freeze",
      "import",
      "start",
      "thaw",
    ]);
    expect(Object.keys(surface.fromRunner).sort()).toEqual([
      "fence",
      "imported",
      "ready",
    ]);
    expect(surface.lifeline).toBe("eof");
  });

  it("reports a program that cannot start instead of throwing", async () => {
    const error = await launchRunner({
      command: ["/nonexistent/runner-binary", "local-runner"],
      env: {},
      start: {
        build: { version: "0" },
        roots: { state: "/nonexistent", files: "/nonexistent" },
        config: { runnerId: "r", displayName: "R", engines: [] },
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LauncherError);
    expect((error as LauncherError).reason).toBe("exited");
  });
});

describe("binding import is launcher-only", () => {
  const bindings = [
    { session: "s", path: "/tmp/x", currentPath: null, worktree: null },
  ];

  it("no operation of the wire contract imports, adopts or binds a path", () => {
    expect(
      Object.keys(operations).filter((name) => /import|adopt|bind/i.test(name))
    ).toEqual([]);
  });

  it("the TLS/v1 service frame refuses an import command", () => {
    for (const kind of ["import", "launcher.import", "adopt"])
      expect(
        parseServiceFrame({
          type: "request",
          id: "r",
          command: { workspace: "w", agentId: "s", kind, bindings },
        })
      ).toBeNull();
  });
});
