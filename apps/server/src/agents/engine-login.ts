import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  EngineAuthStatus,
  EngineLogin,
  EngineLoginEngine,
} from "@dispatch/shared";

import { hostProcessEnv, loginShellCommand } from "./acp/runtime.js";

/**
 * Signing an engine CLI in from the browser. The CLI's own login runs here,
 * on the machine and under the account the agents run as, with the same
 * login-shell environment their hosts get — so the sign-in lands in the
 * config and keychain the agents read. Its output gives the sign-in link
 * (and Codex's one-time code); Claude's code comes back from the person and
 * goes to the CLI's stdin.
 *
 * Every agent of an engine shares one sign-in, so there is at most one
 * login per engine at a time; asking again while one waits gets that one.
 * The link and code live here and in the response, never in a log.
 */

export const LOGIN_ENGINES = ["claude", "codex"] as const;

export function isLoginEngine(value: string): value is EngineLoginEngine {
  return (LOGIN_ENGINES as readonly string[]).includes(value);
}

/** Codex's device codes last 15 minutes; Claude's flow gets the same. */
const LOGIN_TTL_MS = 15 * 60_000;
/** How long the CLI gets to print its link before the login is given up. */
const LINK_TIMEOUT_MS = 30_000;
/** How long the CLI gets to finish once a code has been sent to it. */
const VERIFY_TIMEOUT_MS = 60_000;
/** A finished login is kept this long, so a polling page sees how it ended. */
const FINISHED_TTL_MS = 5 * 60_000;
const OUTPUT_MAX_CHARS = 16_000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_PATTERN = /https:\/\/[^\s"'<>`]+/;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

/** What the login's own CLI prints that this reads, and how it is started. */
type LoginCommand = {
  args: string[];
  needsCode: boolean;
  /**
   * Run against a scratch home, installed over the real one only once it
   * succeeds: this CLI deletes the sign-in it has before it starts a new one.
   */
  staged?: boolean;
};

const COMMANDS: Record<EngineLoginEngine, LoginCommand> = {
  // Without a terminal the CLI prints the link and waits on stdin for the
  // code the sign-in page shows.
  claude: { args: ["auth", "login"], needsCode: true },
  // The device flow: the person enters the printed code on the website and
  // the CLI finishes by itself.
  // `codex login` removes auth.json as it starts, so a login given up
  // halfway would sign every Codex agent out; it runs staged.
  codex: { args: ["login", "--device-auth"], needsCode: false, staged: true },
};

/** The link and code a CLI's output carries so far, once it has both it needs. */
export function parseLoginOutput(
  engine: EngineLoginEngine,
  output: string
): { url: string; userCode?: string } | null {
  const text = output.replace(ANSI, "");
  const url = URL_PATTERN.exec(text)?.[0]?.replace(/[).,]+$/, "");
  if (!url) return null;
  if (engine === "codex") {
    const after = text.slice(text.indexOf(url) + url.length);
    const userCode = DEVICE_CODE.exec(after)?.[0];
    return userCode ? { url, userCode } : null;
  }
  return { url };
}

/** The last thing the CLI said, for a failure: one line, no link or code in it. */
function lastLine(output: string): string {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !URL_PATTERN.test(line));
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

type Entry = {
  view: EngineLogin;
  child: ChildProcess | null;
  output: string;
  /** Where the output stood when the code went in: what the CLI said to it. */
  answerFrom: number;
  timer: NodeJS.Timeout | null;
  /** Releases `start()`, which waits for the link or the end, whichever is first. */
  release: () => void;
  /** The scratch CODEX_HOME a staged login runs against; removed when it ends. */
  stageDir: string | null;
};

export type EngineLoginDeps = {
  /** The engine's CLI as the agents run it, or null when it is not installed. */
  resolveBin: (engine: EngineLoginEngine) => Promise<string | null>;
  /**
   * Test seam: the command a login or status check runs as. A login passes
   * its watchdog life and, for a staged CLI, its scratch home.
   */
  command?: (
    bin: string,
    args: string[],
    opts?: LoginScriptOptions
  ) => { bin: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam: how long the CLI gets to print its link. */
  linkTimeoutMs?: number;
};

export type LoginScriptOptions = {
  /** The life the login's process group gets even if this server dies. */
  ttlSeconds?: number;
  /**
   * A scratch CODEX_HOME. The login runs against it, and its auth.json is
   * moved over the real one only when the CLI succeeds, so cancelling or
   * failing leaves the existing sign-in alone.
   */
  stageDir?: string;
};

/**
 * The `sh -c` command a login or status check runs as. The CLI's own
 * directory goes last on PATH so an npm CLI finds the node beside it; it
 * and the stage directory go in as arguments, never into the script's text.
 *
 * A login also gets a watchdog in its own process group: the CLI waits on
 * stdin forever and outlives a server that dies without closing, so the
 * group ends itself when the login's time is up.
 */
export function loginScript(
  bin: string,
  args: string[],
  opts: LoginScriptOptions = {}
): string[] {
  const watchdog =
    opts.ttlSeconds === undefined
      ? ""
      : `(sleep ${Math.ceil(opts.ttlSeconds)}; kill 0) </dev/null >/dev/null 2>&1 & `;
  if (opts.stageDir === undefined) {
    return [
      "/bin/sh",
      "-c",
      `PATH="$PATH:$1"; shift; ${watchdog}exec "$0" "$@"`,
      bin,
      path.dirname(bin),
      ...args,
    ];
  }
  // The real home is whatever the agents' shell says, as they would read it.
  const script = [
    'PATH="$PATH:$1"; STAGE="$2"; shift 2',
    'REAL="${CODEX_HOME:-$HOME/.codex}"',
    `${watchdog}:`,
    'if [ -f "$REAL/config.toml" ]; then cp "$REAL/config.toml" "$STAGE/config.toml"; fi',
    'CODEX_HOME="$STAGE" "$0" "$@" || exit $?',
    '[ -f "$STAGE/auth.json" ] || { echo "The CLI finished without signing in." >&2; exit 3; }',
    'mkdir -p "$REAL"',
    'cp "$STAGE/auth.json" "$REAL/.auth.json.dispatch"',
    'chmod 600 "$REAL/.auth.json.dispatch"',
    'mv -f "$REAL/.auth.json.dispatch" "$REAL/auth.json"',
  ].join("\n");
  return [
    "/bin/sh",
    "-c",
    `set -e\n${script}`,
    bin,
    path.dirname(bin),
    opts.stageDir,
    ...args,
  ];
}

/** Run through the person's login shell like an agent host. */
function shellCommand(
  bin: string,
  args: string[],
  opts?: LoginScriptOptions
): { bin: string; args: string[] } {
  return loginShellCommand(loginScript(bin, args, opts));
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export class EngineLogins {
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<EngineLoginEngine, Promise<unknown>>();
  private readonly command: NonNullable<EngineLoginDeps["command"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly linkTimeoutMs: number;

  constructor(private readonly deps: EngineLoginDeps) {
    this.command = deps.command ?? shellCommand;
    this.env = {
      ...hostProcessEnv(deps.env ?? process.env),
      // Claude also tries to open the link itself; on a server that is the
      // wrong machine, and the person picks their own browser anyway.
      BROWSER: "true",
      NO_BROWSER: "1",
    };
    this.now = deps.now ?? Date.now;
    this.linkTimeoutMs = deps.linkTimeoutMs ?? LINK_TIMEOUT_MS;
  }

  get(id: string): EngineLogin | null {
    return this.entries.get(id)?.view ?? null;
  }

  /**
   * The engine's login a page should show: the one under way, else the
   * newest that ended in the last few minutes (so a page that reloaded
   * still learns how it ended). Null when there is neither.
   */
  current(engine: EngineLoginEngine): EngineLogin | null {
    let latest: EngineLogin | null = null;
    for (const { view } of this.entries.values()) {
      if (view.engine !== engine) continue;
      if (this.active(view)) return view;
      if (!latest || (view.finishedAt ?? "") > (latest.finishedAt ?? "")) {
        latest = view;
      }
    }
    return latest;
  }

  /**
   * Start a login, or join the one already waiting on the person for this
   * engine. `restart` drops that one for a fresh link (Start over).
   */
  start(
    engine: EngineLoginEngine,
    opts: { restart?: boolean } = {}
  ): Promise<EngineLogin> {
    // One at a time per engine: two pages (or a page mounting twice) asking
    // at once must join one login, not each spawn their own.
    const next = (this.starting.get(engine) ?? Promise.resolve()).then(
      () => this.startNow(engine, opts),
      () => this.startNow(engine, opts)
    );
    this.starting.set(engine, next);
    return next;
  }

  private async startNow(
    engine: EngineLoginEngine,
    opts: { restart?: boolean }
  ): Promise<EngineLogin> {
    for (const entry of this.entries.values()) {
      if (entry.view.engine !== engine || !this.active(entry.view)) continue;
      if (!opts.restart) return entry.view;
      this.finish(entry, { status: "cancelled" });
    }
    const bin = await this.deps.resolveBin(engine);
    const id = randomUUID();
    const { needsCode, args } = COMMANDS[engine];
    const entry: Entry = {
      view: {
        id,
        engine,
        status: "starting",
        needsCode,
        expiresAt: new Date(this.now() + LOGIN_TTL_MS).toISOString(),
      },
      child: null,
      output: "",
      answerFrom: 0,
      timer: null,
      release: () => {},
      stageDir: null,
    };
    this.entries.set(id, entry);
    if (!bin) {
      this.finish(entry, {
        status: "failed",
        error: `${engine === "claude" ? "Claude Code" : "Codex"} is not installed on this machine.`,
      });
      return entry.view;
    }
    const { staged } = COMMANDS[engine];
    if (staged) {
      entry.stageDir = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-engine-login-")
      );
    }
    const command = this.command(bin, args, {
      ttlSeconds: LOGIN_TTL_MS / 1000 + 60,
      ...(entry.stageDir ? { stageDir: entry.stageDir } : {}),
    });
    const child = spawn(command.bin, command.args, {
      env: this.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    entry.child = child;
    const linked = new Promise<void>((resolve) => {
      entry.release = resolve;
      const read = (chunk: Buffer) => {
        entry.output = (entry.output + chunk.toString("utf8")).slice(
          -OUTPUT_MAX_CHARS
        );
        if (entry.view.status !== "starting") return;
        const parsed = parseLoginOutput(engine, entry.output);
        if (!parsed) return;
        this.update(entry, { status: "waiting", ...parsed });
        this.arm(entry, LOGIN_TTL_MS, "The sign-in expired. Start over.");
        resolve();
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("error", (err) => {
        this.finish(entry, { status: "failed", error: err.message });
        resolve();
      });
      child.on("exit", (code) => {
        void this.exited(entry, code);
        resolve();
      });
    });
    child.stdin?.on("error", () => {});
    this.arm(
      entry,
      this.linkTimeoutMs,
      "The CLI did not print a sign-in link. Run the login in a terminal on the machine running Dispatch."
    );
    await linked;
    return entry.view;
  }

  /** Hand the code the sign-in page showed to the waiting CLI. */
  submitCode(id: string, code: string): EngineLogin | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const trimmed = code.trim();
    if (
      entry.view.status !== "waiting" ||
      !entry.view.needsCode ||
      !trimmed ||
      !entry.child?.stdin?.writable
    ) {
      return entry.view;
    }
    entry.answerFrom = entry.output.length;
    entry.child.stdin.write(`${trimmed}\n`);
    this.update(entry, { status: "verifying" });
    this.arm(
      entry,
      VERIFY_TIMEOUT_MS,
      "The CLI did not accept the code. Start over."
    );
    return entry.view;
  }

  cancel(id: string): EngineLogin | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (this.active(entry.view)) this.finish(entry, { status: "cancelled" });
    return entry.view;
  }

  /** Whether each engine's CLI says it is signed in, and as whom. */
  async status(engine: EngineLoginEngine): Promise<EngineAuthStatus> {
    const bin = await this.deps.resolveBin(engine);
    if (!bin) return { engine, installed: false, signedIn: false };
    const args =
      engine === "claude" ? ["auth", "status", "--json"] : ["login", "status"];
    const { code, output } = await this.run(bin, args);
    if (engine === "claude") {
      try {
        const json = JSON.parse(
          output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)
        ) as { loggedIn?: boolean; email?: string };
        return {
          engine,
          installed: true,
          signedIn: json.loggedIn === true,
          ...(json.loggedIn && json.email ? { detail: json.email } : {}),
        };
      } catch {
        return { engine, installed: true, signedIn: false };
      }
    }
    // "Logged in using ChatGPT" says how; the row already says signed in.
    const line = lastLine(output).replace(/^logged in using\s+/i, "");
    return {
      engine,
      installed: true,
      signedIn: code === 0,
      ...(code === 0 && line ? { detail: line } : {}),
    };
  }

  /** Stop every login; for shutdown. */
  close(): void {
    for (const entry of this.entries.values()) {
      if (this.active(entry.view)) this.finish(entry, { status: "cancelled" });
    }
  }

  private active(view: EngineLogin): boolean {
    return (
      view.status === "starting" ||
      view.status === "waiting" ||
      view.status === "verifying"
    );
  }

  private async exited(entry: Entry, code: number | null): Promise<void> {
    const pid = entry.child?.pid;
    entry.child = null;
    // The CLI is gone; its watchdog is not.
    if (pid) killGroup(pid);
    this.dropStage(entry);
    if (!this.active(entry.view)) return;
    if (code !== 0) {
      this.finish(entry, {
        status: "failed",
        error:
          lastLine(entry.output.slice(entry.answerFrom)) ||
          `The CLI exited with code ${code}.`,
      });
      return;
    }
    const status = await this.status(entry.view.engine).catch(() => null);
    this.finish(entry, {
      status: "succeeded",
      ...(status?.detail ? { detail: status.detail } : {}),
    });
  }

  private dropStage(entry: Entry): void {
    const dir = entry.stageDir;
    if (!dir) return;
    entry.stageDir = null;
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  private update(entry: Entry, patch: Partial<EngineLogin>): void {
    entry.view = { ...entry.view, ...patch };
  }

  private arm(entry: Entry, ms: number, error: string): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.active(entry.view))
        this.finish(entry, { status: "failed", error });
    }, ms);
    entry.timer.unref?.();
  }

  private finish(entry: Entry, patch: Partial<EngineLogin>): void {
    if (entry.timer) clearTimeout(entry.timer);
    // The link and code are spent: a finished login carries neither.
    const { url: _url, userCode: _code, ...rest } = entry.view;
    entry.view = {
      ...rest,
      ...patch,
      finishedAt: new Date(this.now()).toISOString(),
    };
    const child = entry.child;
    entry.child = null;
    if (child?.pid && child.exitCode === null) killGroup(child.pid);
    // A killed CLI's group is gone before its stage is removed; an exiting
    // one removes it in `exited`.
    if (!child || child.exitCode !== null) this.dropStage(entry);
    else child.once("exit", () => this.dropStage(entry));
    entry.release();
    entry.timer = setTimeout(
      () => this.entries.delete(entry.view.id),
      FINISHED_TTL_MS
    );
    entry.timer.unref?.();
  }

  private run(
    bin: string,
    args: string[]
  ): Promise<{ code: number | null; output: string }> {
    const command = this.command(bin, args);
    return new Promise((resolve) => {
      let output = "";
      const child = spawn(command.bin, command.args, {
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_MAX_CHARS);
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: null, output });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }
}
