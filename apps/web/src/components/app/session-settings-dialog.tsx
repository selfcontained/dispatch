import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const MAX_NAME_LENGTH = 120;

type SessionSettingsDialogProps = {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SessionSettingsDialog({
  agent,
  open,
  onOpenChange,
}: SessionSettingsDialogProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

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
      <DialogContent className="w-[min(400px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Session settings</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
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
              autoFocus
            />
            <span className="text-xs text-muted-foreground/60">
              {name.length}/{MAX_NAME_LENGTH} characters
            </span>
          </div>
          <div className="mt-4 flex justify-end gap-2">
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
