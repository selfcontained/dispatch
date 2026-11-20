import { loginShellCommand } from "../acp/host-command.js";
import { withToolSearchPath } from "../../shared/lib/tool-environment.js";

export type WorkloadTool = "gh" | "git";

/** Used only when the workload account's own environment has no such tool. */
export const systemTools: Record<WorkloadTool, string> = {
  gh: "/usr/bin/gh",
  git: "/usr/bin/git",
};

const marker = "dispatch-tool:";
const lookupScript = `for tool do p=$(command -v "$tool" 2>/dev/null) && [ -x "$p" ] && case $p in /*) printf '${marker}%s=%s\\n' "$tool" "$p";; esac; done; exit 0`;

/**
 * One command that prints where the workload account's login environment
 * finds each tool. It is the same login shell an agent session starts
 * through, with the same tool-search fallbacks appended after its PATH.
 */
export function workloadToolLookup(
  shell: string,
  home: string,
  fallbackPath: string
): string[] {
  const { PATH } = withToolSearchPath({ HOME: home, PATH: fallbackPath });
  const login = loginShellCommand(
    [
      "/bin/sh",
      "-c",
      lookupScript,
      "dispatch-tool-lookup",
      ...(Object.keys(systemTools) as WorkloadTool[]),
    ],
    shell,
    PATH
  );
  return [login.bin, ...login.args];
}

/** Profile scripts may print their own output; only marked lines count. */
export function parseWorkloadTools(
  output: string
): Partial<Record<WorkloadTool, string>> {
  const found: Partial<Record<WorkloadTool, string>> = {};
  for (const line of output.split("\n")) {
    const match = /^dispatch-tool:(gh|git)=(\/[^\0\r]*)$/.exec(line.trimEnd());
    if (match) found[match[1] as WorkloadTool] ??= match[2];
  }
  return found;
}

/** A command failed because its executable is not there. */
export function missingExecutable(error: unknown): boolean {
  const { code, stderr } = (error ?? {}) as {
    code?: string | number;
    stderr?: unknown;
  };
  return (
    code === "ENOENT" ||
    (typeof stderr === "string" &&
      /failed to execute \S+: No such file or directory/.test(stderr))
  );
}

export type WorkloadToolResolver = {
  resolve(tool: WorkloadTool): Promise<string>;
  /** Forget the cached paths so the next call looks again. */
  invalidate(): void;
};

/**
 * Resolves gh and git once per runner process, not per call. A failed
 * lookup is not cached; callers invalidate when a resolved path stops
 * working, and a restart always looks again.
 */
export class WorkloadTools implements WorkloadToolResolver {
  private pending?: Promise<Partial<Record<WorkloadTool, string>>>;

  constructor(private readonly lookup: () => Promise<string>) {}

  async resolve(tool: WorkloadTool): Promise<string> {
    if (!this.pending) {
      const pending = this.lookup().then(parseWorkloadTools);
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    const found = await this.pending.catch(() => ({}) as Record<string, never>);
    return found[tool] ?? systemTools[tool];
  }

  invalidate() {
    this.pending = undefined;
  }
}

/** Fixed system paths: tests and callers without a workload environment. */
export const fixedWorkloadTools: WorkloadToolResolver = {
  resolve: async (tool) => systemTools[tool],
  invalidate() {},
};
