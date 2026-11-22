import { useCallback } from "react";
import {
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import { useDiffEditorState } from "@/components/app/diff-editor-state";
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
  const [editing, setEditing] = useDiffEditorState<boolean>(
    `draft:${draft.id}:editing`,
    false
  );
  const [editValue, setEditValue] = useDiffEditorState(
    `draft:${draft.id}:text`,
    draft.comment
  );

  const handleSave = useCallback(() => {
    if (editValue.trim() && onUpdate) {
      onUpdate(draft.id, editValue.trim());
    }
    setEditing(false);
  }, [draft.id, editValue, onUpdate, setEditing]);

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
    [handleSave, draft.comment, setEditValue, setEditing]
  );

  const lineLabel =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;

  if (editing) {
    return (
      <div
        className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/line bg-background shadow-sm sticky left-0"
        style={stickyAnnotationStyle}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-selected px-3 py-2 text-label-sm">
          <MessageSquarePlus className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">Edit draft</span>
        </div>
        <div className="p-3">
          <textarea
            className="w-full resize-none rounded-sm border border-border bg-surface-subtle px-3 py-2 text-body-sm text-foreground placeholder:text-muted-foreground focus-ring"
            rows={3}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-sm px-3 py-1.5 text-body-sm text-muted-foreground hover:bg-surface-hover"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-sm bg-primary px-3 py-1.5 text-body-sm font-medium text-primary-foreground hover:bg-primary/dense disabled-state"
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
      className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/line bg-background shadow-sm sticky left-0"
      style={stickyAnnotationStyle}
    >
      <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-selected px-3 py-2 text-label-sm">
        <MessageSquarePlus className="h-3 w-3 text-primary" />
        <span className="font-medium text-foreground">Draft</span>
        <span className="rounded-full bg-warning/tint px-1.5 py-0 text-label-xs font-medium text-warning-ink">
          Pending
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center rounded-sm min-h-8 min-w-8 p-0.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
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
        <p className="whitespace-pre-wrap break-words text-body-sm text-foreground/soft">
          {draft.comment}
        </p>
      </div>
    </div>
  );
}
