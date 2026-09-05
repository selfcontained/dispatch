import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ChatQuestionOption,
  ChatUserAttachmentInput,
  HarnessQuestion,
} from "@dispatch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, Upload } from "lucide-react";

import {
  ChatComposer,
  type SlashItem,
} from "@/components/app/chat/chat-composer";
import { questionExcerpt } from "@/components/app/chat/chat-pane";
import type { Agent, MediaFile } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { useAnswerChatQuestion, useSendChatMessage } from "@/hooks/use-chat";
import { uploadAgentMedia } from "@/lib/media-upload";

import type { Attachment } from "./contracts";
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
  /** Opens a shared file in the media lightbox. */
  openLightbox?: (file: MediaFile) => void;
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
  openLightbox,
}: HarnessPaneProps): JSX.Element {
  const queryClient = useQueryClient();
  const {
    turns,
    liveTrace,
    liveText,
    liveQuestions,
    streaming,
    loading,
    error,
  } = useHarnessTurns(agentId);
  const send = useSendChatMessage(agentId);
  const answer = useAnswerChatQuestion(agentId);
  const { mutateAsync: sendAsync } = send;
  const { mutateAsync: answerAsync } = answer;
  const skills = useHarnessSkills(agentId);
  const config = useHarnessConfig(agentId);
  const setConfig = useSetHarnessConfig(agentId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // A file dropped anywhere on the pane attaches to the composer.
  const dropRef = useRef<HTMLDivElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);

  const invalidateTurns = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: harnessTurnsQueryKey(agentId),
      exact: true,
    });
  }, [agentId, queryClient]);

  // The newest open question that takes a typed reply: what gets typed
  // answers it, unless the user opted out with the chip's ×.
  const openFreeform = useMemo<HarnessQuestion | null>(() => {
    const all: HarnessQuestion[] = [];
    for (const turn of turns) {
      const list = turn.extra?.questions;
      if (Array.isArray(list)) all.push(...(list as HarnessQuestion[]));
    }
    all.push(...liveQuestions);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const q = all[i];
      if (q.answer !== null) continue;
      return q.allowFreeform ? q : null;
    }
    return null;
  }, [turns, liveQuestions]);
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
    null
  );
  const replyTarget =
    openFreeform && openFreeform.id !== dismissedQuestionId
      ? openFreeform
      : null;

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

  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ): Promise<void> => {
      setSendError(null);
      try {
        if (replyTarget) {
          await answerAsync({
            messageId: replyTarget.id,
            value: text,
            attachments,
          });
        } else {
          await sendAsync({ text, attachments });
        }
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Send failed.");
        throw err;
      }
      invalidateTurns();
    },
    [answerAsync, invalidateTurns, replyTarget, sendAsync]
  );

  const onAnswer = useCallback(
    (questionId: string, option: ChatQuestionOption) => {
      setSendError(null);
      answerAsync({
        messageId: questionId,
        value: option.value ?? option.label,
        label: option.label,
      })
        .then(invalidateTurns)
        .catch((err: unknown) => {
          setSendError(err instanceof Error ? err.message : "Answer failed.");
        });
    },
    [answerAsync, invalidateTurns]
  );

  const uploadFile = useCallback(
    (file: File) => {
      if (!agentId) return Promise.reject(new Error("No agent selected."));
      return uploadAgentMedia(agentId, file, { source: "user", inject: false });
    },
    [agentId]
  );

  const onAttachmentClick = useCallback(
    (a: Attachment) => {
      if (!agentId || !openLightbox || !a.name) return;
      openLightbox({
        // ownerAgentId is part of the lightbox identity; without it the
        // synthesized file never matches the media list and nothing opens.
        ownerAgentId: agentId,
        name: a.name,
        size: a.size ?? 0,
        updatedAt: a.at ?? new Date().toISOString(),
        url: a.url,
      });
    },
    [agentId, openLightbox]
  );

  // The pane is up before the harness is: setup (worktree, dependencies)
  // runs first, and a prompt sent then has nowhere to go.
  const starting = agent?.status === "creating";
  const disabledReason = !agent
    ? "No agent selected."
    : starting
      ? "The agent is still starting up."
      : agent.status === "stopped" || agent.status === "stopping"
        ? "This agent has stopped."
        : agent.status === "error"
          ? "The harness is not running. Press Start to relaunch it."
          : null;
  const modelName = currentChoiceName(config.model);
  const effortName = currentChoiceName(config.effort);
  const answeringId = answer.isPending
    ? (answer.variables?.messageId ?? null)
    : null;

  return (
    <div
      ref={dropRef}
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      data-testid="harness-pane"
      data-dragging={draggingFiles ? "true" : undefined}
    >
      {draggingFiles ? (
        <div
          data-testid="harness-drop-overlay"
          className="pointer-events-none absolute inset-0 z-40 m-2 overflow-hidden rounded-xl bg-[linear-gradient(to_right,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)))] p-[2px] saturate-[1.35] brightness-[1.05]"
        >
          <div className="relative grid h-full w-full place-items-center overflow-hidden rounded-[10px] bg-background/85 backdrop-blur-sm">
            <div className="dispatch-reconnect-scan pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[reconnect-scan_1350ms_ease-in-out_infinite] bg-[linear-gradient(to_right,transparent,hsl(var(--status-working)),transparent)] opacity-25 will-change-transform motion-reduce:hidden" />
            <div className="relative flex flex-col items-center gap-2 px-6 text-center text-foreground">
              <Upload className="h-8 w-8" />
              <p className="text-sm font-medium">Drop files to attach</p>
              <p className="text-xs text-muted-foreground">
                They go with your next message.
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <TurnStream
        turns={turns}
        liveTrace={liveTrace}
        liveText={liveText}
        liveQuestions={liveQuestions}
        streaming={streaming}
        ariaLabel={`${agent?.name ?? "Agent"} harness conversation`}
        onAttachmentClick={onAttachmentClick}
        onAnswer={onAnswer}
        answeringId={answeringId}
        answersDisabled={disabledReason !== null}
        emptyState={
          starting ? (
            <div
              className="flex flex-col items-center gap-3 pt-10 text-center"
              data-testid="harness-starting"
            >
              <ActivityBars size={28} />
              <p className="text-xs text-foreground">Starting the harness…</p>
              {agent?.latestEvent?.message ? (
                <p className="text-[11px] text-muted-foreground">
                  {agent.latestEvent.message}
                </p>
              ) : null}
            </div>
          ) : (
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
          )
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
            {starting || (!config.running && agent?.status === "running") ? (
              <ActivityBars size={10} className="shrink-0" />
            ) : (
              <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">
              {config.running
                ? `${modelName ?? "model"}${effortName ? ` · ${effortName.toLowerCase()}` : ""}`
                : starting || agent?.status === "running"
                  ? "starting…"
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
          sending={send.isPending || answer.isPending}
          autoFocus={active && !isMobile}
          slashItems={slashItems}
          onSlashCommand={onSlashCommand}
          dropTargetRef={dropRef}
          onDropZoneDragging={setDraggingFiles}
          replyContext={
            replyTarget
              ? {
                  excerpt: questionExcerpt(replyTarget.text),
                  onDismiss: () => setDismissedQuestionId(replyTarget.id),
                }
              : null
          }
        />
      </div>
    </div>
  );
}
