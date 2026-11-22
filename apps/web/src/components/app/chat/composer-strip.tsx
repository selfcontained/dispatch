import { useId, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { RowButton } from "@/components/ui/row-button";

import { STRIP_META_CLASS } from "./composer-strip-styles";

export function ComposerStrip({
  title,
  icon: Icon,
  summary,
  preview,
  open,
  onOpenChange,
  testId,
  children,
  footer,
  toggleRef,
}: {
  title: string;
  icon: LucideIcon;
  summary: ReactNode;
  preview?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  children: ReactNode;
  footer?: ReactNode;
  toggleRef?: Ref<HTMLButtonElement>;
}) {
  const contentId = useId();
  return (
    <Card className="mb-1.5 min-w-0 px-2 py-1" data-testid={testId}>
      <RowButton
        ref={toggleRef}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className="min-w-0 px-1 py-1"
        data-testid={`${testId}-toggle`}
      >
        <Icon
          className="h-3 w-3 shrink-0 text-status-working"
          aria-hidden="true"
        />
        <span className="shrink-0 text-body-sm font-medium text-foreground">
          {title}
        </span>
        <span className={`${STRIP_META_CLASS} min-w-0`} aria-live="polite">
          {summary}
        </span>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate text-body-sm text-foreground/soft">
            · {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span aria-hidden="true" className="shrink-0 text-faint">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
      </RowButton>
      <div id={contentId} hidden={!open}>
        {open ? children : null}
      </div>
      {footer}
    </Card>
  );
}
