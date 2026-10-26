import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RestartSocketTrace } from "./restart-socket-trace.js";

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
  private socketTrace?: RestartSocketTrace;
  private readonly commands: unknown[] = [];
  private readonly snapshots: unknown[] = [];
  private readonly requests: unknown[] = [];

  constructor(private readonly options: Options) {}

  traceOrigin(origin: string): void {
    if (process.env.DISPATCH_RESTART_SOCKET_TRACE === "1") {
      this.socketTrace = new RestartSocketTrace(origin);
    }
  }

  dispose(): void {
    this.socketTrace?.dispose();
  }

  command(result: {
    args: string;
    startedAt: string;
    stdout?: string;
    stderr?: string;
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

  async observeRequest<T>(
    phase: string,
    method: string,
    url: string,
    request: () => Promise<T>
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    try {
      const result = await request();
      this.requests.push({
        phase,
        method,
        url,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.requests.push({
        phase,
        method,
        url,
        startedAt,
        failedAt: new Date().toISOString(),
        error: serialize(error),
      });
      throw error;
    }
  }

  captureSuccess(): void {
    this.capture("success");
  }

  captureFailure(error: unknown): void {
    this.capture("failure", error);
  }

  private capture(outcome: "success" | "failure", error?: unknown): void {
    try {
      this.writeEvidence(outcome, error);
    } catch (captureError) {
      console.error(
        "Unable to preserve restart evidence",
        serialize(captureError)
      );
    }
  }

  private writeEvidence(outcome: "success" | "failure", error?: unknown): void {
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
    this.snapshot(`${outcome}-before-teardown`);
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
    const container = `dispatch-postgres-${suffix}`;
    collect("databaseLogs", () =>
      // Postgres writes logs to stderr; retain both streams on success too.
      command("bash", [
        "-c",
        'exec docker logs --tail 200 "$1" 2>&1',
        "restart-evidence",
        container,
      ])
    );
    // Restrict inspect to identity/state/ports; full inspect would include env.
    collect("databaseInspect", () =>
      command("docker", [
        "inspect",
        "--format",
        "{{json .Id}} {{json .State}} {{json .NetworkSettings.Ports}}",
        container,
      ])
    );
    collect("gitHead", () => command("git", ["rev-parse", "HEAD"]).trim());
    collect("bunVersion", () => command("bun", ["--version"]).trim());
    collect("pnpmVersion", () => command("pnpm", ["--version"]).trim());
    writeFileSync(
      path.join(destination, `${outcome}.json`),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          outcome,
          suffix,
          preserveHosts,
          controlledArm: process.env.DISPATCH_RESTART_CONTROLLED_ARM,
          agentId: this.agentId,
          runtime: {
            executable: process.execPath,
            versions: process.versions,
            platform: process.platform,
            arch: process.arch,
          },
          error: serialize(error),
          commands: this.commands,
          requests: this.requests,
          socketTrace: this.socketTrace?.snapshot(),
          snapshots: this.snapshots,
          diagnostics,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    console.error(
      `Restart ${outcome} evidence preserved before teardown: ${destination}`
    );
  }
}
