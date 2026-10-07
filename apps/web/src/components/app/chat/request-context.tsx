import { useEffect, useId, useMemo, useState } from "react";
import type { StreamEntry } from "@dispatch/shared";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutoHeight } from "./turn/auto-height";
import { glassOverlay } from "@/lib/glass";
import { Markdown } from "@/components/ui/markdown";
import { AttachmentList } from "./chat-attachment-views";
import type { FeedContext } from "./chat-entries";
import { cn } from "@/lib/utils";

/** Keeps the reader’s requests available across agent and child-agent activity. */
export function RequestContext({
  entries,
  attachmentContext,
  onJump,
  hasOlder,
  loading,
  error,
  loadOlder,
}: {
  entries: StreamEntry[];
  attachmentContext: Pick<FeedContext, "agentId" | "agentName" | "onOpenFile">;
  onJump: (id: string) => void;
  hasOlder: boolean;
  loading: boolean;
  error: Error | null;
  loadOlder: () => void;
}): JSX.Element | null {
  const requests = useMemo(
    () =>
      entries
        .map((entry) => entry.block)
        .filter(
          (block) =>
            block.author.kind === "user" &&
            !block.threadId &&
            (block.kind === "text" ||
              // Launch cards are user-authored even when an agent launched
              // the child; only a person's own launches are their requests.
              (block.kind === "launch" && !block.launchedByAgentId)) &&
            (block.text.trim() || block.attachments.length > 0)
        ),
    [entries]
  );
  const detailId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [seekingLatest, setSeekingLatest] = useState(false);
  const [seekingBefore, setSeekingBefore] = useState<string | null>(null);
  const found = requests.findIndex((block) => block.id === selectedId);
  const index = found < 0 ? requests.length - 1 : found;
  const request = requests[index];
  // Follow the latest user message until the reader explicitly browses backward.
  // Fetch through agent-only pages without making them scroll the conversation.
  useEffect(() => {
    if (loading || error) return;
    if (seekingBefore) {
      const boundary = requests.findIndex(
        (block) => block.id === seekingBefore
      );
      if (boundary > 0) {
        setSelectedId(requests[boundary - 1]!.id);
        setSeekingBefore(null);
        return;
      }
      if (!hasOlder) {
        setSeekingBefore(null);
        return;
      }
      loadOlder();
    } else if (seekingLatest) {
      if (requests.length || !hasOlder) setSeekingLatest(false);
      else loadOlder();
    }
  }, [
    requests,
    seekingBefore,
    seekingLatest,
    hasOlder,
    loading,
    error,
    loadOlder,
  ]);

  if (!request) {
    if (!hasOlder) return null;
    return (
      <div className="pointer-events-auto w-fit bg-background px-3 py-1 sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || (seekingLatest && !error)}
          onClick={() => {
            setSeekingLatest(true);
            if (error) loadOlder();
          }}
        >
          {seekingLatest && !error ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Finding your last message…
            </>
          ) : error ? (
            "Retry finding your last message"
          ) : (
            "Find your last message"
          )}
        </Button>
      </div>
    );
  }
  const requestText = request.text.trim() || "Attached files";
  const busy = seekingBefore !== null && !error;
  function previous() {
    if (index > 0) setSelectedId(requests[index - 1]!.id);
    else {
      setSelectedId(request!.id);
      setSeekingBefore(request!.id);
      if (error) loadOlder();
    }
  }
  return (
    <AutoHeight
      data-testid="request-context"
      className={cn(
        glassOverlay,
        "pointer-events-auto shrink-0 rounded-b-lg border-t-0 bg-popover/35 backdrop-blur-md",
        open &&
          "shadow-[0_12px_20px_-4px_rgba(0,0,0,0.75),0_28px_56px_-8px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.15)]"
      )}
    >
      <div
        className="px-3 py-1 sm:px-4"
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <div
          className={cn(
            "flex items-center gap-1",
            open && "-mx-3 border-b border-white/5 px-3 sm:-mx-4 sm:px-4"
          )}
        >
          <button
            type="button"
            data-testid="request-context-open"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen(!open)}
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-[11px] font-medium text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9"
          >
            <span>
              {index === requests.length - 1
                ? "Your last message"
                : "Earlier message"}
            </span>
            <ChevronDown
              className={cn(
                "h-3 w-3 text-muted-foreground transition-transform motion-reduce:transition-none",
                open && "rotate-180"
              )}
            />
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 pointer-coarse:h-9 pointer-coarse:w-9"
            aria-label="Previous message"
            disabled={busy || (index === 0 && !hasOlder)}
            onClick={previous}
          >
            {busy ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-label="Loading earlier messages"
              />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 pointer-coarse:h-9 pointer-coarse:w-9"
            aria-label="Next message"
            disabled={busy || index === requests.length - 1}
            onClick={() =>
              setSelectedId(
                index + 1 === requests.length - 1
                  ? null
                  : requests[index + 1]!.id
              )
            }
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div
          key={request.id}
          id={detailId}
          data-testid="request-context-text"
          style={
            open
              ? {
                  maskImage:
                    "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
                }
              : undefined
          }
          className={cn(
            "min-w-0 transform-gpu pb-1 text-xs leading-5 text-muted-foreground",
            open
              ? "max-h-[min(40vh,20rem)] overflow-y-auto overscroll-contain break-words"
              : "truncate"
          )}
        >
          {open ? (
            <div className="py-3">
              {request.text.trim() && (
                <Markdown className="text-xs prose-p:whitespace-pre-line prose-li:whitespace-pre-line">
                  {request.text}
                </Markdown>
              )}
              <AttachmentList block={request} ctx={attachmentContext} />
            </div>
          ) : (
            requestText.replace(/\s+/g, " ")
          )}
        </div>
        {open && (
          <div
            data-testid="request-context-detail"
            className="-mx-3 border-t border-white/5 px-3 pb-1 pt-1 sm:-mx-4 sm:px-4"
          >
            <div className="mt-1 flex items-center justify-between gap-3">
              <time className="text-[11px] text-muted-foreground">
                {new Date(request.createdAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 rounded-sm px-0 text-[11px] font-normal hover:bg-transparent hover:underline pointer-coarse:h-8"
                onClick={() => onJump(request.id)}
              >
                <ArrowUp className="mr-1 h-3 w-3" />
                Jump to message
              </Button>
            </div>
          </div>
        )}
        {error && seekingBefore && (
          <p role="status" className="pb-2 text-xs text-muted-foreground">
            Couldn’t load earlier messages. Try again.
          </p>
        )}
      </div>
    </AutoHeight>
  );
}
