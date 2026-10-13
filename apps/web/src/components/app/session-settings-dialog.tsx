import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjects } from "@/hooks/use-projects";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentCardPhaseStatus } from "@/components/app/agent-card-status";
import { AgentActivityLabel } from "@/components/app/agent-activity";
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
import { type IdeType } from "@/lib/ide-types";

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
 * (branch/worktree, IDE links, sandbox state, live turn activity). Reuses the
 * exact same components (AgentCardDetails, AgentActivityLabel,
 * AgentCardPhaseStatus) a parent card renders, rather than a second
 * implementation of the same information.
 */
export function SessionSettingsDialog({
  agent,
  open,
  onOpenChange,
  enabledIdes,
}: SessionSettingsDialogProps) {
  const { data: projects = [] } = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
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

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
      setProjectId(agent.projectId ?? null);
    }
  }, [open, agent]);

  const isDirty =
    agent != null &&
    name.trim() !== "" &&
    (name !== agent.name || projectId !== (agent.projectId ?? null));

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
      if (projectId !== (agent.projectId ?? null))
        await api(`/api/v1/agents/${agent.id}/project`, {
          method: "PATCH",
          body: JSON.stringify({ projectId }),
        });
      queryClient.setQueryData<Agent[]>(["agents"], (old) =>
        old?.map((a) =>
          a.id === agent.id ? { ...a, name: result.agent.name, projectId } : a
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
  }, [agent, isDirty, name, projectId, queryClient, onOpenChange]);

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
                <AgentActivityLabel agent={agent} className="text-xs" />
                <AgentCardDetails
                  agent={agent}
                  diffStats={diffStats}
                  refreshDiffStats={refreshDiffStats}
                  fullAccessEnabled={isFullAccessEnabled(agent)}
                  enabledIdes={enabledIdes}
                  worktreePathCopied={worktreePathCopied}
                  copyWorktreePath={copyWorktreePath}
                />
              </div>
            ) : null}
            <label className="space-y-1 text-sm">
              Project
              <Select
                value={projectId ?? "none"}
                onValueChange={(v) => setProjectId(v === "none" ? null : v)}
              >
                <SelectTrigger aria-label="Project membership">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
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
