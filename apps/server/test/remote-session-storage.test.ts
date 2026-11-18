import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareScratchSession } from "../src/agents/remote/session-storage.js";
import {
  MANAGED_WORKSPACE,
  remotePlacement,
  workspaceLocator,
} from "../src/agents/remote/protocol.js";

it("round trips the reserved workspace and recognizes its encoded form", () => {
  const placement = { runner: "test", workspace: MANAGED_WORKSPACE };
  expect(workspaceLocator(placement)).toBe("runner://test/@session");
  expect(remotePlacement("runner://test/@session")).toEqual(placement);
  expect(remotePlacement("runner://test/%40session")).toEqual(placement);
});

it("gives each session private scratch storage and reuses it when restarted", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dispatch-runner-session-")
  );
  try {
    const uid = process.getuid!();
    const gid = process.getgid!();
    const first = await prepareScratchSession(root, "first", uid, gid);
    const second = await prepareScratchSession(root, "second", uid, gid);
    expect(first).not.toBe(second);
    expect((await stat(first)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(first, "marker"), "session data");
    expect(await prepareScratchSession(root, "first", uid, gid)).toBe(first);
    expect(await readFile(path.join(first, "marker"), "utf8")).toBe(
      "session data"
    );
    await expect(readFile(path.join(second, "marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
