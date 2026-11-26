import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjects } from "@/hooks/use-projects";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentCardPhaseStatus } from "@/components/app/agent-card-status";
import { AgentActivityLabel } from "@/components/app/agent-activity";
import { isFullAccessEnabled } from "@/components/app/agents-view-utils";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAgentDiffStats } from "@/hooks/use-agent-diff-stats";
import { api } from "@/lib/api";
import { descendantAgents } from "@/lib/agent-lineage";
import { fetchAgents } from "@/hooks/use-agent-tree";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

const MAX_NAME_LENGTH = 120;

type SessionSettingsDialogProps = {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Also show the agent's details (branch, links, activity). A sub agent's
   * card never expands, so this is where its details live; an expanded card
   * already shows them and asks for just the form.
   */
  showDetails?: boolean;
};

/**
 * Rename an agent and move it between projects; for a sub agent, also its
 * details, using the same components an expanded card renders.
 */
export function SessionSettingsDialog({
  agent,
  open,
  onOpenChange,
  showDetails = false,
}: SessionSettingsDialogProps) {
  const { data: projects = [] } = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // These hooks power AgentCardDetails exactly the way a parent card's own
  // instance is powered (agent-card.tsx) — they're generic enough (a bare
  // agent id + an "enabled" bool, or no agent dependency at all) to stand up
  // fresh here rather than threading yet more props down from the card.
  const { diffStats, refresh: refreshDiffStats } = useAgentDiffStats(
    agent?.id ?? "",
    open && agent != null && showDetails
  );

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
      setFailure(undefined);
      setProjectId(agent.projectId ?? null);
    }
  }, [open, agent]);

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    enabled: open,
  });
  // A child follows its live parent; an orphan can be moved on its own.
  const followsParent =
    agent?.parentAgentId != null &&
    agents.some((a) => a.id === agent.parentAgentId);
  // Saving the parent's project also moves children left in another one.
  const strandsChildren =
    agent != null &&
    !followsParent &&
    descendantAgents(agent.id, agents).some(
      (child) => (child.projectId ?? null) !== (agent.projectId ?? null)
    );
  const projectChanged =
    agent != null &&
    !followsParent &&
    (projectId !== (agent.projectId ?? null) || strandsChildren);

  const isDirty =
    agent != null &&
    name.trim() !== "" &&
    (name !== agent.name || projectChanged);

  const handleSave = useCallback(async () => {
    if (!agent || !isDirty) return;
    setSaving(true);
    setFailure(undefined);
    try {
      const result = await api<{ agent: Agent }>(
        `/api/v1/agents/${agent.id}/name`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim() }),
        }
      );
      if (projectChanged)
        await api(`/api/v1/agents/${agent.id}/project`, {
          method: "PATCH",
          body: JSON.stringify({ projectId }),
        });
      queryClient.setQueryData<Agent[]>(["agents"], (old) => {
        if (!old) return old;
        // The server moves the agent's children with it.
        const moved = new Set(
          projectChanged
            ? descendantAgents(agent.id, old).map((child) => child.id)
            : []
        );
        return old.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                name: result.agent.name,
                ...(projectChanged && { projectId }),
              }
            : moved.has(a.id)
              ? { ...a, projectId }
              : a
        );
      });
      onOpenChange(false);
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  }, [
    agent,
    isDirty,
    name,
    projectChanged,
    projectId,
    queryClient,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        busy={saving}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // Land on the name field, selected, ready to retype.
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {showDetails ? "Session details" : "Rename / project"}
          </DialogTitle>
        </DialogHeader>
        <DialogForm
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <DialogBody className="flex flex-col gap-3">
            {agent && showDetails ? (
              <div className="space-y-1.5">
                <AgentCardPhaseStatus agent={agent} />
                <AgentActivityLabel agent={agent} className="text-body-sm" />
                <AgentCardDetails
                  agent={agent}
                  diffStats={diffStats}
                  refreshDiffStats={refreshDiffStats}
                  fullAccessEnabled={isFullAccessEnabled(agent)}
                />
              </div>
            ) : null}
            {followsParent ? null : (
              <Field label="Project">
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
              </Field>
            )}
            <Field
              id="session-name"
              label="Name"
              hint={`${name.length}/${MAX_NAME_LENGTH} characters`}
              error={name.trim() ? null : "Enter a name."}
            >
              <Input
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
              />
            </Field>
          </DialogBody>
          {failure ? (
            <Alert title="Couldn’t save the session." error={failure} />
          ) : null}
          <DialogFooter>
            <DialogCancel />
            <Button
              type="submit"
              variant="primary"
              pending={saving}
              disabled={!isDirty}
            >
              Save changes
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
