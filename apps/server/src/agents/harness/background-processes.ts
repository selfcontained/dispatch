import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  BackgroundProcess,
  BackgroundProcessInput,
} from "@dispatch/shared";

const OUTPUT_LIMIT = 64 * 1024;
type LiveProcess = {
  record: BackgroundProcess;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  flush?: NodeJS.Timeout;
  writes: Promise<void>;
  writing: boolean;
  dirty: boolean;
  finished: Promise<void>;
  finish: () => void;
  stopping: boolean;
};

export class BackgroundProcesses {
  private live = new Map<string, LiveProcess>();
  private closing = false;

  constructor(
    private deps: {
      pool: Pool;
      onComplete: (record: BackgroundProcess) => void;
      onError: (error: unknown) => void;
    }
  ) {}

  async reconcile(): Promise<void> {
    await this.deps.pool.query(`UPDATE agent_background_processes
      SET record = record || jsonb_build_object('status', 'interrupted', 'endedAt', now())
      WHERE record->>'status' = 'running'`);
  }

  async list(agentId: string): Promise<BackgroundProcess[]> {
    const result = await this.deps.pool.query(
      "SELECT record FROM agent_background_processes WHERE agent_id = $1 ORDER BY (record->>'status' = 'running') DESC, created_at DESC LIMIT 24",
      [agentId]
    );
    return result.rows.map(
      ({ record }) => this.live.get(record.id)?.record ?? record
    );
  }

  async start(
    agentId: string,
    input: BackgroundProcessInput,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<BackgroundProcess> {
    if (this.closing) throw new Error("The server is shutting down.");
    if (
      !input.command.trim() ||
      input.command.length > 8000 ||
      !input.title.trim() ||
      input.title.length > 120
    )
      throw new Error(
        "A title and command are required (120/8000 characters maximum)."
      );
    const timeout = input.timeoutSeconds ?? 3600;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
      throw new Error("Timeout must be 1–86400 seconds.");
    if (
      this.live.size >= 16 ||
      [...this.live.values()].filter((p) => p.record.agentId === agentId)
        .length >= 4
    )
      throw new Error(
        "Background process limit reached. Wait for or stop an existing process."
      );
    const record: BackgroundProcess = {
      id: randomUUID(),
      agentId,
      title: input.title.trim(),
      command: input.command,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      output: "",
      truncated: false,
    };
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live: LiveProcess = {
      record,
      writes: Promise.resolve(),
      writing: false,
      dirty: false,
      finished,
      finish,
      stopping: false,
    };
    this.live.set(record.id, live);
    try {
      await this.deps.pool.query(
        "INSERT INTO agent_background_processes (id, agent_id, record) VALUES ($1, $2, $3::jsonb)",
        [record.id, agentId, JSON.stringify(record)]
      );
      if (this.closing || live.stopping)
        throw new Error("Process start was cancelled.");
      const child = spawn("/bin/bash", ["-lc", input.command], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      live.child = child;
      const append = (data: string) => {
        record.output += data;
        if (record.output.length > OUTPUT_LIMIT) {
          record.output = record.output.slice(-OUTPUT_LIMIT);
          record.truncated = true;
        }
        if (!live.flush)
          live.flush = setTimeout(() => {
            live.flush = undefined;
            this.persist(live);
          }, 500);
      };
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
      child.on("error", (error) => {
        append(`\n${error.message}\n`);
      });
      child.on("close", (code) => {
        record.exitCode = code;
        record.status = this.closing
          ? "interrupted"
          : live.stopping
            ? "stopped"
            : code === 0
              ? "completed"
              : "failed";
        record.endedAt = new Date().toISOString();
        clearTimeout(live.timer);
        clearTimeout(live.flush);
        // A shell can exit while detached descendants remain in its group.
        this.signal(live, "SIGKILL");
        this.persist(live);
        void live.writes.finally(() => {
          this.live.delete(record.id);
          live.finish();
          if (!this.closing) this.deps.onComplete({ ...record });
          void this.deps.pool
            .query(
              `DELETE FROM agent_background_processes WHERE agent_id = $1 AND record->>'status' <> 'running'
             AND id NOT IN (SELECT id FROM agent_background_processes WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20)`,
              [agentId]
            )
            .catch(this.deps.onError);
        });
      });
      live.timer = setTimeout(() => {
        record.output += "\nProcess time limit reached.\n";
        void this.stop(agentId, record.id);
      }, timeout * 1000);
      return { ...record };
    } catch (error) {
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.output = String(error);
      this.persist(live);
      await live.writes;
      this.live.delete(record.id);
      live.finish();
      throw error;
    }
  }

  private persist(live: LiveProcess): void {
    live.dirty = true;
    if (live.writing) return;
    live.writing = true;
    // Coalesce output while the database is slow instead of queuing snapshots.
    live.writes = (async () => {
      try {
        while (live.dirty) {
          live.dirty = false;
          await this.deps.pool
            .query(
              "UPDATE agent_background_processes SET record = $2::jsonb WHERE id = $1",
              [live.record.id, JSON.stringify(live.record)]
            )
            .catch(this.deps.onError);
        }
      } finally {
        live.writing = false;
      }
    })();
  }

  private signal(live: LiveProcess, signal: NodeJS.Signals): void {
    if (!live.child?.pid) return;
    try {
      process.kill(-live.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        this.deps.onError(error);
    }
  }

  async stop(agentId: string, id: string): Promise<boolean> {
    const live = this.live.get(id);
    if (
      !live ||
      live.record.agentId !== agentId ||
      live.record.status !== "running"
    )
      return false;
    live.stopping = true;
    this.signal(live, "SIGTERM");
    const kill = setTimeout(() => {
      if (live.record.status === "running") this.signal(live, "SIGKILL");
    }, 1500);
    await Promise.race([
      live.finished,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    clearTimeout(kill);
    if (live.record.status === "running") this.signal(live, "SIGKILL");
    return true;
  }

  async stopAgent(agentId: string): Promise<void> {
    await Promise.all(
      [...this.live.values()]
        .filter((p) => p.record.agentId === agentId)
        .map((p) => this.stop(agentId, p.record.id))
    );
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.live.values()].map((p) =>
        this.stop(p.record.agentId, p.record.id)
      )
    );
  }
}
