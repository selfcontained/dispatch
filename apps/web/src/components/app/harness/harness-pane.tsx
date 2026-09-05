import { useCallback, useMemo, useState } from "react";
import type { ChatUserAttachmentInput } from "@dispatch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";

import {
  ChatComposer,
  type SlashItem,
} from "@/components/app/chat/chat-composer";
import type { Agent } from "@/components/app/types";
import { useSendChatMessage } from "@/hooks/use-chat";
import { uploadAgentMedia } from "@/lib/media-upload";

import { ModelPicker } from "./model-picker";
import { TurnStream } from "./turn-stream";
import {
  currentChoiceName,
  useHarnessConfig,
  useSetHarnessConfig,
} from "./use-harness-config";
import { useHarnessSkills } from "./use-harness-skills";
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
  const skills = useHarnessSkills(agentId);
  const config = useHarnessConfig(agentId);
  const setConfig = useSetHarnessConfig(agentId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const slashItems = useMemo<SlashItem[]>(
    () => [
      {
        name: "model",
        description: "Choose the model and reasoning effort",
        command: true,
      },
      ...skills,
    ],
    [skills]
  );
  const onSlashCommand = useCallback((name: string) => {
    if (name !== "model") return false;
    setPickerOpen(true);
    return true;
  }, []);
  const applyConfig = useCallback(
    async (changes: { configId: string; value: string }[]) => {
      setConfigError(null);
      try {
        for (const change of changes) await setConfig.mutateAsync(change);
        setPickerOpen(false);
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : "Could not apply.");
      }
    },
    [setConfig]
  );
  const modelName = currentChoiceName(config.model);
  const effortName = currentChoiceName(config.effort);
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
        <div className="mb-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Model and reasoning effort (or type /model)"
            data-testid="harness-model-chip"
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground"
          >
            <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {config.running
                ? `${modelName ?? "model"}${effortName ? ` · ${effortName.toLowerCase()}` : ""}`
                : "model · not running"}
            </span>
          </button>
        </div>
        <ModelPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          model={config.model}
          effort={config.effort}
          running={config.running}
          saving={setConfig.isPending}
          error={configError}
          onApply={applyConfig}
        />
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
          slashItems={slashItems}
          onSlashCommand={onSlashCommand}
        />
      </div>
    </div>
  );
}
