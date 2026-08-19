import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentCardPhaseStatus } from "@/components/app/agent-card-status";
import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { isFullAccessEnabled } from "@/components/app/agents-view-utils";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAgentDiffStats } from "@/hooks/use-agent-diff-stats";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

const MAX_NAME_LENGTH = 120;

type SessionSettingsDialogProps = {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabledIdes: IdeType[];
};

/**
 * "Session details": the rename form this dialog has always offered, plus —
 * for a sub agent, which otherwise has no way to see this — the same
 * read-only info a parent agent's own expanded card shows in the sidebar
 * (branch/worktree, IDE links, sandbox state, latest event). Reuses the
 * exact same components (AgentCardDetails, AgentCardLatestEvent,
 * AgentCardPhaseStatus) a parent card renders, rather than a second
 * implementation of the same information.
 */
export function SessionSettingsDialog({
  agent,
  open,
  onOpenChange,
  enabledIdes,
}: SessionSettingsDialogProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // These hooks power AgentCardDetails exactly the way a parent card's own
  // instance is powered (agent-card.tsx) — they're generic enough (a bare
  // agent id + an "enabled" bool, or no agent dependency at all) to stand up
  // fresh here rather than threading yet more props down from the card.
  const { diffStats, refresh: refreshDiffStats } = useAgentDiffStats(
    agent?.id ?? "",
    open && agent != null
  );
  const [worktreePathCopied, copyWorktreePath] = useCopyText();

  // Mirrors ChildAgentRow's own derivation (same shared helper): the latest
  // event's own label/color describes the EVENT, not the agent's current
  // status, so a stopped or errored agent needs this rather than
  // AgentCardLatestEvent's summary alone — that only reflects the event
  // type, and would show a stale "Working" in the active-work color for an
  // agent that has since stopped.
  const isStopped = agent
    ? agent.status !== "running" && agent.status !== "creating"
    : false;
  const { label: statusLabel, colorClass: statusColor } = agent
    ? describeAgentStatus(agent, isStopped)
    : { label: "", colorClass: "" };

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
    }
  }, [open, agent]);

  const isDirty = agent != null && name.trim() !== "" && name !== agent.name;

  const handleSave = useCallback(async () => {
    if (!agent || !isDirty) return;
    setSaving(true);
    try {
      const result = await api<{ agent: Agent }>(
        `/api/v1/agents/${agent.id}/name`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim() }),
        }
      );
      queryClient.setQueryData<Agent[]>(["agents"], (old) =>
        old?.map((a) =>
          a.id === agent.id ? { ...a, name: result.agent.name } : a
        )
      );
      onOpenChange(false);
    } catch (err) {
      toast.error("Failed to rename session.", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }, [agent, isDirty, name, queryClient, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(460px,calc(100vw-2rem))]"
        onOpenAutoFocus={(e) => {
          // Radix's default autofocus lands on the first non-link tabbable
          // in the dialog — for a worktree agent, that's now the "Copy
          // worktree path" button (AgentCardDetails renders ahead of the
          // name field), not the Input's own `autoFocus`. That both drops
          // focus from the rename field this dialog exists to let you use
          // quickly, and immediately opens that button's tooltip on top of
          // the branch info. Force focus onto the name field explicitly.
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>Session details</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
            {agent ? (
              <div className="space-y-1.5">
                <AgentCardPhaseStatus agent={agent} />
                <div className="flex min-w-0 items-center gap-1 text-xs">
                  <span className={cn("font-medium", statusColor)}>
                    {statusLabel}
                  </span>
                  {agent.latestEvent?.updatedAt ? (
                    <>
                      <span className="text-muted-foreground/50">•</span>
                      <span className="text-muted-foreground/70">
                        {formatRelativeTime(agent.latestEvent.updatedAt)}
                      </span>
                    </>
                  ) : null}
                </div>
                {agent.latestEvent?.message ? (
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    {agent.latestEvent.message}
                  </div>
                ) : null}
                <AgentCardDetails
                  agent={agent}
                  diffStats={diffStats}
                  refreshDiffStats={refreshDiffStats}
                  fullAccessEnabled={isFullAccessEnabled(agent)}
                  isTerminalAgent={agent.type === "terminal"}
                  enabledIdes={enabledIdes}
                  worktreePathCopied={worktreePathCopied}
                  copyWorktreePath={copyWorktreePath}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="session-name"
                className="text-sm font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                ref={inputRef}
                id="session-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
              />
              <span className="text-xs text-muted-foreground/60">
                {name.length}/{MAX_NAME_LENGTH} characters
              </span>
            </div>
          </div>
          <div className="mt-4 flex shrink-0 justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!isDirty || saving}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
