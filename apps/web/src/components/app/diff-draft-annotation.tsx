import { useCallback, useState } from "react";
import {
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import type { PersistedDraftComment } from "@/lib/store";
import { stickyAnnotationStyle } from "@/components/app/diff-annotation-style";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function InlineDraftAnnotation({
  draft,
  onRemove,
  onUpdate,
}: {
  draft: PersistedDraftComment;
  onRemove?: (id: string) => void;
  onUpdate?: (id: string, comment: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(draft.comment);

  const handleSave = useCallback(() => {
    if (editValue.trim() && onUpdate) {
      onUpdate(draft.id, editValue.trim());
    }
    setEditing(false);
  }, [draft.id, editValue, onUpdate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditValue(draft.comment);
        setEditing(false);
      }
    },
    [handleSave, draft.comment]
  );

  const lineLabel =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;

  if (editing) {
    return (
      <div
        className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
        style={stickyAnnotationStyle}
      >
        <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
          <MessageSquarePlus className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">Edit draft</span>
        </div>
        <div className="p-3">
          <textarea
            className="w-full resize-none rounded border border-border bg-muted/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={3}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleSave}
              disabled={!editValue.trim()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
      style={stickyAnnotationStyle}
    >
      <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
        <MessageSquarePlus className="h-3 w-3 text-primary" />
        <span className="font-medium text-foreground">Draft</span>
        <span className="rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          Pending
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center rounded min-h-8 min-w-8 p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            <DropdownMenuItem
              className="text-foreground"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(true);
              }}
            >
              <Pencil className="mr-2 h-3 w-3" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRemove?.(draft.id)}>
              <Trash2 className="mr-2 h-3 w-3" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs text-foreground/80">
          {draft.comment}
        </p>
      </div>
    </div>
  );
}
