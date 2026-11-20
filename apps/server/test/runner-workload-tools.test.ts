import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitHubRunnerExecutor } from "../src/agents/remote/github-runner-executor.js";
import { runnerGitArgsFor } from "../src/agents/remote/runner.js";
import {
  WorkloadTools,
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
  expect(new Set(bins)).toEqual(new Set([own]));
});

it("points Git's credential helper at the resolved gh", () => {
  expect(runnerGitArgsFor("/home/u/.local/bin/gh")).toContain(
    "credential.https://github.com.helper=!/home/u/.local/bin/gh auth git-credential"
  );
  expect(runnerGitArgsFor("/home/a b/gh")).toContain(
    "credential.https://github.com.helper=!'/home/a b/gh' auth git-credential"
  );
});
