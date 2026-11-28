import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitHubRunnerExecutor } from "../src/workload/agents/remote/github-runner-executor.js";

it("preserves the shell's custom gh configuration directory without creating another login store", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gh-store-"));
  try {
    const config = join(root, "custom-gh");
    await mkdir(config);
    const marker = join(config, "hosts.yml");
    await writeFile(marker, "fixture-only\n");
    const gh = join(root, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
printf '%s' "$GH_CONFIG_DIR" > "$HOME/observed"
printf 'could not find key "user"\\n' >&2
exit 1
`,
      { mode: 0o755 }
    );
    const executor = new GitHubRunnerExecutor(
      { HOME: root, PATH: process.env.PATH, GH_CONFIG_DIR: config },
      (bin, args) => ({ bin, args }),
      undefined,
      { resolve: async (tool) => (tool === "gh" ? gh : "git"), invalidate() {} }
    );
    expect(
      await executor.handle({ type: "status" }, new AbortController().signal)
    ).toEqual({ status: "signed-out" });
    expect(await readFile(join(root, "observed"), "utf8")).toBe(config);
    expect(await readFile(marker, "utf8")).toBe("fixture-only\n");
    await expect(
      readFile(join(root, ".config/gh/hosts.yml"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
