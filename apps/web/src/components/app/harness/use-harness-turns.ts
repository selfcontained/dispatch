import { useQuery } from "@tanstack/react-query";
import type {
  ChatAttachment,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessTurn,
  HarnessTurnsResponse,
} from "@dispatch/shared";

import { api } from "@/lib/api";

import type { Attachment, Step, Trace, Turn } from "./contracts";
import { turnLabelFromSteps } from "./registry";

export const HARNESS_TURNS_LIMIT = 50;

export function harnessTurnsQueryKey(agentId: string | null) {
  return ["harness-turns", agentId] as const;
}

function toStep(step: HarnessStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
  };
}

function toTrace(turn: HarnessTurn): Trace {
  return {
    startedAt: Date.parse(turn.trace.startedAt),
    ...(turn.trace.endedAt ? { endedAt: Date.parse(turn.trace.endedAt) } : {}),
    ...(turn.trace.finalResult ? { finalResult: turn.trace.finalResult } : {}),
    steps: turn.trace.steps.map(toStep),
  };
}

/** Where a shared file is served: the same route the Chat feed uses. */
export function mediaFileUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function toAttachment(
  a: ChatAttachment,
  agentId: string,
  at: string
): Attachment {
  switch (a.type) {
    case "file":
      return {
        kind:
          a.mimeType?.startsWith("image/") || IMAGE_EXT.test(a.fileName)
            ? "image"
            : "file",
        url: mediaFileUrl(agentId, a.fileName),
        name: a.fileName,
        size: a.sizeBytes,
        at,
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      };
    case "link":
    case "pr":
      return { kind: a.type, url: a.url, name: a.title ?? a.url };
    case "code":
      return { kind: "code", url: "", name: a.path ?? a.language ?? "code" };
    case "pin":
      return { kind: "pin", url: "", name: a.pinId };
  }
}

/**
 * Map the server's turns onto the PromptKit turn model: one user turn and
 * one assistant turn per settled HarnessTurn; the last turn, while still
 * open, becomes the live trace and live text instead.
 */
export function toPromptKitTurns(
  turns: HarnessTurn[],
  agentId: string
): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  liveQuestions: HarnessQuestion[];
  streaming: boolean;
} {
  const out: Turn[] = [];
  let liveTrace: Trace | null = null;
  let liveText = "";
  let liveQuestions: HarnessQuestion[] = [];
  let streaming = false;
  turns.forEach((turn, index) => {
    const isLast = index === turns.length - 1;
    const open = turn.trace.endedAt === undefined;
    out.push({
      id: `${turn.id}:user`,
      role: "user",
      content: turn.prompt.text,
      timestamp: Date.parse(turn.trace.startedAt),
      extra: { source: turn.prompt.source },
      ...(turn.prompt.attachments.length
        ? {
            attachments: turn.prompt.attachments.map((a) =>
              toAttachment(a, agentId, turn.trace.startedAt)
            ),
          }
        : {}),
      ...(turn.prompt.senderName
        ? { contextChips: [{ label: `from ${turn.prompt.senderName}` }] }
        : {}),
    });
    if (isLast && open) {
      liveTrace = toTrace(turn);
      liveText = turn.result?.text ?? "";
      liveQuestions = turn.questions ?? [];
      streaming = true;
      return;
    }
    const trace = toTrace(turn);
    out.push({
      id: `${turn.id}:assistant`,
      role: "assistant",
      content: turn.result?.text ?? "",
      timestamp: Date.parse(turn.trace.endedAt ?? turn.trace.startedAt),
      trace,
      ...(turn.error
        ? { error: { code: "turn_failed", message: turn.error } }
        : {}),
      extra: {
        ...(turn.questions?.length ? { questions: turn.questions } : {}),
        label: turn.label ?? turnLabelFromSteps(trace.steps),
      },
    });
  });
  return { turns: out, liveTrace, liveText, liveQuestions, streaming };
}

/** Chat prompts in order, without immediate repeats. */
export function promptHistoryOf(turns: Turn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" || turn.extra?.source !== "chat") continue;
    const text = turn.content.trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

export function useHarnessTurns(agentId: string | null): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  liveQuestions: HarnessQuestion[];
  streaming: boolean;
  /** Prompts waiting behind the live turn, first to run first. */
  queued: HarnessQueuedPrompt[];
  /** What the user typed before, oldest first, for the composer's history. */
  promptHistory: string[];
  loading: boolean;
  error: Error | null;
} {
  const query = useQuery({
    queryKey: harnessTurnsQueryKey(agentId),
    queryFn: () =>
      api<HarnessTurnsResponse>(
        `/api/v1/agents/${agentId}/harness/turns?limit=${HARNESS_TURNS_LIMIT}`
      ),
    enabled: agentId !== null,
    staleTime: 5_000,
  });
  const mapped = toPromptKitTurns(query.data?.turns ?? [], agentId ?? "");
  return {
    ...mapped,
    promptHistory: promptHistoryOf(mapped.turns),
    queued: query.data?.queued ?? [],
    loading: query.isLoading,
    error: query.error,
  };
}
