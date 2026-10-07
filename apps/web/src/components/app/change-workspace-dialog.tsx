import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderInput } from "lucide-react";
import { useState } from "react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";

/**
 * Point an agent's workspace at the directory it works in now — a worktree it
 * made itself, another repo — so the diff, branch and repo tools follow it.
 * The agent can do the same with its set_workspace tool.
 */
export function ChangeWorkspaceButton({
  agent,
}: {
  agent: Agent;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
      setOpen(false);
    },
  });

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false);
      return;
    }
    setPath(agent.workspacePath ?? agent.cwd);
    setBaseBranch(
      (agent.workspacePath ? agent.workspaceBaseBranch : agent.baseBranch) ?? ""
    );
    mutation.reset();
    setOpen(true);
  };

  const errorMessage =
    mutation.error instanceof Error ? mutation.error.message : null;

  return (
    // The trigger lives inside the Dialog root so closing (Escape, Cancel,
    // Save) returns focus to it.
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <DialogTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Change workspace"
              data-testid={`change-workspace-${agent.id}`}
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            >
              <FolderInput className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
        </DialogTrigger>
        <TooltipContent>Change workspace</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change workspace</DialogTitle>
          <DialogDescription>
            Where this agent works now. The diff, branch and repo tools follow
            it; the agent keeps running where it launched.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              path: path.trim() || null,
              baseBranch: baseBranch.trim() || null,
            });
          }}
        >
          {/* Scrolls on short screens so a long error can't push the
                actions out of reach. */}
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Directory</span>
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/absolute/path/to/checkout"
                className="font-mono text-xs"
                data-testid="change-workspace-path"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">
                Base branch{" "}
                <span className="text-xs">(optional, for the diff)</span>
              </span>
              <Input
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                placeholder="Repo default"
                className="font-mono text-xs"
                data-testid="change-workspace-base"
              />
            </label>
            {moved ? (
              <p className="text-xs text-muted-foreground">
                Launched in <code className="break-all">{agent.cwd}</code>
              </p>
            ) : null}
            {errorMessage ? (
              <p className="break-all text-sm text-destructive" role="alert">
                {errorMessage}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 pt-1">
            {moved ? (
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
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || !path.trim()}
              data-testid="change-workspace-save"
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
