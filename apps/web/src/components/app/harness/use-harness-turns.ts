import { useQuery } from "@tanstack/react-query";
import type {
  ChatAttachment,
  HarnessStep,
  HarnessTurn,
  HarnessTurnsResponse,
} from "@dispatch/shared";

import { api } from "@/lib/api";

import type { Attachment, Step, Trace, Turn } from "./contracts";

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

function toAttachment(a: ChatAttachment): Attachment {
  switch (a.type) {
    case "file":
      return {
        kind: a.mimeType?.startsWith("image/") ? "image" : "file",
        url: `/api/v1/media/${a.mediaId}`,
        name: a.fileName,
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
export function toPromptKitTurns(turns: HarnessTurn[]): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  streaming: boolean;
} {
  const out: Turn[] = [];
  let liveTrace: Trace | null = null;
  let liveText = "";
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
        ? { attachments: turn.prompt.attachments.map(toAttachment) }
        : {}),
      ...(turn.prompt.senderName
        ? { contextChips: [{ label: `from ${turn.prompt.senderName}` }] }
        : {}),
    });
    if (isLast && open) {
      liveTrace = toTrace(turn);
      liveText = turn.result?.text ?? "";
      streaming = true;
      return;
    }
    out.push({
      id: `${turn.id}:assistant`,
      role: "assistant",
      content: turn.result?.text ?? "",
      timestamp: Date.parse(turn.trace.endedAt ?? turn.trace.startedAt),
      trace: toTrace(turn),
      ...(turn.error
        ? { error: { code: "turn_failed", message: turn.error } }
        : {}),
    });
  });
  return { turns: out, liveTrace, liveText, streaming };
}

export function useHarnessTurns(agentId: string | null): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  streaming: boolean;
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
  const mapped = toPromptKitTurns(query.data?.turns ?? []);
  return { ...mapped, loading: query.isLoading, error: query.error };
}
