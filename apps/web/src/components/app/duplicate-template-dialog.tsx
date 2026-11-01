import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTemplateActions, type Template } from "@/hooks/use-templates";

export function DuplicateTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { duplicateTemplate } = useTemplateActions();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const changeOpen = (next: boolean) => {
    if (submitting.current) return;
    setName("");
    setError(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Duplicate template</DialogTitle>
          <DialogDescription>
            Copy the saved configuration of &ldquo;{template.name}&rdquo;.
            Unsaved edits are not included.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim() || submitting.current) return;
            submitting.current = true;
            setError(null);
            try {
              const copy = await duplicateTemplate.mutateAsync({
                id: template.id,
                name: name.trim(),
              });
              onOpenChange(false);
              setName("");
              navigate(`/automations/templates/${copy.id}`);
              toast.success(`Template "${copy.name}" created.`);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              submitting.current = false;
            }
          }}
        >
          <div className="grid gap-2">
            <label
              className="text-sm font-medium"
              htmlFor="duplicate-template-name"
            >
              New template name
            </label>
            <Input
              id="duplicate-template-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={duplicateTemplate.isPending}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-status-blocked">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={duplicateTemplate.isPending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || duplicateTemplate.isPending}
            >
              {duplicateTemplate.isPending ? "Creating…" : "Create template"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
