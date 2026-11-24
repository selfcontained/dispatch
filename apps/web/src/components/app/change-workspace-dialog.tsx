import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

/**
 * Point an agent's workspace at the directory it works in now — a worktree it
 * made itself, another repo — so the diff, branch and repo tools follow it.
 * The agent can do the same with its set_workspace tool.
 */
export function ChangeWorkspaceDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const moved = Boolean(agent.workspacePath);

  const mutation = useMutation({
    mutationFn: (input: { path: string | null; baseBranch: string | null }) =>
      api<{ agent: Agent }>(`/api/v1/agents/${agent.id}/workspace`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<Agent[]>(
        ["agents"],
        (old) =>
          old?.map((item) =>
            item.id === result.agent.id ? result.agent : item
          ) ?? [result.agent]
      );
      for (const key of [
        "agent-diff-content",
        "agent-diff-file",
        "agent-diff",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key, agent.id] });
      }
      onOpenChange(false);
    },
  });

  // Each opening starts from where the agent works now.
  const [seeded, setSeeded] = useState(false);
  if (open && !seeded) {
    setSeeded(true);
    setPath(agent.workspacePath ?? agent.worktreePath ?? agent.cwd);
    setBaseBranch(
      (agent.workspacePath ? agent.workspaceBaseBranch : agent.baseBranch) ?? ""
    );
    mutation.reset();
  } else if (!open && seeded) {
    setSeeded(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent busy={mutation.isPending}>
        <DialogHeader>
          <DialogTitle>Change workspace</DialogTitle>
          <DialogDescription>
            Where this agent works now. The diff, branch and repo tools follow
            it; the agent keeps running where it launched.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              path: path.trim() || null,
              baseBranch: baseBranch.trim() || null,
            });
          }}
        >
          <DialogBody className="flex flex-col gap-3">
            <Field label="Directory">
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/absolute/path/to/checkout"
                className="font-mono text-body-sm"
                data-testid="change-workspace-path"
                autoFocus
              />
            </Field>
            <Field label="Base branch" optional hint="For the diff.">
              <Input
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                placeholder="Repo default"
                className="font-mono text-body-sm"
                data-testid="change-workspace-base"
              />
            </Field>
            {moved ? (
              <p className="text-body-sm text-muted-foreground">
                Launched in <code className="break-all">{agent.cwd}</code>
              </p>
            ) : null}
          </DialogBody>
          {mutation.error ? (
            <Alert
              title="Couldn’t change the workspace."
              error={mutation.error}
            />
          ) : null}
          <DialogFooter
            start={
              moved ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ path: null, baseBranch: null })
                  }
                  data-testid="change-workspace-reset"
                >
                  Back to launch directory
                </Button>
              ) : null
            }
          >
            <DialogCancel />
            <Button
              type="submit"
              variant="primary"
              pending={mutation.isPending}
              disabled={!path.trim()}
              data-testid="change-workspace-save"
            >
              Save workspace
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
