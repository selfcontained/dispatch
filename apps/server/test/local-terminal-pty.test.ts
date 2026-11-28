import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchRunner } from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import {
  pathFromWire,
  runnerIdFromWire,
} from "@dispatch/runner-protocol/contract";
import { embeddedBuild } from "../src/agents/build-identity.js";
import { terminalBackendFor } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";

it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "runs a real terminal in the child and reaps its shell and job on channel close and lifeline EOF",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "local-terminal-pty-"));
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const { version, revision } = embeddedBuild;
    const build = { version, ...(revision && { revision }) };
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const runner = new LocalRunnerSession({
      description: {
        runnerId: runnerIdFromWire("local"),
        displayName: "Local",
        build,
        protocol: 1,
        engines: [],
        capabilities: {},
      },
    });
    const isLive = (pid: number) => {
      try {
        return !execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .startsWith("Z");
      } catch {
        return false;
      }
    };
    const pids = new Set<number>();
    let child: Awaited<ReturnType<typeof launchRunner>> | undefined;
    try {
      await mkdir(workspace);
      for (const profile of [".zshrc", ".bash_profile", ".profile"]) {
        await writeFile(join(root, profile), "printf '\\nT21_READY\\n'\n");
      }
      child = await launchRunner({
        command: [
          process.env.BUN_BINARY ?? "bun",
          "--no-env-file",
          entry,
          "local-runner",
        ],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SHELL: userInfo().shell ?? "/bin/sh",
          USER: userInfo().username,
          TMPDIR: process.env.TMPDIR,
          DISPATCH_STATE_DIR: state,
        },
        start: {
          build,
          roots: { state, files: root },
          config: { runnerId: "local", displayName: "Local", engines: [] },
        },
      });
      runner.setEndpoint(child.ready);
      await runner.call("runner.describe", {});
      const backend = terminalBackendFor(
        { child: () => runner },
        {
          id: "agent",
          cwd: state,
          worktreePath: null,
          workspacePath: workspace,
          placement: controllerPlacement,
        }
      );
      const open = async () => {
        let output = "";
        const terminal = await backend(
          (data) => {
            output += Buffer.from(data).toString();
            for (const match of output.matchAll(
              /PTY_(?:SHELL|JOB)=(\d+)[\r\n]/g
            ))
              pids.add(Number(match[1]));
          },
          () => {
            throw new Error("Unexpected full input buffer");
          }
        );
        expect(terminal.cwd).toBe(await realpath(workspace));
        const readOutput = () => output;
        await expect.poll(readOutput).toContain("T21_READY");
        return { terminal, output: readOutput };
      };

      const first = await open();
      first.terminal.terminal.resize(91, 37);
      first.terminal.terminal.write("stty size\n");
      await expect.poll(first.output, { timeout: 5000 }).toMatch(/37 91[\r\n]/);
      first.terminal.terminal.write(
        "sleep 300 &\necho PTY_SHELL=$$\necho PTY_JOB=$!\n"
      );
      await expect.poll(() => pids.size).toBe(2);
      const firstPids = [...pids];
      const parent = execFileSync(
        "/bin/ps",
        ["-o", "ppid=", "-p", String(firstPids[0])],
        { encoding: "utf8" }
      );
      expect(Number(parent.trim())).toBe(child.pid);
      expect(firstPids.every(isLive)).toBe(true);

      await child.fence(true, 3000);
      await expect(
        runner.open("terminal.open", {
          target: { path: pathFromWire(workspace) },
          cols: 80,
          rows: 24,
        })
      ).rejects.toMatchObject({ code: "fenced" });
      first.terminal.terminal.write("printf '\\nFENCE_%s\\n' ALIVE\n");
      await expect.poll(first.output).toContain("FENCE_ALIVE");
      first.terminal.kill();
      await expect.poll(() => firstPids.filter(isLive)).toEqual([]);

      await child.fence(false, 3000);
      const exited = await open();
      exited.terminal.terminal.write("exit 7\n");
      await expect(exited.terminal.exited).resolves.toBe(7);

      const second = await open();
      second.terminal.terminal.write(
        "sleep 300 &\necho PTY_SHELL=$$\necho PTY_JOB=$!\n"
      );
      await expect.poll(() => pids.size).toBe(4);
      expect([...pids].filter(isLive)).toHaveLength(2);
      expect(await child.close(3000)).toEqual({ code: 0, signal: null });
      await expect(second.terminal.exited).resolves.toBeNull();
      await expect.poll(() => [...pids].filter(isLive)).toEqual([]);
      expect(isLive(child.pid)).toBe(false);
    } finally {
      runner.close();
      await child?.close(3000);
      for (const pid of pids) if (isLive(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }
);
