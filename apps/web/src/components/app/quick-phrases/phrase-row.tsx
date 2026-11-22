import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { QuickPhrase } from "@/hooks/use-quick-phrases";

import { InjectSplitButton } from "./inject-split-button";

export function PhraseRow({
  phrase,
  canInject,
  isPending,
  onInject,
  onFill,
  onEdit,
  onDelete,
}: {
  phrase: QuickPhrase;
  canInject: boolean;
  isPending: boolean;
  onInject: (submit: boolean) => void;
  onFill: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hasArgs = phrase.args.length > 0;

  return (
    <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-body-md text-foreground">
        {phrase.label || phrase.text}
      </span>
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
      >
        {canInject ? (
          hasArgs ? (
            <Button
              type="button"
              size="xs"
              disabled={isPending}
              className="min-w-[5.5rem]"
              onClick={onFill}
            >
              Send…
            </Button>
          ) : (
            <InjectSplitButton
              disabled={isPending}
              onInject={onInject}
              size="sm"
              insidePopover
            />
          )
        ) : null}
        <IconButton size="icon-sm" label="Edit phrase" onClick={onEdit}>
          <Pencil />
        </IconButton>
        <IconButton size="icon-sm" label="Delete phrase" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}
