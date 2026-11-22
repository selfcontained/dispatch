import { useState, type RefObject } from "react";

import { Alert } from "@/components/ui/alert";
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
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** Names a column, new or existing. Mounted on open, so a draft stays local. */
export function TaskColumnNameDialog({
  name: saved,
  onSave,
  onClose,
  returnFocus,
}: {
  /** Absent for a new column. */
  name?: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [name, setName] = useState(saved ?? "");
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const creating = saved === undefined;
  const save = async () => {
    const next = name.trim();
    setInvalid(!next);
    if (!next || pending) return;
    if (next === saved) return onClose();
    setPending(true);
    setFailure(undefined);
    try {
      await onSave(next);
      onClose();
    } catch (error) {
      setFailure(error);
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="sm"
        busy={pending}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.current?.isConnected) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{creating ? "New column" : "Edit column"}</DialogTitle>
        </DialogHeader>
        <DialogForm
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogBody>
            <Field
              label="Column name"
              error={invalid ? "Enter a column name." : null}
            >
              <Input
                autoFocus
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setInvalid(false);
                }}
              />
            </Field>
          </DialogBody>
          {failure ? (
            <Alert
              title={
                creating
                  ? "Couldn’t create the column."
                  : "Couldn’t rename the column."
              }
              error={failure}
            />
          ) : null}
          <DialogFooter>
            <DialogCancel />
            <Button type="submit" variant="primary" pending={pending}>
              {creating ? "Create column" : "Save name"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
