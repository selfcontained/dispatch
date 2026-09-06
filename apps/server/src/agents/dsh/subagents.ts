import type {
  HarnessStep,
  HarnessSubagent,
  HarnessTurn,
} from "@dispatch/shared";

import { inferToolKind } from "./stream-recorder.js";
import type { SessionLog, SessionLogEvent } from "./session-log.js";
import { locationsFromInput } from "./turns.js";

/**
 * A dsh subagent is a session of its own; its log has the same shape as
 * the parent's. This shapes that log into Harness turns so the view can
 * nest the child's prompt, steps and result under the parent's step.
 */

const SUBAGENT_ID =
  /subagent\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The child session id a `subagent` tool call reported, if any. */
export function subagentIdFromOutput(
  output: string | null | undefined
): string | null {
  const m = output ? SUBAGENT_ID.exec(output) : null;
  return m ? m[1].toLowerCase() : null;
}

type ContentPart = { type?: string; text?: string; [key: string]: unknown };

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) =>
      typeof p === "object" && p !== null && (p as ContentPart).type === "text"
        ? String((p as ContentPart).text ?? "")
        : ""
    )
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * The prompt dsh hands a subagent carries the task first, then the
 * workspace instructions it splices in as system reminders. The view wants
 * the task; the reminders are the same text every agent gets.
 */
function promptTextOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const texts = parts
    .map((p) =>
      typeof p === "object" && p !== null && (p as ContentPart).type === "text"
        ? String((p as ContentPart).text ?? "")
        : ""
    )
    .filter((t) => t.trim().length > 0 && !/^\s*<system-reminder>/.test(t));
  return texts.join("\n");
}

function toolResultText(message: Record<string, unknown> | undefined): {
  text: string;
  isError: boolean;
} {
  const content = Array.isArray(message?.content) ? message.content : [];
  const texts: string[] = [];
  let isError = false;
  for (const part of content as ContentPart[]) {
    if (part?.type !== "tool-result") continue;
    if (part.isError === true) isError = true;
    texts.push(textOf(part.content));
  }
  return { text: texts.filter(Boolean).join("\n"), isError };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

const OUTPUT_MAX = 32 * 1024;

type OpenStep = HarnessStep & { callId: string };

type Building = {
  prompt: string;
  startedAt: number;
  endedAt?: number;
  finalResult?: "ok" | "error";
  steps: HarnessStep[];
  texts: { text: string; at: number }[];
  open: Map<string, OpenStep>;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function finish(building: Building, id: number): HarnessTurn {
  const steps = [...building.steps];
  // Text the model produced before its last message reads as notes; the
  // last one is the turn's result.
  const last = building.texts[building.texts.length - 1];
  for (const note of building.texts.slice(0, -1)) {
    steps.push({
      id: `sub:${id}:note:${note.at}`,
      kind: "note",
      label:
        note.text
          .split("\n")
          .find((l) => l.trim())
          ?.slice(0, 120) ?? "",
      status: "ok",
      startedAt: iso(note.at),
      endedAt: iso(note.at),
      detail: { text: note.text },
    });
  }
  steps.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return {
    id: `sub:${id}`,
    prompt: { source: "chat", text: building.prompt, attachments: [] },
    trace: {
      startedAt: iso(building.startedAt),
      ...(building.endedAt !== undefined
        ? { endedAt: iso(building.endedAt) }
        : {}),
      ...(building.finalResult ? { finalResult: building.finalResult } : {}),
      steps,
    },
    result: last
      ? { text: last.text, streaming: building.endedAt === undefined }
      : null,
  };
}

/** Shape a subagent's session log into turns and a status line. */
export function shapeSubagent(
  sessionId: string,
  log: Pick<SessionLog, "header" | "events">
): HarnessSubagent {
  const turns: HarnessTurn[] = [];
  let current: Building | null = null;
  let label: string | undefined;
  let model: string | undefined;
  let turnCounter = 0;
  const closeCurrent = (at: number, result: "ok" | "error") => {
    if (!current) return;
    current.endedAt = at;
    current.finalResult = result;
    for (const step of current.open.values()) {
      step.status = "error";
      step.endedAt = iso(at);
    }
    turns.push(finish(current, turnCounter));
    current = null;
  };
  for (const event of log.events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const at = typeof event.time === "number" ? event.time : Date.now();
    switch (event.type) {
      case "subagent/descriptor": {
        if (typeof data.label === "string") label = data.label;
        if (typeof data.agentModel === "string") {
          model =
            typeof data.agentProvider === "string"
              ? `${data.agentProvider}/${data.agentModel}`
              : data.agentModel;
        }
        break;
      }
      case "user/message": {
        const text = promptTextOf(data.content);
        if (current) {
          // A message that lands mid-turn (the parent talking to it) is
          // part of the running turn's prompt.
          current.prompt = `${current.prompt}\n\n${text}`.trim();
          break;
        }
        turnCounter += 1;
        current = {
          prompt: text,
          startedAt: at,
          steps: [],
          texts: [],
          open: new Map(),
        };
        break;
      }
      case "tool/call": {
        if (!current) {
          turnCounter += 1;
          current = {
            prompt: "",
            startedAt: at,
            steps: [],
            texts: [],
            open: new Map(),
          };
        }
        const callId = String(data.callId ?? "");
        const name = String(data.name ?? "tool");
        const input = parseArguments(data.arguments);
        const step: OpenStep = {
          callId,
          id: `sub:${turnCounter}:${callId || at}`,
          kind: inferToolKind(null, name),
          label: name,
          status: "running",
          startedAt: iso(at),
          detail: {
            locations: locationsFromInput(input, null),
            ...(input !== undefined ? { input } : {}),
          },
        };
        current.steps.push(step);
        if (callId) current.open.set(callId, step);
        break;
      }
      case "tool/result": {
        if (!current) break;
        const message = data.message as Record<string, unknown> | undefined;
        const source = message?.source as { callId?: string } | undefined;
        const callId = String(source?.callId ?? "");
        const step = current.open.get(callId);
        if (!step) break;
        current.open.delete(callId);
        const { text, isError } = toolResultText(message);
        const clipped = text.length > OUTPUT_MAX;
        step.status = isError ? "error" : "ok";
        step.endedAt = iso(at);
        step.durMs = Math.max(0, at - Date.parse(step.startedAt));
        step.detail = {
          ...step.detail,
          terminalOutput: clipped ? text.slice(0, OUTPUT_MAX) : text,
          ...(clipped ? { truncated: true } : {}),
        };
        if (!step.detail.locations?.length) {
          step.detail.locations = locationsFromInput(step.detail.input, text);
        }
        break;
      }
      case "assistant/message": {
        if (!current) break;
        const message = data.message as Record<string, unknown> | undefined;
        const text = textOf(message?.content);
        if (text) current.texts.push({ text, at });
        break;
      }
      case "turn/end": {
        const reason = data.reason as { kind?: string } | undefined;
        closeCurrent(at, reason?.kind === "completed" ? "ok" : "error");
        break;
      }
      case "session/end":
      case "session/close": {
        closeCurrent(at, "ok");
        break;
      }
      default:
        break;
    }
  }
  if (current) turns.push(finish(current, turnCounter));
  const openTurn = turns.length > 0 && !turns[turns.length - 1].trace.endedAt;
  const first = turns[0];
  const lastTurn = turns[turns.length - 1];
  return {
    id: sessionId,
    ...(label ? { label } : {}),
    ...(model ? { model } : {}),
    status: turns.length === 0 ? "starting" : openTurn ? "running" : "finished",
    startedAt: iso(
      log.header?.createdAt ??
        (first ? Date.parse(first.trace.startedAt) : Date.now())
    ),
    ...(lastTurn?.trace.endedAt && !openTurn
      ? { endedAt: lastTurn.trace.endedAt }
      : {}),
    ...(log.header?.parentSession
      ? { parentSession: log.header.parentSession }
      : {}),
    turns,
  };
}
