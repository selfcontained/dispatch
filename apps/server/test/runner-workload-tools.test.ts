import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitHubRunnerExecutor } from "../src/agents/remote/github-runner-executor.js";
import { executeStreamedCheckoutCommand } from "../src/agents/checkout-command-executor.js";
import { runnerGitArgsFor } from "../src/agents/remote/runner.js";
import {
  WorkloadTools,
  cacheWorkloadPath,
  enterDirectory,
  workloadPathProbe,
  workloadLoginCommand,
  parseWorkloadTools,
  workloadToolLookup,
} from "../src/agents/remote/workload-tools.js";

const execute = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-workload-tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tool(file: string, body = "#!/bin/sh\nexit 0\n") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, { mode: 0o755 });
  return file;
}

it("finds gh through the account's login profile before the fixed path", async () => {
  const home = path.join(root, "home");
  const system = path.join(root, "usr-bin");
  await tool(path.join(system, "gh"));
  const own = await tool(path.join(home, "tools", "gh"));
  // The profile sets PATH, the way ~/.profile adds ~/.local/bin on Ubuntu.
  await writeFile(path.join(home, ".bash_profile"), `PATH="$HOME/tools"\n`);
  const [bin, ...args] = workloadToolLookup("/bin/bash", home, system);
  const { stdout } = await execute(bin!, args, {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  expect(parseWorkloadTools(stdout).gh).toBe(own);

  // Without one of their own, the configured runner PATH still applies.
  await rm(own);
  const fallback = await execute(bin!, args, {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  expect(parseWorkloadTools(fallback.stdout).gh).toBe(path.join(system, "gh"));
});

it("does not expose the configured fallback PATH to the login profile", async () => {
  const home = path.join(root, "home");
  const fallback = path.join(home, ".local", "bin");
  await tool(path.join(fallback, "gh"));
  const own = await tool(path.join(home, "tools", "gh"));
  await writeFile(
    path.join(home, ".bash_profile"),
    'case ":$PATH:" in *":$HOME/.local/bin:"*) PATH="$HOME/.local/bin:$HOME/tools";; *) PATH="$HOME/tools";; esac\n'
  );
  const env = { HOME: home, PATH: fallback };
  const [bin, ...args] = workloadToolLookup("/bin/bash", home, fallback);
  expect(
    parseWorkloadTools((await execute(bin!, args, { env })).stdout).gh
  ).toBe(own);

  const [session, ...sessionArgs] = workloadLoginCommand(
    ["/bin/sh", "-c", "command -v gh"],
    "/bin/bash",
    home,
    fallback
  );
  expect((await execute(session!, sessionArgs, { env })).stdout.trim()).toBe(
    own
  );
});

it("direct checkout exec uses and caches the login-only workload PATH", async () => {
  const home = path.join(root, "home");
  await tool(
    path.join(home, "tools", "checkout-probe"),
    "#!/bin/sh\nexit 23\n"
  );
  const profile = path.join(home, ".bash_profile");
  await writeFile(profile, 'export PATH="$HOME/tools"\n');
  const [bin, ...args] = workloadLoginCommand(
    workloadPathProbe,
    "/bin/bash",
    home,
    "/usr/bin:/bin"
  );
  let probes = 0;
  const loginPath = cacheWorkloadPath(async () => {
    probes++;
    return (
      await execute(bin!, args, { env: { HOME: home, PATH: "/usr/bin:/bin" } })
    ).stdout;
  });
  const state = createHash("sha256")
    .update(
      JSON.stringify(["session", "effective", root, root, "guard", "data"])
    )
    .digest("hex");
  const options = {
    shell: "direct",
    timeoutMs: null,
    maxOutput: null,
    env: {},
    stdout: "out",
    stderr: "err",
  } as const;
  const run = async () =>
    executeStreamedCheckoutCommand(
      root,
      "session",
      {
        kind: "run",
        checkout: "effective",
        path: "guard",
        state,
        argv: ["checkout-probe"],
      },
      options,
      await loginPath(),
      async () => ({ root, content: "data" })
    );

  expect(await run()).toBe(23);
  await writeFile(profile, 'export PATH="/usr/bin:/bin"\n');
  expect(await run()).toBe(23);
  expect(probes).toBe(1);
});

it("falls back to the system path when the lookup finds nothing", async () => {
  let lookups = 0;
  const tools = new WorkloadTools(async () => {
    lookups++;
    return "Welcome to the host\ndispatch-tool:git=/home/u/.local/bin/git\n";
  });
  expect(await tools.resolve("gh")).toBe("/usr/bin/gh");
  expect(await tools.resolve("git")).toBe("/home/u/.local/bin/git");
  expect(lookups).toBe(1);
  tools.invalidate();
  await tools.resolve("gh");
  expect(lookups).toBe(2);
});

it("does not cache a failed lookup", async () => {
  let lookups = 0;
  const tools = new WorkloadTools(async () => {
    if (++lookups === 1) throw new Error("login shell failed");
    return "dispatch-tool:gh=/home/u/.local/bin/gh\n";
  });
  expect(await tools.resolve("gh")).toBe("/usr/bin/gh");
  expect(await tools.resolve("gh")).toBe("/home/u/.local/bin/gh");
  expect(await tools.resolve("gh")).toBe("/home/u/.local/bin/gh");
  expect(lookups).toBe(2);
});

it("runs GitHub calls with the resolved gh and looks again when it disappears", async () => {
  const own = path.join(root, "own", "gh");
  let lookups = 0;
  const tools = new WorkloadTools(async () => {
    lookups++;
    return `dispatch-tool:gh=${own}\n`;
  });
  const bins: string[] = [];
  const executor = new GitHubRunnerExecutor(
    { HOME: root, PATH: process.env.PATH },
    (bin, args) => {
      bins.push(bin);
      return { bin, args };
    },
    undefined,
    tools
  );
  const { signal } = new AbortController();
  expect(await executor.handle({ type: "status" }, signal)).toMatchObject({
    status: "unavailable",
  });
  await tool(
    own,
    `#!/bin/sh\nprintf 'could not find key "user"\\n' >&2\nexit 1\n`
  );
  expect(await executor.handle({ type: "status" }, signal)).toEqual({
    status: "signed-out",
  });
  expect(lookups).toBe(2);
  // A signed-out read also clears the account's Git credential include.
  expect(new Set(bins.filter((bin) => path.basename(bin) === "gh"))).toEqual(
    new Set([own])
  );
});

it("points Git's credential helper at the resolved gh", () => {
  expect(runnerGitArgsFor("/home/u/.local/bin/gh")).toContain(
    "credential.https://github.com.helper=!/home/u/.local/bin/gh auth git-credential"
  );
  expect(runnerGitArgsFor("/home/a b/gh")).toContain(
    "credential.https://github.com.helper=!'/home/a b/gh' auth git-credential"
  );
});

it("enters the authorized folder only as itself, after privilege is dropped", async () => {
  const base = await realpath(root);
  const folder = path.join(base, "folder");
  const other = path.join(base, "other");
  const sealed = path.join(base, "sealed");
  for (const dir of [folder, other, sealed]) await mkdir(dir);
  const enter = (dir: string) =>
    execute(
      enterDirectory(dir)[0]!,
      [...enterDirectory(dir).slice(1), "pwd", "-P"],
      {
        cwd: "/",
      }
    ).then(
      ({ stdout }) => ({ ran: stdout.trim() }),
      (error: { code: number; stderr: string }) => ({
        code: error.code,
        stderr: error.stderr,
      })
    );

  expect(await enter(folder)).toEqual({ ran: folder });
  // Swapped for a link after it was authorized: another folder, one the
  // account cannot enter, or nothing there at all. Nothing runs.
  await rename(folder, path.join(base, "moved"));
  await symlink(other, folder);
  expect(await enter(folder)).toMatchObject({
    code: 125,
    stderr: expect.stringContaining("unavailable to the runner workload"),
  });
  await rm(folder);
  // Root enters any folder; the workload account, as here, cannot.
  if (process.getuid?.() !== 0) {
    await chmod(sealed, 0o000);
    try {
      await symlink(sealed, folder);
      expect(await enter(folder)).toMatchObject({ code: 125 });
      expect(await enter(sealed)).toMatchObject({ code: 125 });
    } finally {
      await chmod(sealed, 0o755);
    }
    await rm(folder);
  }
  expect(await enter(folder)).toMatchObject({ code: 125 });
});
