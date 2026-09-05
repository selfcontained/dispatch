import { useCallback, useState } from "react";
import type { ChatUserAttachmentInput } from "@dispatch/shared";
import { useQueryClient } from "@tanstack/react-query";

import { ChatComposer } from "@/components/app/chat/chat-composer";
import type { Agent } from "@/components/app/types";
import { useSendChatMessage } from "@/hooks/use-chat";
import { uploadAgentMedia } from "@/lib/media-upload";

import { TurnStream } from "./turn-stream";
import { harnessTurnsQueryKey, useHarnessTurns } from "./use-harness-turns";

export type HarnessPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  /** The pane is on screen (its tab is active, or it sits in a split). */
  active: boolean;
  isMobile: boolean;
};

/**
 * The Harness view for a Dispatch Harness agent: the PromptKit turn stream
 * over the same composer Chat uses. Prompts go through the chat endpoint,
 * so the Chat tab and cross-agent messaging keep working unchanged.
 */
export function HarnessPane({
  agentId,
  agent,
  active,
  isMobile,
}: HarnessPaneProps): JSX.Element {
  const queryClient = useQueryClient();
  const { turns, liveTrace, liveText, streaming, loading, error } =
    useHarnessTurns(agentId);
  const send = useSendChatMessage(agentId);
  const { mutateAsync: sendAsync } = send;
  const [sendError, setSendError] = useState<string | null>(null);

  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ): Promise<void> => {
      setSendError(null);
      try {
        await sendAsync({ text, attachments });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Send failed.");
        throw err;
      }
      void queryClient.invalidateQueries({
        queryKey: harnessTurnsQueryKey(agentId),
        exact: true,
      });
    },
    [agentId, queryClient, sendAsync]
  );

  const uploadFile = useCallback(
    (file: File) => {
      if (!agentId) return Promise.reject(new Error("No agent selected."));
      return uploadAgentMedia(agentId, file, { source: "user", inject: false });
    },
    [agentId]
  );

  const disabledReason = !agent
    ? "No agent selected."
    : agent.status === "stopped"
      ? "This agent has stopped."
      : null;

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="harness-pane"
    >
      <TurnStream
        turns={turns}
        liveTrace={liveTrace}
        liveText={liveText}
        streaming={streaming}
        ariaLabel={`${agent?.name ?? "Agent"} harness conversation`}
        emptyState={
          <p
            className="pt-6 text-center text-xs text-muted-foreground"
            data-testid="harness-empty"
          >
            {loading
              ? "Loading…"
              : error
                ? `Could not load turns: ${error.message}`
                : "Send the first prompt."}
          </p>
        }
      />
      <div className="shrink-0 border-t border-border/40 px-3 pb-2 pt-2">
        {sendError ? (
          <div
            role="alert"
            className="mb-1 truncate text-[11px] text-destructive"
          >
            {sendError}
          </div>
        ) : null}
        <ChatComposer
          agentId={agentId}
          onSend={onSend}
          uploadFile={uploadFile}
          disabledReason={disabledReason}
          sending={send.isPending}
          autoFocus={active && !isMobile}
        />
      </div>
    </div>
  );
}
