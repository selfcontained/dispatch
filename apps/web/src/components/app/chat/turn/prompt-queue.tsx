import { useId, useState } from "react";
import type { HarnessQueuedPrompt } from "@dispatch/shared";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QueuedPrompt } from "./queued-prompt";

/** Background replies must never grow the fixed composer chrome unbounded. */
export function PromptQueue({
  queued,
  busyId,
  onSendNow,
  onRemove,
}: {
  queued: HarnessQueuedPrompt[];
  busyId: string | null;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  if (queued.length === 0) return null;
  const compact = queued.length > 2;
  const visible = !compact || expanded;
  const userCount = queued.filter((prompt) => prompt.source === "chat").length;
  const Icon = visible ? ChevronDown : ChevronRight;

  return (
    <div className="mb-2 min-w-0" data-testid="harness-prompt-queue">
      {compact ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-1.5 px-1 text-xs pointer-coarse:h-11"
          aria-expanded={visible}
          aria-controls={regionId}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{queued.length} queued messages</span>
          {userCount > 0 ? (
            <span className="truncate text-muted-foreground">
              · {userCount} from you
            </span>
          ) : null}
        </Button>
      ) : null}
      <div
        id={regionId}
        role="region"
        aria-label="Queued messages"
        hidden={!visible}
        tabIndex={visible ? 0 : undefined}
        className="max-h-[min(12rem,25dvh)] space-y-2 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible
          ? queued.map((prompt) => (
              <QueuedPrompt
                key={prompt.id}
                prompt={prompt}
                busy={busyId !== null}
                onSendNow={onSendNow}
                onRemove={onRemove}
              />
            ))
          : null}
      </div>
    </div>
  );
}
