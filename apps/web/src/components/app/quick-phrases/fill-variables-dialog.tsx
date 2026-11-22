import { ArgInput } from "@/components/app/arg-input";
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
import type { QuickPhrase } from "@/hooks/use-quick-phrases";

import { InjectSplitButton } from "./inject-split-button";
import { Alert } from "@/components/ui/alert";

export type FillingPhrase = {
  phrase: QuickPhrase;
  argValues: Record<string, string>;
} | null;

export function FillVariablesDialog({
  filling,
  onClose,
  onFillChange,
  onInject,
  isPending,
  error,
  requiredMissing,
}: {
  filling: FillingPhrase;
  onClose: () => void;
  onFillChange: (value: FillingPhrase) => void;
  onInject: (submit: boolean) => void;
  isPending: boolean;
  error: unknown;
  requiredMissing: boolean;
}) {
  return (
    <Dialog
      open={filling !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      {filling !== null ? (
        <DialogContent size="sm" busy={isPending}>
          <DialogHeader>
            <DialogTitle>
              {filling.phrase.label || "Fill variables"}
            </DialogTitle>
            <DialogDescription>
              Fill in the variables below, then inject the phrase.
            </DialogDescription>
          </DialogHeader>
          <DialogForm
            onSubmit={(e) => {
              e.preventDefault();
              if (!requiredMissing && !isPending) onInject(true);
            }}
          >
            <DialogBody className="flex flex-col gap-3">
              {filling.phrase.args.map((arg) => (
                <ArgInput
                  key={arg.key}
                  arg={arg}
                  value={filling.argValues[arg.key] ?? ""}
                  onChange={(value) =>
                    onFillChange({
                      ...filling,
                      argValues: { ...filling.argValues, [arg.key]: value },
                    })
                  }
                />
              ))}
            </DialogBody>
            {error ? (
              <Alert title="Couldn’t send the phrase." error={error} />
            ) : null}
            <DialogFooter>
              <DialogCancel />
              <InjectSplitButton
                disabled={requiredMissing || isPending}
                onInject={onInject}
              />
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
