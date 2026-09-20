import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChatFeedEntry,
  ChatTurnEntry,
  ChatUserAttachmentInput,
  HarnessPath,
} from "@dispatch/shared";
import { harnessEngineOf } from "@dispatch/shared";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "jotai";
import { CircleDollarSign, Cpu, LogIn, Pencil, Square } from "lucide-react";

import { chatDraftAtomFamily } from "@/lib/store";
import type { SlashItem } from "@/components/app/chat/chat-composer";
import { QueuedStack } from "@/components/app/chat/turn/queued-prompt";
import {
  arrive,
  DURATION,
  exitShrink,
  fadeVariants,
} from "@/components/app/chat/turn/motion";
import type { TodoItem } from "@/components/app/chat/turn/registry";
import { TasksStrip } from "@/components/app/chat/turn/tasks-strip";
import { BackgroundProcesses } from "@/components/app/harness/background-processes";
import { useHarnessCommands } from "@/components/app/harness/use-harness-commands";
import { useHarnessPathPicker } from "@/components/app/harness/use-harness-paths";
import { ModelPicker } from "@/components/app/harness/model-picker";
import { ProviderIcon } from "@/components/app/harness/provider-icon";
import { UsageDialog } from "@/components/app/harness/usage-dialog";
import type { ContextUsage } from "@/components/app/harness/usage-dialog";
import { AuthStatusBadge } from "@/components/app/harness/auth-status-badge";
import { useHarnessAuth } from "@/components/app/harness/use-harness-auth";
import {
  currentChoiceName,
  useHarnessConfig,
  useSetHarnessConfig,
} from "@/components/app/harness/use-harness-config";
import {
  useHarnessInterrupt,
  useHarnessQueue,
  useQueuedPrompts,
  useEditTurn,
} from "@/components/app/harness/use-harness-queue";
import type { Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { agentStartupStage } from "./agent-startup";

/**
 * What Enter and the arrows do right now, in the composer's helper line.
 *
 * On a touch keyboard neither ArrowUp nor Ctrl+C exists, and the full string
 * wraps to three lines under a narrow field, so only the Enter half is worth
 * saying there. The Stop button and the queued row's own Send now / Remove
 * cover the rest.
 */
export function composerHint(
  streaming: boolean,
  queuedCount: number,
  isMobile = false
): string | undefined {
  if (!streaming && queuedCount === 0) return undefined;
  const parts = [
    streaming
      ? "Agent is working · Enter queues your message"
      : "Message queued",
  ];
  if (isMobile) return parts[0];
  if (queuedCount > 0) parts.push("↑ edits the newest queued message");
  if (streaming) parts.push("Ctrl+C stops");
  return parts.join(" · ");
}

/**
 * `useChatFeed` hands over one ascending list across every page it holds
 * (`flattenFeedPages`), so one walk back from the end needs no page
 * bookkeeping. Rows created while the turn ran carry their own later
 * timestamps and sit after it, which is why this looks past the tail.
 */
export function newestTurnEntry(
  entries: readonly ChatFeedEntry[]
): ChatTurnEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "turn") return entry;
  }
  return null;
}

/**
 * A running turn carries its plan the same way a settled one does, so
 * unlike the turns-endpoint version this needs no live/settled split.
 */
export function latestTurnPlan(entries: readonly ChatFeedEntry[]): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "turn" || entry.plan === undefined) continue;
    return entry.plan.map((e) => ({ content: e.content, status: e.status }));
  }
  return [];
}

/**
 * For the composer's ArrowUp history, so only prompts that came from the
 * composer: a launch post, a prompt from another agent and an injected one
 * were never typed here.
 */
export function harnessPromptHistory(
  entries: readonly ChatFeedEntry[]
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "turn" || entry.prompt.source !== "chat") continue;
    const text = entry.prompt.text.trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

export function latestContextUsage(
  entries: readonly ChatFeedEntry[],
  sessionStartedAt?: string
): ContextUsage | null {
  if (!sessionStartedAt) return null;
  const started = Date.parse(sessionStartedAt);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "turn" || !entry.usage) continue;
    if (Date.parse(entry.at) < started) continue;
    return {
      used: entry.usage.used,
      size: entry.usage.size,
      costUsd: entry.usage.costUsd,
    };
  }
  return null;
}

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-3";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export type HarnessChromeInput = {
  /**
   * The agent id for a Dispatch Harness agent, null for every other type.
   * Nulling it here is what makes the whole hook inert: every harness query
   * below is keyed off it and disabled while it is null, and `chrome` is
   * null too, so no other agent type pays for this or renders any of it.
   */
  agentId: string | null;
  agent: Agent | null;
  /** The feed's entries, oldest first, across every page loaded. */
  entries: readonly ChatFeedEntry[];
  isMobile: boolean;
  /** Reports an action failure to the pane's one error slot. */
  onError: (message: string | null) => void;
  /** Reveals the harness shell where an interactive provider login runs. */
  onOpenConsole?: () => void;
};

export function isHarnessAuthFailure(message: string | null | undefined) {
  return Boolean(
    message &&
    /auth(?:entication)?(?:[_ ]failed| required)|failed to authenticate|not logged in|sign[ -]?in required|oauth session expired|token (?:has )?expired/i.test(
      message
    )
  );
}

/**
 * Every field is absent for an agent that is not a Dispatch Harness agent,
 * so spreading this onto the composer is a no-op for the rest.
 */
export type HarnessComposerProps = {
  slashItems?: SlashItem[];
  onSlashCommand?: (name: string) => boolean;
  hint?: string;
  history?: string[];
  recallQueued?: () => Promise<string | null>;
  atItems?: HarnessPath[];
  onAtQuery?: (query: string | null) => void;
  onInterrupt?: () => void;
  editContext?: {
    onSubmit: (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ) => Promise<void>;
    onCancel: () => void;
  } | null;
};

/** A running turn's message open in the composer, and what the field held before. */
type EditingTurn = { agentId: string; chatMessageId: string; stash: string };

/** Frozen so a non-dispatch pane hands the composer the same object every render. */
const EMPTY_COMPOSER_PROPS: HarnessComposerProps = Object.freeze({});

export type HarnessChrome = {
  /** The chrome above the composer; null for every agent type but dispatch. */
  chrome: ReactNode;
  /** Spread into `ChatComposer`; empty for every agent type but dispatch. */
  composer: HarnessComposerProps;
};

/**
 * Everything live comes from the chat feed the pane already holds: the
 * running turn and the plan are reads over its `turn` entries, so there is
 * no second query and no second cache. What is not feed-shaped stays on its
 * own query: the session's model config, and the queue, which is in-memory
 * state on the server rather than a row.
 */
export function useHarnessChrome({
  agentId,
  agent,
  entries,
  isMobile,
  onError,
  onOpenConsole,
}: HarnessChromeInput): HarnessChrome {
  const { queued } = useQueuedPrompts(agentId);
  const {
    sendNow: sendQueuedNow,
    remove: removeQueued,
    busyId: queueBusyId,
  } = useHarnessQueue(agentId);
  const { interrupt, interrupting } = useHarnessInterrupt(agentId);
  const { editTurn } = useEditTurn(agentId);
  const store = useStore();
  const [editing, setEditing] = useState<EditingTurn | null>(null);
  const replacingRef = useRef(false);
  const config = useHarnessConfig(agentId);
  const setConfig = useSetHarnessConfig(agentId);
  const commands = useHarnessCommands(agentId);
  const pathPicker = useHarnessPathPicker(agentId);
  const auth = useHarnessAuth(agentId !== null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  // The tasks strip's fold, kept here so a new list does not reopen it.
  const [tasksExpanded, setTasksExpanded] = useState(!isMobile);

  const newest = useMemo(() => newestTurnEntry(entries), [entries]);
  const streaming = newest !== null && !newest.settled;
  // Nothing is in progress unless a turn is running. The server settles
  // the list when a turn ends; this keeps the strip honest in the moment
  // between the turn ending and the settled list arriving.
  const tasks = useMemo(() => {
    const plan = latestTurnPlan(entries);
    return streaming
      ? plan
      : plan.map((task) =>
          task.status === "in_progress"
            ? { ...task, status: "pending" as const }
            : task
        );
  }, [entries, streaming]);
  const tasksOpen = tasks.some((t) => t.status !== "completed");
  const history = useMemo(() => harnessPromptHistory(entries), [entries]);
  const contextUsage = useMemo(
    () => latestContextUsage(entries, config.sessionStartedAt),
    [entries, config.sessionStartedAt]
  );

  const applyConfig = useCallback(
    async (changes: { configId: string; value: string }[]) => {
      setConfigError(null);
      try {
        for (const change of changes) await setConfig.mutateAsync(change);
        setPickerOpen(false);
      } catch (err) {
        setConfigError(errorText(err, "Could not apply."));
      }
    },
    [setConfig]
  );

  const slashItems = useMemo<SlashItem[]>(
    () => [
      {
        name: "model",
        description: "Choose the model and reasoning effort",
        command: true,
      },
      {
        name: "usage",
        description: "Tokens and cost this month",
        command: true,
      },
      ...commands,
    ],
    [commands]
  );
  const onSlashCommand = useCallback((name: string) => {
    if (name === "model") {
      setPickerOpen(true);
      return true;
    }
    if (name === "usage") {
      setUsageOpen(true);
      return true;
    }
    return false;
  }, []);

  const onSendNow = useCallback(
    (id: string) => {
      onError(null);
      sendQueuedNow(id).catch((err: unknown) => {
        onError(errorText(err, "Could not send."));
      });
    },
    [onError, sendQueuedNow]
  );
  const onRemoveQueued = useCallback(
    (id: string) => {
      onError(null);
      removeQueued(id).catch((err: unknown) => {
        onError(errorText(err, "Could not remove."));
      });
    },
    [onError, removeQueued]
  );
  const onStop = useCallback(() => {
    onError(null);
    interrupt().catch((err: unknown) => {
      onError(errorText(err, "Could not stop."));
    });
  }, [interrupt, onError]);

  // Edit is offered only for a turn the user's own message started, and only
  // when that message carried no attachments: the draft takes text, not
  // chips, and the replacement is sent as text. Same rule the queued ArrowUp
  // recall follows.
  const editableId =
    streaming &&
    newest?.prompt.source === "chat" &&
    newest.prompt.attachments.length === 0
      ? (newest.prompt.chatMessageId ?? null)
      : null;
  const editable = editableId !== null && editing === null;

  // Opening the editor touches nothing but the draft: the agent keeps
  // working until the edit is sent. What was in the field is kept aside and
  // comes back when the edit is sent or cancelled.
  const onEdit = useCallback(() => {
    if (!agentId || !editableId || !newest) return;
    onError(null);
    const draftAtom = chatDraftAtomFamily(agentId);
    const stash = store.get(draftAtom).text;
    store.set(draftAtom, (draft) => ({ ...draft, text: newest.prompt.text }));
    setEditing({ agentId, chatMessageId: editableId, stash });
  }, [agentId, editableId, newest, onError, store]);

  const leaveEdit = useCallback(
    (from: EditingTurn, restore: boolean) => {
      if (restore) {
        store.set(chatDraftAtomFamily(from.agentId), (draft) => ({
          ...draft,
          text: from.stash,
        }));
      }
      setEditing(null);
    },
    [store]
  );

  const onCancelEdit = useCallback(() => {
    if (editing) leaveEdit(editing, true);
  }, [editing, leaveEdit]);

  const onSubmitEdit = useCallback(
    async (text: string, attachments: ChatUserAttachmentInput[]) => {
      if (!editing) return;
      if (attachments.length > 0) {
        throw new Error(
          "An edit is sent as text. Remove the attachments, or cancel the edit and send a new message."
        );
      }
      onError(null);
      replacingRef.current = true;
      try {
        await editTurn({ chatMessageId: editing.chatMessageId, text });
        // The stash goes back before the composer clears what it sent: it
        // only clears a field that still holds the sent text.
        leaveEdit(editing, true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The turn ended on its own first. Nothing was stopped or
          // deleted, and the text stays in the field as a new message.
          setEditing(null);
          throw new Error(
            "The agent finished that turn before your edit arrived. Your text is still here: send it as a new message."
          );
        }
        throw err;
      } finally {
        replacingRef.current = false;
      }
    },
    [editTurn, editing, leaveEdit, onError]
  );

  // The turn being edited can end underneath the editor. There is then
  // nothing to replace, so the edit becomes an ordinary draft, and says so.
  // While a replace is in flight the turn ends because we stopped it.
  useEffect(() => {
    if (!editing || replacingRef.current) return;
    if (editing.agentId !== agentId) {
      leaveEdit(editing, true);
      return;
    }
    const stillRunning =
      newest !== null &&
      !newest.settled &&
      newest.prompt.chatMessageId === editing.chatMessageId;
    if (stillRunning) return;
    setEditing(null);
    onError(
      "The agent finished that turn, so there is nothing to replace. Your text is still in the field and will send as a new message."
    );
  }, [agentId, editing, leaveEdit, newest, onError]);

  // ArrowUp on an empty field takes the newest message the user queued back
  // to edit. Only their own: the queue also holds prompts another agent or
  // Dispatch itself sent, and recalling one of those would delete an
  // undelivered message and put its words in the user's draft. Same rule as
  // `harnessPromptHistory`, which the other half of ArrowUp walks. One with
  // attachments stays queued: the chips cannot come back into the draft, so
  // it keeps Send now and Remove instead.
  const recallQueued = useCallback(async () => {
    const last = queued.findLast((prompt) => prompt.source === "chat");
    if (!last) return null;
    onError(null);
    if (last.attachments.length > 0) {
      onError(
        "The queued message has attachments; use Send now or Remove on it."
      );
      return null;
    }
    try {
      await removeQueued(last.id);
    } catch (err) {
      onError(errorText(err, "That message already started."));
      throw err;
    }
    return last.text;
  }, [onError, queued, removeQueued]);

  // The pane is up before the harness is: setup (worktree, dependencies)
  // runs first, and a prompt sent then has nowhere to go.
  const starting = agentStartupStage(agent) !== null;
  const errored =
    agent?.status === "error" ||
    (agent?.status === "stopped" && Boolean(agent.lastError));
  const statusMessage =
    (errored ? agent?.lastError?.trim() : null) ||
    agent?.latestEvent?.message?.trim() ||
    null;
  const engine = harnessEngineOf(agent?.model);
  const engineAuth = auth.data?.engines.find(
    (item) => item.engineId === engine?.id
  );
  const runtimeNeedsLogin =
    isHarnessAuthFailure(statusMessage) ||
    (newest?.trace.finalResult === "error" &&
      isHarnessAuthFailure(
        `${newest.error ?? ""} ${newest.result?.text ?? ""}`
      ));
  const loginRequired =
    Boolean(engine) &&
    (engineAuth?.kind === "not_signed_in" || runtimeNeedsLogin);
  const modelName = currentChoiceName(config.model);
  const effortName = currentChoiceName(config.effort);
  const fixedReason =
    engine && !engine.publishesModelOption
      ? `${engine.label} sets its model at launch.`
      : null;
  const launchModel = agent?.model?.includes("/")
    ? agent.model.slice(agent.model.indexOf("/") + 1)
    : null;
  const chipLabel = fixedReason
    ? `${engine?.label ?? "Engine"} · ${launchModel === "default" || !launchModel ? "default" : launchModel} · fixed`
    : config.running
      ? `${engine?.label ?? "Engine"} · ${modelName ?? "model"}${effortName ? ` · ${effortName.toLowerCase()}` : ""}`
      : starting || agent?.status === "running"
        ? "starting…"
        : "model · not running";
  /**
   * Shown whatever the feed holds, which is the point: the old surface said
   * this in an empty state, so a start failure, an engine exit and a login
   * that lapsed after the agent had already run were all invisible to an
   * agent with history.
   */
  const statusLine = errored ? statusMessage : null;
  const loginCommand = loginRequired ? engine?.loginCommand : null;
  const startLogin = useCallback(async () => {
    if (!agentId || !engine || !onOpenConsole) return;
    setLoginStarting(true);
    onError(null);
    try {
      await api<null>(`/api/v1/agents/${agentId}/terminal/inject-text`, {
        method: "POST",
        body: JSON.stringify({ text: engine.loginCommand, submit: true }),
      });
      onOpenConsole();
    } catch (err) {
      onError(errorText(err, `Could not start ${engine.label} login.`));
    } finally {
      setLoginStarting(false);
    }
  }, [agentId, engine, onError, onOpenConsole]);

  const composer = useMemo<HarnessComposerProps>(
    () =>
      agentId === null
        ? EMPTY_COMPOSER_PROPS
        : {
            slashItems,
            onSlashCommand,
            // While editing, Enter does not queue: it replaces.
            hint: editing
              ? "Enter stops the agent and sends your edit · Esc cancels"
              : composerHint(streaming, queued.length, isMobile),
            history,
            recallQueued,
            atItems: pathPicker.items,
            onAtQuery: pathPicker.onQuery,
            // Absent when nothing runs, so Ctrl+C keeps its meaning.
            ...(streaming ? { onInterrupt: onStop } : {}),
            ...(editing
              ? {
                  editContext: {
                    onSubmit: onSubmitEdit,
                    onCancel: onCancelEdit,
                  },
                }
              : {}),
          },
    [
      agentId,
      editing,
      onCancelEdit,
      onSubmitEdit,
      history,
      isMobile,
      onSlashCommand,
      onStop,
      pathPicker.items,
      pathPicker.onQuery,
      queued.length,
      recallQueued,
      slashItems,
      streaming,
    ]
  );

  const chrome =
    agentId === null ? null : (
      <>
        {statusLine ? (
          <div className="mb-1.5 text-[11px]" data-testid="harness-status-line">
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "min-w-0 break-words",
                  errored ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {statusLine}
              </span>
            </div>
            {loginCommand ? (
              <p
                className="mt-1 break-words text-muted-foreground"
                data-testid="harness-login-hint"
              >
                Run as the service user, then press Start:{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                  {loginCommand}
                </code>
              </p>
            ) : null}
          </div>
        ) : null}
        {loginCommand && !statusLine ? (
          <p
            className="mb-1.5 text-[11px] text-muted-foreground"
            data-testid="harness-login-hint"
          >
            {engine?.label} needs you to sign in.
          </p>
        ) : null}
        {loginCommand && onOpenConsole ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="mb-2 h-7 text-xs"
            onClick={() => void startLogin()}
            disabled={loginStarting}
            data-testid="harness-login-action"
          >
            <LogIn className="mr-1.5 h-3.5 w-3.5" />
            {loginStarting ? "Opening Terminal…" : `Log in to ${engine?.label}`}
          </Button>
        ) : null}
        {/* Driven by `starting` rather than keyed on it, so the chips keep
          their nodes (and their dialogs) across the handoff. While faded out
          the block also stops taking clicks and focus: opacity alone leaves
          an invisible chip both clickable and tabbable. */}
        <motion.div
          animate={starting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
          transition={arrive(DURATION.slow)}
          className={cn("min-w-0", starting && "pointer-events-none")}
          data-testid="chat-harness-chrome"
          data-starting={starting ? "true" : undefined}
        >
          <QueuedStack
            queued={queued}
            busyId={queueBusyId}
            onSendNow={onSendNow}
            onRemove={onRemoveQueued}
          />
          {agentId ? (
            <BackgroundProcesses key={agentId} agentId={agentId} />
          ) : null}
          <AnimatePresence initial={false}>
            {tasksOpen ? (
              <motion.div
                key="tasks"
                data-testid="harness-tasks-presence"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={exitShrink}
                transition={arrive()}
                style={{ overflow: "hidden" }}
              >
                <TasksStrip
                  items={tasks}
                  paused={!streaming}
                  open={tasksExpanded}
                  onOpenChange={setTasksExpanded}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              title={
                fixedReason ?? "Model and reasoning effort (or type /model)"
              }
              data-testid="harness-model-chip"
              data-fixed={fixedReason ? "true" : undefined}
              disabled={starting}
              tabIndex={starting ? -1 : 0}
              className={cn(
                CHIP_CLASS,
                // min-w-0 or the button's min-content is the whole nowrap
                // label, and the span's `truncate` never engages: the usage
                // chip and Stop get pushed off a narrow pane instead.
                "min-w-0 max-w-full",
                fixedReason && "opacity-70"
              )}
            >
              {starting || (!config.running && agent?.status === "running") ? (
                <ActivityBars size={10} className="shrink-0" />
              ) : engine ? (
                <ProviderIcon provider={engine.id} />
              ) : (
                <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
              )}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={chipLabel}
                  data-testid="harness-model-chip-label"
                  className="truncate"
                  variants={fadeVariants}
                  initial="hidden"
                  animate="shown"
                  exit="hidden"
                  transition={arrive(DURATION.fast)}
                >
                  {chipLabel}
                </motion.span>
              </AnimatePresence>
            </button>
            {engineAuth ? (
              <AuthStatusBadge
                auth={engineAuth}
                compact
                className="max-w-[11rem] rounded-full border border-border/60 px-2 py-0.5 text-[11px] pointer-coarse:min-h-11 pointer-coarse:px-3 max-sm:max-w-[9rem]"
              />
            ) : null}
            <button
              type="button"
              onClick={() => setUsageOpen(true)}
              title="Context and provider usage (or type /usage)"
              data-testid="harness-usage-chip"
              disabled={starting}
              tabIndex={starting ? -1 : 0}
              className={CHIP_CLASS}
            >
              <CircleDollarSign
                className="h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              {contextUsage?.size
                ? `${Math.round((contextUsage.used / contextUsage.size) * 100)}% context`
                : "usage"}
            </button>
            {/* Edit opens the running turn's message in the composer. Nothing
              is stopped until the edit is sent; then the turn and its message
              go and the new text runs in their place. */}
            <button
              type="button"
              onClick={onEdit}
              disabled={!editable}
              aria-hidden={!editable}
              tabIndex={editable ? 0 : -1}
              title="Edit your message. The agent keeps working until you send the edit."
              data-testid="harness-edit-turn"
              className={cn(
                "ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3",
                !editable && "hidden"
              )}
            >
              <Pencil className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              Edit
            </button>
            {/* The Stop slot is always laid out, so the row does not reflow
              when a turn starts; the button only shows while one runs. */}
            <button
              type="button"
              onClick={onStop}
              disabled={interrupting || !streaming}
              aria-hidden={!streaming}
              tabIndex={streaming ? 0 : -1}
              title="Stop the running turn (Ctrl+C in the field); queued messages run next"
              data-testid="harness-stop"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-status-blocked/50 px-2 py-0.5 text-[11px] text-status-blocked hover:bg-status-blocked/10 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3",
                !streaming && "invisible"
              )}
            >
              <Square className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              {interrupting ? "Stopping…" : "Stop"}
            </button>
          </div>
          <UsageDialog
            open={usageOpen}
            onOpenChange={setUsageOpen}
            providerId={engine?.id}
            contextUsage={contextUsage}
            loginRequired={loginRequired}
            loginPending={loginStarting}
            onLogin={onOpenConsole ? startLogin : undefined}
          />
          <ModelPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            model={config.model}
            effort={config.effort}
            running={config.running}
            saving={setConfig.isPending}
            error={configError}
            fixedReason={fixedReason}
            launchModel={launchModel}
            engineLabel={engine?.label}
            onApply={applyConfig}
          />
        </motion.div>
      </>
    );

  return { chrome, composer };
}
