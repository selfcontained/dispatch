import path from "node:path";

import type { CommandLogEntry } from "./command-log.js";
import type { DriverEvent, DriverUpdate } from "./driver.js";
import { parsePromptSource } from "./prompt-source.js";
import type {
  StreamEventRow,
  StreamStore,
  ToolPayload,
  TurnPayload,
} from "./stream-store.js";

type TextKind = "assistant" | "thought";

type OpenText = {
  row: StreamEventRow;
  text: string;
  truncated: boolean;
  /** Text as last written; a flush is a no-op when nothing changed. */
  written: string;
  flushTimer: NodeJS.Timeout | null;
  /** Writes for this row run in order: a timer flush never lands after close. */
  writing: Promise<void>;
};

/** Model output is not trusted input: bound what one row can hold. */
export const TEXT_MAX_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_MAX_BYTES = 32 * 1024;
/** The error a turn carries when the service went down under it. */
export const INTERRUPTED_BY_RESTART = "interrupted by restart";
/** Chunks arrive per token; rewrite the row at most this often. */
export const FLUSH_INTERVAL_MS = 100;

/**
 * dsh's ACP server sends tool calls without a `kind`; the title is the tool
 * name, which is enough to pick the icon and colour the Chat row gets.
 */
export function inferToolKind(
  kind: string | null | undefined,
  title: string
): string {
  // dsh sends "other" explicitly, which says nothing; treat it as missing.
  if (kind && kind !== "other") return kind;
  const name = title.toLowerCase();
  if (/^mcp__/.test(name)) return "other";
  if (/bash|shell|pwsh|exec|terminal|command/.test(name)) return "execute";
  if (/edit|write|str_replace|patch|create_file/.test(name)) return "edit";
  if (/^read|read_file|cat\b|view/.test(name)) return "read";
  if (/grep|glob|search|find|list|^ls\b/.test(name)) return "search";
  if (/fetch|web|http|browse/.test(name)) return "fetch";
  if (/think|plan|todo/.test(name)) return "think";
  return "other";
}

function textOf(content: { type: string; text?: string } | undefined): string {
  return content && content.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

/** Keep the head and the tail of over-long output; the middle is the least useful part. */
export function boundOutput(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half).toString("utf8");
  const tail = bytes.subarray(-half).toString("utf8");
  return { text: `${head}\n… [truncated] …\n${tail}`, truncated: true };
}

const INPUT_MAX_BYTES = 8 * 1024;

/**
 * Keep a tool call's raw input as sent, unless serialising it is large —
 * then a bounded string preview stands in, marked so the view can say so.
 */
export function boundInput(input: unknown): unknown {
  if (input === undefined || input === null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json, "utf8") <= INPUT_MAX_BYTES) return input;
  return {
    truncated: true,
    preview: boundOutput(json, INPUT_MAX_BYTES).text,
  };
}

/** The shell command from a tool's raw input, when it is one. */
function commandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  return typeof command === "string" && command.trim() ? command : null;
}

function projectToolContent(content: readonly unknown[] | null | undefined): {
  diff: ToolPayload["diff"];
  terminalOutput: string | null;
  truncated: boolean;
} {
  let diff: ToolPayload["diff"] = null;
  let terminalOutput: string | null = null;
  for (const item of content ?? []) {
    const c = item as {
      type: string;
      path?: string;
      oldText?: string | null;
      newText?: string;
      content?: { type: string; text?: string };
    };
    if (c.type === "diff" && c.path && typeof c.newText === "string") {
      diff = { path: c.path, oldText: c.oldText ?? null, newText: c.newText };
    } else if (c.type === "content" && c.content?.type === "text") {
      terminalOutput = (terminalOutput ?? "") + (c.content.text ?? "");
    }
  }
  let truncated = false;
  if (terminalOutput !== null) {
    const bounded = boundOutput(terminalOutput, TERMINAL_OUTPUT_MAX_BYTES);
    terminalOutput = bounded.text;
    truncated = bounded.truncated;
  }
  if (diff) {
    const bounded = boundOutput(diff.newText, TEXT_MAX_BYTES);
    if (bounded.truncated) {
      diff = { ...diff, newText: bounded.text };
      truncated = true;
    }
  }
  return { diff, terminalOutput, truncated };
}

/**
 * Folds driver events into `agent_stream_events` rows. Assistant and
 * thought chunks accumulate into one open row each until something else
 * interrupts them (a tool call, a settled turn, a process exit); the row is
 * rewritten at most every {@link FLUSH_INTERVAL_MS} and on close. Tool calls
 * are keyed by toolCallId and rewritten as they settle. One instance serves
 * every agent; open-row state is per agent, and callers serialize events
 * per agent (see DshSupervisor).
 */
export class StreamRecorder {
  private readonly open = new Map<
    string,
    Partial<Record<TextKind, OpenText>>
  >();
  private readonly cwd = new Map<string, string>();
  /** The turn row awaiting its settle, per agent. */
  private readonly openTurn = new Map<string, StreamEventRow>();

  constructor(
    private readonly store: StreamStore,
    private readonly deps: {
      /** Receives every shell command as it settles (see command-log.ts). */
      commandLog?: (agentId: string, entry: CommandLogEntry) => Promise<void>;
    } = {}
  ) {}

  /** The agent's working directory, so file paths render relative to it. */
  setCwd(agentId: string, cwd: string): void {
    this.cwd.set(agentId, cwd);
  }

  async handle(event: DriverEvent): Promise<void> {
    switch (event.type) {
      case "update":
        return this.handleUpdate(event.agentId, event.update);
      case "turn": {
        if (event.state === "started") {
          const row = await this.store.append(event.agentId, "turn", {
            state: "started",
            prompt: parsePromptSource(event.text),
          } satisfies TurnPayload);
          this.openTurn.set(event.agentId, row);
          return;
        }
        await this.closeText(event.agentId);
        const open = this.openTurn.get(event.agentId);
        if (open) {
          const prev = open.payload as TurnPayload;
          await this.store.updatePayload(open.id, {
            ...prev,
            state: "settled",
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
            ...(event.error ? { error: event.error } : {}),
            endedAt: new Date().toISOString(),
          } satisfies TurnPayload);
          this.openTurn.delete(event.agentId);
        }
        if (event.error) {
          await this.store.append(event.agentId, "status", {
            message: event.error,
          });
        }
        return;
      }
      case "exit": {
        await this.closeText(event.agentId);
        this.cwd.delete(event.agentId);
        // The child is gone, so the turn it was running can never settle
        // through the prompt path; settle it here or the view spins forever.
        const open = this.openTurn.get(event.agentId);
        if (open) {
          const prev = open.payload as TurnPayload;
          await this.store.updatePayload(open.id, {
            ...prev,
            state: "settled",
            ...(event.expected
              ? { stopReason: "cancelled" }
              : { error: "dsh exited before the turn settled" }),
            endedAt: new Date().toISOString(),
          } satisfies TurnPayload);
          this.openTurn.delete(event.agentId);
        }
        if (event.expected || event.code === 0) return;
        const how =
          event.code === null ? `signal ${event.signal}` : `code ${event.code}`;
        const detail = event.stderrTail ? `: ${event.stderrTail}` : "";
        await this.store.append(event.agentId, "status", {
          message: `dsh exited with ${how}${detail}`,
        });
        return;
      }
    }
  }

  /**
   * Before a session starts: settle rows a previous process left open (a
   * turn interrupted by a server restart has no in-memory state here).
   */
  async reconcile(agentId: string): Promise<number> {
    this.openTurn.delete(agentId);
    return this.store.settleInterrupted(agentId, INTERRUPTED_BY_RESTART);
  }

  /**
   * When the agent's newest turn ended because Dispatch restarted, the
   * time it was cut; null when it ended any other way.
   */
  async lastTurnInterruptedByRestartAt(agentId: string): Promise<Date | null> {
    const last = await this.store.lastTurnSettlement(agentId);
    if (!last || last.error !== INTERRUPTED_BY_RESTART) return null;
    const at = last.endedAt ? Date.parse(last.endedAt) : NaN;
    return Number.isFinite(at) ? new Date(at) : new Date(0);
  }

  /** Write any buffered text for the agent now (tests and shutdown). */
  async flush(agentId: string): Promise<void> {
    const state = this.open.get(agentId);
    if (!state) return;
    for (const kind of ["assistant", "thought"] as const) {
      const current = state[kind];
      if (current) await this.write(kind, current, true);
    }
  }

  private projectLocations(
    agentId: string,
    locations:
      | readonly { path: string; line?: number | null }[]
      | null
      | undefined
  ): ToolPayload["locations"] {
    const cwd = this.cwd.get(agentId);
    return (locations ?? []).map((l) => {
      const relative =
        cwd && (l.path === cwd || l.path.startsWith(`${cwd}${path.sep}`))
          ? path.relative(cwd, l.path) || "."
          : l.path;
      return l.line != null
        ? { path: relative, line: l.line }
        : { path: relative };
    });
  }

  private async handleUpdate(
    agentId: string,
    update: DriverUpdate
  ): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendText(agentId, "assistant", textOf(update.content));
      case "agent_thought_chunk":
        return this.appendText(agentId, "thought", textOf(update.content));
      case "tool_call": {
        await this.closeText(agentId);
        const { diff, terminalOutput, truncated } = projectToolContent(
          update.content
        );
        const input = boundInput(update.rawInput);
        const payload: ToolPayload = {
          toolKind: inferToolKind(update.kind, update.title),
          title: update.title,
          status: update.status ?? "pending",
          locations: this.projectLocations(agentId, update.locations),
          diff,
          terminalOutput,
          ...(truncated ? { truncated: true } : {}),
          ...(input !== undefined ? { input } : {}),
        };
        await this.store.upsertByKey(
          agentId,
          "tool_call",
          update.toolCallId,
          payload
        );
        return;
      }
      case "tool_call_update": {
        // An update for a call we never saw start still gets a row, so a
        // late-joining feed shows the settled call.
        const existing =
          (await this.store.getByKey(
            agentId,
            "tool_call",
            update.toolCallId
          )) ??
          (await this.store.append(
            agentId,
            "tool_call",
            {},
            update.toolCallId
          ));
        const prev = existing.payload as Partial<ToolPayload>;
        const projected = update.content
          ? projectToolContent(update.content)
          : null;
        const truncated =
          (projected?.truncated ?? false) || prev.truncated === true;
        const title = update.title ?? prev.title ?? "";
        const next: ToolPayload = {
          toolKind: inferToolKind(update.kind ?? prev.toolKind, title),
          title,
          status: update.status ?? prev.status ?? "pending",
          locations: update.locations
            ? this.projectLocations(agentId, update.locations)
            : (prev.locations ?? []),
          diff: projected?.diff ?? prev.diff ?? null,
          terminalOutput:
            projected?.terminalOutput ?? prev.terminalOutput ?? null,
          ...(truncated ? { truncated: true } : {}),
          ...(update.rawInput !== undefined
            ? { input: boundInput(update.rawInput) }
            : prev.input !== undefined
              ? { input: prev.input }
              : {}),
        };
        await this.store.updatePayload(existing.id, next);
        // A shell command that just settled goes to the agent's command log.
        const settledNow =
          (next.status === "completed" || next.status === "failed") &&
          prev.status !== "completed" &&
          prev.status !== "failed";
        const command = commandOf(next.input);
        if (settledNow && next.toolKind === "execute" && command) {
          const started = existing.createdAt ?? new Date();
          await this.deps
            .commandLog?.(agentId, {
              command,
              output: next.terminalOutput,
              status: next.status === "failed" ? "failed" : "completed",
              durationMs: Date.now() - new Date(started).getTime(),
              at: new Date(),
            })
            .catch(() => {});
        }
        return;
      }
      default:
        return;
    }
  }

  private payloadFor(kind: TextKind, current: OpenText, streaming: boolean) {
    const truncated = current.truncated ? { truncated: true } : {};
    return kind === "assistant"
      ? { text: current.text, streaming, ...truncated }
      : { text: current.text, ...truncated };
  }

  private async write(
    kind: TextKind,
    current: OpenText,
    streaming: boolean
  ): Promise<void> {
    if (current.flushTimer) {
      clearTimeout(current.flushTimer);
      current.flushTimer = null;
    }
    if (current.written === current.text && streaming) return;
    current.written = current.text;
    const payload = this.payloadFor(kind, current, streaming);
    current.writing = current.writing
      .catch(() => {})
      .then(() => this.store.updatePayload(current.row.id, payload));
    await current.writing;
  }

  private async appendText(
    agentId: string,
    kind: TextKind,
    delta: string
  ): Promise<void> {
    if (!delta) return;
    const state = this.open.get(agentId) ?? {};
    const other: TextKind = kind === "assistant" ? "thought" : "assistant";
    if (state[other]) await this.closeText(agentId, other);
    let current = state[kind];
    if (!current) {
      const row = await this.store.append(
        agentId,
        kind,
        kind === "assistant"
          ? { text: delta, streaming: true }
          : { text: delta }
      );
      current = {
        row,
        text: delta,
        truncated: false,
        written: delta,
        flushTimer: null,
        writing: Promise.resolve(),
      };
      state[kind] = current;
      this.open.set(agentId, state);
      return;
    }
    if (current.truncated) return;
    current.text += delta;
    if (Buffer.byteLength(current.text, "utf8") > TEXT_MAX_BYTES) {
      const bounded = boundOutput(current.text, TEXT_MAX_BYTES);
      current.text = bounded.text;
      current.truncated = true;
      await this.write(kind, current, true);
      return;
    }
    if (!current.flushTimer) {
      const pending = current;
      current.flushTimer = setTimeout(() => {
        pending.flushTimer = null;
        void this.write(kind, pending, true).catch(() => {});
      }, FLUSH_INTERVAL_MS);
      current.flushTimer.unref?.();
    }
  }

  private async closeText(agentId: string, only?: TextKind): Promise<void> {
    const state = this.open.get(agentId);
    if (!state) return;
    for (const kind of ["assistant", "thought"] as const) {
      if (only && kind !== only) continue;
      const current = state[kind];
      if (!current) continue;
      await this.write(kind, current, false);
      delete state[kind];
    }
    if (!state.assistant && !state.thought) this.open.delete(agentId);
  }
}
