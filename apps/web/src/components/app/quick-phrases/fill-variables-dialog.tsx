import { ArgInput } from "@/components/app/arg-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QuickPhrase } from "@/hooks/use-quick-phrases";

import { InjectSplitButton } from "./inject-split-button";

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
  requiredMissing,
}: {
  filling: FillingPhrase;
  onClose: () => void;
  onFillChange: (value: FillingPhrase) => void;
  onInject: (submit: boolean) => void;
  isPending: boolean;
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {filling.phrase.label || "Fill Variables"}
            </DialogTitle>
            <DialogDescription>
              Fill in the variables below, then inject the phrase.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!requiredMissing && !isPending) onInject(true);
            }}
          >
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
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <InjectSplitButton
                disabled={requiredMissing || isPending}
                isPending={isPending}
                onInject={onInject}
              />
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
