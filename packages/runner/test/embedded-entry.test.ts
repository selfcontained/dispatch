import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const server = fileURLToPath(
  new URL("../../../apps/server/src/main.ts", import.meta.url)
);
it("keeps the local agent host argument error before server startup", () => {
  const result = spawnSync("bun", [server, "agent-host"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("usage: dispatch agent-host --state <dir>");
  expect(result.stdout).toBe("");
});
