import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Error.message/stack/cause are non-enumerable. Keep transport fields (including
// nested causes) and child-process stdout/stderr instead of JSON.stringify(Error).
function serialize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
  return Object.fromEntries(
    Object.getOwnPropertyNames(value).map((key) => [
      key,
      serialize((value as Record<string, unknown>)[key], seen),
    ])
  );
}

type Options = {
  repoRoot: string;
  suffix: string;
  stateFile: string;
  logDir: string;
  preserveHosts: boolean;
};

export class RestartEvidence {
  agentId?: string;
  private readonly commands: unknown[] = [];
  private readonly snapshots: unknown[] = [];

  constructor(private readonly options: Options) {}

  command(result: {
    args: string;
    startedAt: string;
    stdout?: string;
    error?: unknown;
  }): void {
    this.commands.push(
      serialize({ ...result, finishedAt: new Date().toISOString() })
    );
  }

  snapshot(stage: string): void {
    // Only read this fixture's state, without yielding to the event loop or
    // introducing HTTP requests that could consume/replace a pooled socket.
    try {
      this.snapshots.push({
        stage,
        at: new Date().toISOString(),
        state: readFileSync(this.options.stateFile, "utf8"),
      });
    } catch (error) {
      this.snapshots.push({ stage, error: serialize(error) });
    }
  }

  captureFailure(error: unknown): void {
    try {
      this.writeFailure(error);
    } catch (captureError) {
      console.error(
        "Unable to preserve restart evidence",
        serialize(captureError)
      );
    }
  }

  private writeFailure(error: unknown): void {
    const { repoRoot, suffix, stateFile, logDir, preserveHosts } = this.options;
    const destination = path.join(
      "/tmp",
      `dispatch-dev-evidence-${suffix}-${preserveHosts ? "preserved" : "default"}`
    );
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const diagnostics: Record<string, unknown> = {};
    const collect = (name: string, read: () => unknown): void => {
      try {
        diagnostics[name] = read();
      } catch (failure) {
        diagnostics[name] = { error: serialize(failure) };
      }
    };
    const command = (file: string, args: string[]): string =>
      execFileSync(file, args, {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    this.snapshot("failure-before-teardown");
    // Allowlist only this stack's logs and this agent's journal. Do not copy
    // files, credentials, database contents, or other agents' state trees.
    const files = [
      stateFile,
      ...["api.log", "api.pid", "vite.log", "vite.pid", "db-up.log"].map(
        (name) => path.join(logDir, name)
      ),
    ];
    if (this.agentId) {
      files.push(
        ...["host.pid", "host.log", "journal.jsonl"].map((name) =>
          path.join(logDir, "agents", this.agentId!, name)
        )
      );
    }
    for (const file of files)
      collect(file, () => {
        copyFileSync(file, path.join(destination, path.basename(file)));
        return "copied";
      });
    collect("gitHead", () => command("git", ["rev-parse", "HEAD"]).trim());
    collect("bunVersion", () => command("bun", ["--version"]).trim());
    collect("pnpmVersion", () => command("pnpm", ["--version"]).trim());
    collect("processes", () => {
      const state = readFileSync(stateFile, "utf8");
      const owned = new Set<number>([process.pid]);
      for (const match of state.matchAll(/^DEV_(?:API|VITE)_PID=(\d+)$/gm))
        owned.add(Number(match[1]));
      if (this.agentId) {
        try {
          owned.add(
            Number(
              readFileSync(
                path.join(logDir, "agents", this.agentId, "host.pid"),
                "utf8"
              )
            )
          );
        } catch {
          /* captured above */
        }
      }
      // Read IDs only; retain command identity only for owned PIDs/descendants.
      const rows = command("ps", ["-axo", "pid=,ppid=,pgid=,comm="])
        .trim()
        .split("\n")
        .map((line) => ({ line, fields: line.trim().split(/\s+/) }));
      let previousSize: number;
      do {
        previousSize = owned.size;
        for (const { fields } of rows)
          if (owned.has(Number(fields[1]))) owned.add(Number(fields[0]));
      } while (owned.size !== previousSize);
      return rows
        .filter(({ fields }) => owned.has(Number(fields[0])))
        .map(({ line }) => line);
    });
    collect("apiListener", () => {
      const state = readFileSync(stateFile, "utf8");
      const port = state.match(/^DEV_API_PORT=(\d+)$/m)?.[1];
      if (!port) throw new Error("No scoped API port in state");
      return command("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    });
    writeFileSync(
      path.join(destination, "failure.json"),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          suffix,
          preserveHosts,
          agentId: this.agentId,
          runtime: {
            executable: process.execPath,
            versions: process.versions,
            platform: process.platform,
            arch: process.arch,
          },
          error: serialize(error),
          commands: this.commands,
          snapshots: this.snapshots,
          diagnostics,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    console.error(
      `Restart failure evidence preserved before teardown: ${destination}`
    );
  }
}
