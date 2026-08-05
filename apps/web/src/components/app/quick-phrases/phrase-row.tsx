import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
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
              size="sm"
              disabled={isPending}
              className="h-7 min-w-[5.5rem] px-2 text-xs"
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
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
          onClick={onEdit}
          title="Edit phrase"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
          onClick={() => {
            const name = phrase.label || phrase.text.slice(0, 40);
            if (window.confirm(`Delete "${name}"?`)) onDelete();
          }}
          title="Delete phrase"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
