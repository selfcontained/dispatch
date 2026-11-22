import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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
import { useTemplateActions, type Template } from "@/hooks/use-templates";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

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
  const [error, setError] = useState<unknown>();
  const submitting = useRef(false);
  const changeOpen = (next: boolean) => {
    if (submitting.current) return;
    setName("");
    setError(undefined);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent size="sm" busy={duplicateTemplate.isPending}>
        <DialogHeader>
          <DialogTitle>Duplicate template</DialogTitle>
          <DialogDescription>
            Copy the saved configuration of &ldquo;{template.name}&rdquo;.
            Unsaved edits are not included.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim() || submitting.current) return;
            submitting.current = true;
            setError(undefined);
            try {
              const copy = await duplicateTemplate.mutateAsync({
                id: template.id,
                name: name.trim(),
              });
              onOpenChange(false);
              setName("");
              navigate(`/automations/templates/${copy.id}`);
            } catch (err) {
              setError(err);
            } finally {
              submitting.current = false;
            }
          }}
        >
          <DialogBody>
            <Field label="New template name" id="duplicate-template-name">
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={duplicateTemplate.isPending}
              />
            </Field>
          </DialogBody>
          {error ? (
            <Alert title="Couldn’t duplicate the template." error={error} />
          ) : null}
          <DialogFooter>
            <DialogCancel />
            <Button
              type="submit"
              variant="primary"
              pending={duplicateTemplate.isPending}
              disabled={!name.trim()}
            >
              Create template
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
