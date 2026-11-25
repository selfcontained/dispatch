import { loginShellCommand } from "../acp/host-command.js";
import { withToolSearchPath } from "../../shared/lib/tool-environment.js";

export type WorkloadTool = "gh" | "git";

/** Used only when the workload account's own environment has no such tool. */
export const systemTools: Record<WorkloadTool, string> = {
  gh: "/usr/bin/gh",
  git: "/usr/bin/git",
};

/**
 * Enter `dir` as the workload, after privilege is dropped, then run the rest
 * of the command. The physical directory must be `dir` itself: a path swapped
 * for a link since it was authorized, or one the workload cannot enter, runs
 * nothing. The privileged launcher never changes into a workload path.
 */
export function enterDirectory(dir: string): string[] {
  return [
    "/bin/sh",
    "-c",
    'cd -P -- "$1" 2>/dev/null && [ "$(pwd -P)" = "$1" ] || { printf "dispatch: %s is unavailable to the runner workload\\n" "$1" >&2; exit 125; }; shift; exec "$@"',
    "dispatch-enter",
    dir,
  ];
}

export const githubCredentialKey = "credential.https://github.com.helper";

/** Git runs credential helpers through a shell. */
export function githubCredentialHelper(gh: string): string {
  const bin = /^[\w./+-]+$/.test(gh) ? gh : `'${gh.replaceAll("'", `'\\''`)}'`;
  return `!${bin} auth git-credential`;
}

const marker = "dispatch-tool:";
const lookupScript = `for tool do p=$(command -v "$tool" 2>/dev/null) && [ -x "$p" ] && case $p in /*) printf '${marker}%s=%s\\n' "$tool" "$p";; esac; done; exit 0`;

/** Start with a normal Linux login PATH so the profile sees ordinary defaults.
 * The runner's configured directories are only added once the profile has run.
 */
export function workloadLoginCommand(
  command: string[],
  shell: string,
  home: string,
  fallbackPath: string
): string[] {
  const { PATH } = withToolSearchPath({ HOME: home, PATH: fallbackPath });
  const login = loginShellCommand(command, shell, PATH);
  return [
    "/usr/bin/env",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    login.bin,
    ...login.args,
  ];
}

/** One command prints both paths from the same login environment as a session. */
export function workloadToolLookup(
  shell: string,
  home: string,
  fallbackPath: string
): string[] {
  return workloadLoginCommand(
    [
      "/bin/sh",
      "-c",
      lookupScript,
      "dispatch-tool-lookup",
      ...(Object.keys(systemTools) as WorkloadTool[]),
    ],
    shell,
    home,
    fallbackPath
  );
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

/** The probe runs in the workload account's login shell and prints only PATH. */
export const workloadPathProbe = [
  "/bin/sh",
  "-c",
  String.raw`printf "\0%s\0" "$PATH"`,
];

export function cacheWorkloadPath(probe: () => Promise<string>) {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= probe()
      .then((output) => {
        const path = output.split("\0")[1];
        if (!path) throw new Error("Could not read the workload login PATH.");
        return path;
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
