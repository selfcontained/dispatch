import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

import * as controller from "../src/shared/process/owned-processes.js";
import * as runner from "../../../packages/runner/src/workload/shared/process/owned-processes.js";

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each([
  ["controller", controller],
  ["runner", runner],
] as const)(
  "pins %s host ownership enumeration, revalidation, signals and rescan order",
  (_name, ownership) => {
    const { env, marker } = ownership.ownedEnvironment({ FIXTURE: "yes" });
    expect(env).toEqual({ FIXTURE: "yes", [marker.split("=")[0]!]: "1" });
    const trace: string[] = [];
    let scan = 0;
    const marked = (pid: number) => pid + " fixture " + marker;
    vi.mocked(readFileSync).mockImplementation(() => marker + "\0");
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const query = args as string[];
      if (!query.includes("-p")) {
        trace.push("scan");
        scan++;
        if (scan === 1)
          return [marked(521), "519 unrelated", marked(514), marked(512)].join(
            "\n"
          );
        return scan === 2 ? marked(511) : "";
      }
      const pid = Number(query[query.indexOf("-p") + 1]);
      trace.push("revalidate " + pid);
      return pid === 514 ? "514 reused" : marked(pid);
    });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      trace.push(String(signal) + " " + pid);
      return true;
    });
    ownership.killOwnedProcesses(marker);
    expect(trace).toEqual([
      "scan",
      "revalidate 521",
      "SIGKILL 521",
      "revalidate 514",
      "revalidate 512",
      "SIGKILL 512",
      "scan",
      "revalidate 511",
      "SIGKILL 511",
      "scan",
    ]);
  }
);

vi.mock("../../../packages/runner/src/host/main.js", () => ({
  runAgentHost: vi.fn(),
}));

it("supplies the same pinned ownership functions to the host entry", async () => {
  const { runAgentHost } = await import("@dispatch/runner/cli");
  const { runAgentHost: host } = await import("@dispatch/runner/host/main");
  const args = ["agent-host", "--state", "/fixture"];
  const input = {
    build: { version: "test", revision: null },
    engineVersion: async () => null,
    searchPath: {
      withToolSearchPath: (env: NodeJS.ProcessEnv) => env,
      withEngineBinDir: (current: string | undefined) => current ?? "",
      isPackageBinDir: () => false,
    },
  };
  await runAgentHost(args, input);
  expect(host).toHaveBeenCalledExactlyOnceWith(args, {
    ...input,
    ownership: {
      ownedEnvironment: runner.ownedEnvironment,
      killOwnedProcesses: runner.killOwnedProcesses,
    },
  });
});
